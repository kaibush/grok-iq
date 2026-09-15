import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  Compass,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  TimerReset,
  UserRound,
  UsersRound,
  Webhook,
} from 'lucide-react'
import { IconGithub } from '@/assets/brand-icons'
import { useAuthStore } from '@/stores/auth-store'
import {
  ApiError,
  api,
  type LinuxDoPublicUser,
  type PublicUpstreamAccountSummary,
  type PublicUpstreamProvider,
  type PublicUpstreamUsagePeriod,
  type PublicVisitPeriod,
  type StatusAccountPublicUser,
} from '@/lib/api'
import { formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { usePersistedViewState } from '@/hooks/use-persisted-view-state'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ProgressBar } from '@/components/ui/progress'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { PasswordInput } from '@/components/password-input'
import { StatCard } from '@/components/stat-card'
import { ThemeSwitch } from '@/components/theme-switch'
import { ClientKeyQuotaDialog } from '@/features/monitor/components/client-key-quota-dialog'
import { PublicUsageDashboard } from '@/features/monitor/components/public-usage-dashboard'
import { StatusVisitStats } from '@/features/monitor/components/status-visit-stats'
import { UpstreamRequestHealth } from '@/features/monitor/components/upstream-request-health'

const USAGE_PERIOD_KEY = 'grokiq.public.upstream-usage-period.v1'
const USAGE_PERIODS: PublicUpstreamUsagePeriod[] = ['24h', '7d', '30d', '90d']
const VISIT_PERIOD_KEY = 'grokiq.public.page-visit-period.v1'
const VISIT_PERIODS: PublicVisitPeriod[] = ['24h', '7d', '30d', '90d']

const providerMeta: Record<
  PublicUpstreamProvider,
  { label: string; hint: string; icon: typeof SquareTerminal }
> = {
  grok_build: {
    label: 'Build',
    hint: '编程与工具调用通道',
    icon: SquareTerminal,
  },
  grok_web: {
    label: 'Web',
    hint: '网页对话通道',
    icon: Compass,
  },
  grok_console: {
    label: 'Console',
    hint: '控制台接入通道',
    icon: Webhook,
  },
}

let statusVisitRecorded = false

const emptySummary: PublicUpstreamAccountSummary = {
  reachable: false,
  updatedAt: null,
  total: 0,
  available: 0,
  recovering: 0,
  attention: 0,
  risk: 0,
  providers: {
    grok_build: { total: 0, available: 0 },
    grok_web: { total: 0, available: 0 },
    grok_console: { total: 0, available: 0 },
  },
  recovery: { cooldown: 0, waitingReset: 0, probing: 0 },
  issues: { disabled: 0, reauthRequired: 0 },
}

export function PublicUpstreamStatusPage() {
  const queryClient = useQueryClient()
  const isAdmin = Boolean(useAuthStore((state) => state.auth.accessToken))
  const periodView = usePersistedViewState(USAGE_PERIOD_KEY, { period: '24h' })
  const period = isUsagePeriod(periodView.value.period)
    ? periodView.value.period
    : '24h'
  const visitPeriodView = usePersistedViewState(VISIT_PERIOD_KEY, {
    period: '24h',
  })
  const visitPeriod = isVisitPeriod(visitPeriodView.value.period)
    ? visitPeriodView.value.period
    : '24h'
  const usageRefresh = useRef(false)
  const [loggingOutKind, setLoggingOutKind] = useState<
    'linuxdo' | 'account' | null
  >(null)
  const accessQuery = useQuery({
    queryKey: ['public', 'status-access', isAdmin],
    queryFn: api.publicStatusAccess,
    refetchInterval: 30_000,
    retry: 1,
  })
  const access = accessQuery.data
  const canView =
    access != null &&
    (!access.required ||
      access.admin ||
      Boolean(access.user) ||
      Boolean(access.account))
  const query = useQuery({
    queryKey: ['public', 'upstream-accounts', isAdmin],
    queryFn: api.publicUpstreamAccounts,
    enabled: canView,
    refetchInterval: 15_000,
    retry: 1,
  })
  // usageRefresh is a one-shot fetch flag, not part of the cache identity.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const usageQuery = useQuery({
    queryKey: ['public', 'upstream-usage', period],
    queryFn: async () => {
      const refresh = usageRefresh.current
      usageRefresh.current = false
      return api.publicUpstreamUsage({
        period,
        timezone: 'Asia/Shanghai',
        refresh,
      })
    },
    enabled: canView,
    refetchInterval: 30_000,
    retry: 1,
    placeholderData: (previous) => previous,
  })
  const healthQuery = useQuery({
    queryKey: ['public', 'upstream-health'],
    queryFn: api.publicUpstreamHealth,
    enabled: canView,
    refetchInterval: 20_000,
    retry: 1,
    placeholderData: (previous) => previous,
  })
  const visitQuery = useQuery({
    queryKey: ['public', 'page-stats', visitPeriod],
    queryFn: () =>
      api.publicPageStats({
        period: visitPeriod,
        timezone: 'Asia/Shanghai',
      }),
    enabled: canView,
    refetchInterval: 30_000,
    retry: 1,
    placeholderData: (previous) => previous,
  })
  useEffect(() => {
    if (!canView || statusVisitRecorded) return
    statusVisitRecorded = true
    let cancelled = false
    void api
      .recordPublicPageVisit({ path: '/status', referrer: document.referrer })
      .then((result) => {
        if (!cancelled && result.recorded) {
          void queryClient.invalidateQueries({
            queryKey: ['public', 'page-stats'],
          })
        }
      })
      .catch((error) => {
        statusVisitRecorded = false
        if (isStatusLoginRequired(error)) {
          void queryClient.invalidateQueries({
            queryKey: ['public', 'status-access'],
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [canView, queryClient])
  useEffect(() => {
    const loginRequired =
      isStatusLoginRequired(query.error) ||
      isStatusLoginRequired(usageQuery.error) ||
      isStatusLoginRequired(healthQuery.error) ||
      isStatusLoginRequired(visitQuery.error)
    if (!loginRequired) return
    void queryClient.invalidateQueries({
      queryKey: ['public', 'status-access'],
    })
  }, [
    healthQuery.error,
    query.error,
    queryClient,
    usageQuery.error,
    visitQuery.error,
  ])
  const data = query.data ?? emptySummary
  const usageErrorMessage = isStatusLoginRequired(usageQuery.error)
    ? ''
    : usageQuery.isError
      ? getErrorMessage(usageQuery.error)
      : ''
  const errorMessage = isStatusLoginRequired(query.error)
    ? ''
    : query.isError
      ? getErrorMessage(query.error)
      : ''
  const healthErrorMessage = isStatusLoginRequired(healthQuery.error)
    ? ''
    : healthQuery.isError
      ? getErrorMessage(healthQuery.error)
      : ''
  const visitErrorMessage = isStatusLoginRequired(visitQuery.error)
    ? ''
    : visitQuery.isError
      ? getErrorMessage(visitQuery.error)
      : ''
  const hasData = query.data != null
  const ready = hasData && data.reachable && !query.isError
  const accessLoading = accessQuery.isPending && !accessQuery.data
  const loginRequired =
    Boolean(access?.required) &&
    !access?.admin &&
    !access?.user &&
    !access?.account
  const accessErrorMessage = accessQuery.isError
    ? getErrorMessage(accessQuery.error)
    : ''

  async function logoutLinuxdo() {
    if (loggingOutKind) return
    setLoggingOutKind('linuxdo')
    try {
      await api.publicLinuxdoLogout()
      statusVisitRecorded = false
      await queryClient.invalidateQueries({ queryKey: ['public'] })
    } finally {
      setLoggingOutKind(null)
    }
  }

  async function logoutAccount() {
    if (loggingOutKind) return
    setLoggingOutKind('account')
    try {
      await api.publicStatusAccountLogout()
      statusVisitRecorded = false
      await queryClient.invalidateQueries({ queryKey: ['public'] })
    } finally {
      setLoggingOutKind(null)
    }
  }

  return (
    <div className='min-h-svh bg-background'>
      <header className='border-b bg-background/80 backdrop-blur-sm'>
        <div className='mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4'>
          <div className='flex min-w-0 items-center gap-2.5'>
            <span className='flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground'>
              <ShieldCheck className='size-4' />
            </span>
            <span className='min-w-0'>
              <span className='block truncate text-sm leading-4 font-semibold'>
                GrokIQ
              </span>
              <span className='block truncate text-[11px] text-muted-foreground'>
                上游状态
              </span>
            </span>
          </div>
          <div className='flex items-center gap-1'>
            {access?.account ? (
              <AccountSessionChip
                account={access.account}
                loggingOut={loggingOutKind === 'account'}
                onLogout={() => void logoutAccount()}
              />
            ) : null}
            {access?.user ? (
              <LinuxDoSessionChip
                user={access.user}
                loggingOut={loggingOutKind === 'linuxdo'}
                onLogout={() => void logoutLinuxdo()}
              />
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='text-muted-foreground'
                  asChild
                >
                  <a
                    href='https://github.com/kaibush/grok-iq'
                    target='_blank'
                    rel='noreferrer'
                    aria-label='查看 GrokIQ GitHub 仓库'
                  >
                    <IconGithub className='size-5' />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>GitHub 仓库</TooltipContent>
            </Tooltip>
            <ThemeSwitch />
          </div>
        </div>
      </header>

      <main className='mx-auto w-full max-w-6xl space-y-6 px-4 py-6 md:py-8'>
        {accessLoading ? (
          <div className='flex min-h-[50vh] flex-col items-center justify-center gap-3 text-sm text-muted-foreground'>
            <Loader2 className='size-5 animate-spin' />
            正在确认访问权限
          </div>
        ) : accessErrorMessage ? (
          <Card className='border-destructive/30 bg-destructive/5'>
            <CardContent className='space-y-3 p-6'>
              <p className='text-sm text-destructive'>
                访问状态读取失败：{accessErrorMessage}
              </p>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() => void accessQuery.refetch()}
              >
                重试
              </Button>
            </CardContent>
          </Card>
        ) : loginRequired ? (
          <StatusLoginWall
            configured={Boolean(access?.configured)}
            onAuthenticated={async () => {
              statusVisitRecorded = false
              await queryClient.invalidateQueries({ queryKey: ['public'] })
            }}
          />
        ) : (
          <>
            <div className='flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
              <div>
                <p className='text-xs font-medium tracking-[0.16em] text-primary uppercase'>
                  Public status
                </p>
                <h1 className='mt-1 text-2xl font-semibold tracking-tight'>
                  上游账号情况
                </h1>
                <p className='mt-1 text-sm text-muted-foreground'>
                  查看上游请求看板。密钥额度需手动查询，不会回显明文。
                </p>
              </div>
              <div className='flex flex-wrap items-center gap-2'>
                <StatusBadge
                  loading={query.isLoading && !query.data}
                  reachable={data.reachable}
                  error={Boolean(errorMessage)}
                />
                <ClientKeyQuotaDialog />
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={() => {
                    usageRefresh.current = true
                    void query.refetch()
                    void usageQuery.refetch()
                    void healthQuery.refetch()
                    void visitQuery.refetch()
                  }}
                  disabled={
                    query.isFetching ||
                    usageQuery.isFetching ||
                    healthQuery.isFetching ||
                    visitQuery.isFetching
                  }
                >
                  {query.isFetching ||
                  usageQuery.isFetching ||
                  healthQuery.isFetching ||
                  visitQuery.isFetching ? (
                    <Loader2 className='animate-spin' />
                  ) : (
                    <RefreshCw />
                  )}
                  刷新
                </Button>
              </div>
            </div>

            {errorMessage && (
              <Card className='border-destructive/30 bg-destructive/5'>
                <CardContent className='p-4 text-sm text-destructive'>
                  状态读取失败：{errorMessage}
                </CardContent>
              </Card>
            )}

            {!errorMessage && !data.reachable && query.data && (
              <Card className='border-amber-500/30 bg-amber-500/5'>
                <CardContent className='p-4 text-sm text-amber-800 dark:text-amber-300'>
                  上游暂时不可达，当前不展示账号计数。
                </CardContent>
              </Card>
            )}

            {isAdmin ? (
              <section className='grid gap-4 sm:grid-cols-2 xl:grid-cols-5'>
                <StatCard
                  label='账号总数'
                  value={ready ? formatNumber(data.total, 0) : '—'}
                  detail={
                    ready
                      ? `${formatNumber(data.available, 0)} 个当前可调度`
                      : '读取中'
                  }
                  icon={UsersRound}
                  tone='sky'
                  loading={query.isLoading && !hasData}
                  index={0}
                />
                <StatCard
                  label='恢复中'
                  value={ready ? formatNumber(data.recovering, 0) : '—'}
                  detail='冷却、待重置或检测中'
                  icon={TimerReset}
                  tone='amber'
                  loading={query.isLoading && !hasData}
                  index={1}
                />
                <StatCard
                  label='需关注'
                  value={ready ? formatNumber(data.attention, 0) : '—'}
                  detail={
                    ready
                      ? `${formatNumber(data.issues?.disabled, 0)} 停用 · ${formatNumber(data.issues?.reauthRequired, 0)} 失效`
                      : '读取中'
                  }
                  icon={AlertTriangle}
                  tone='amber'
                  loading={query.isLoading && !hasData}
                  index={2}
                />
                <StatCard
                  label='风险标记'
                  value={ready ? formatNumber(data.risk, 0) : '—'}
                  detail='上游机器人风险账号'
                  icon={ShieldAlert}
                  tone='red'
                  loading={query.isLoading && !hasData}
                  index={3}
                />
                <StatCard
                  label='可调度占比'
                  value={ready ? percent(data.available, data.total) : '—'}
                  detail='可调度 / 总数'
                  icon={Activity}
                  tone='emerald'
                  loading={query.isLoading && !hasData}
                  index={4}
                />
              </section>
            ) : null}

            <section className='grid gap-4 lg:grid-cols-3'>
              {(Object.keys(providerMeta) as PublicUpstreamProvider[]).map(
                (provider) => (
                  <ProviderCard
                    key={provider}
                    provider={provider}
                    counts={data.providers[provider]}
                    ready={ready}
                  />
                )
              )}
            </section>

            <UpstreamRequestHealth
              data={healthQuery.data}
              loading={
                (healthQuery.isPending || healthQuery.isPlaceholderData) &&
                !healthQuery.isError
              }
              error={healthErrorMessage}
            />

            <PublicUsageDashboard
              period={period}
              onPeriodChange={(next) => periodView.setValue({ period: next })}
              data={usageQuery.data}
              loading={
                (usageQuery.isPending || usageQuery.isPlaceholderData) &&
                !usageQuery.isError
              }
              error={usageErrorMessage}
            />

            <StatusVisitStats
              period={visitPeriod}
              onPeriodChange={(next) =>
                visitPeriodView.setValue({ period: next })
              }
              data={visitQuery.data}
              loading={
                (visitQuery.isPending || visitQuery.isPlaceholderData) &&
                !visitQuery.isError
              }
              error={visitErrorMessage}
              isAdmin={isAdmin}
            />

            {isAdmin ? (
              <section className='grid gap-4 lg:grid-cols-2'>
                <Card>
                  <CardHeader>
                    <CardTitle className='flex items-center gap-2 text-base'>
                      <TimerReset className='size-4 text-primary' />
                      恢复队列
                    </CardTitle>
                  </CardHeader>
                  <CardContent className='grid gap-3 sm:grid-cols-3'>
                    <CountTile
                      label='冷却中'
                      value={ready ? (data.recovery?.cooldown ?? null) : null}
                    />
                    <CountTile
                      label='待重置'
                      value={
                        ready ? (data.recovery?.waitingReset ?? null) : null
                      }
                    />
                    <CountTile
                      label='检测中'
                      value={ready ? (data.recovery?.probing ?? null) : null}
                    />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className='flex items-center gap-2 text-base'>
                      <AlertTriangle className='size-4 text-primary' />
                      账号问题
                    </CardTitle>
                  </CardHeader>
                  <CardContent className='grid gap-3 sm:grid-cols-2'>
                    <CountTile
                      label='已停用'
                      value={ready ? (data.issues?.disabled ?? null) : null}
                    />
                    <CountTile
                      label='需重新登录'
                      value={
                        ready ? (data.issues?.reauthRequired ?? null) : null
                      }
                    />
                  </CardContent>
                </Card>
              </section>
            ) : null}

            <p className='text-xs text-muted-foreground'>
              最近更新：{hasData ? formatDate(data.updatedAt) : '—'} · 每 15
              秒自动刷新
            </p>
          </>
        )}
      </main>
    </div>
  )
}

function StatusLoginWall({
  configured,
  onAuthenticated,
}: {
  configured: boolean
  onAuthenticated: () => Promise<void>
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    const nextError = validateStatusAccountForm({
      mode,
      username,
      password,
      confirmPassword,
      inviteCode,
    })
    if (nextError) {
      setFormError(nextError)
      return
    }
    setSubmitting(true)
    setFormError('')
    try {
      if (mode === 'register') {
        await api.publicStatusAccountRegister({
          username: username.trim(),
          password,
          confirmPassword,
          inviteCode: inviteCode.trim(),
        })
      } else {
        await api.publicStatusAccountLogin({
          username: username.trim(),
          password,
        })
      }
      await onAuthenticated()
    } catch (error) {
      setFormError(getErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className='mx-auto max-w-xl'>
      <CardContent className='space-y-5 p-6 sm:p-8'>
        <div className='flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary'>
          <LogIn className='size-5' />
        </div>
        <div className='space-y-1.5'>
          <h1 className='text-xl font-semibold tracking-tight'>
            需要登录后才能查看状态页
          </h1>
          <p className='text-sm leading-6 text-muted-foreground'>
            当前状态页已限制访问。可以使用 Linux.do
            Connect，或用邀请码注册的本地账号登录。登录有效期 7 天。
          </p>
        </div>

        <div className='space-y-3'>
          {configured ? (
            <Button
              type='button'
              className='w-full sm:w-auto'
              onClick={() => {
                window.location.assign(api.publicLinuxdoLoginUrl('/status'))
              }}
            >
              <LogIn />
              使用 Linux.do 登录
            </Button>
          ) : (
            <div className='space-y-2'>
              <Button type='button' disabled>
                <LogIn />
                使用 Linux.do 登录
              </Button>
              <p className='text-sm text-amber-800 dark:text-amber-300'>
                管理员尚未配置 Linux.do OAuth2，暂时无法使用 Linux.do
                登录。仍可用下方账号登录或注册。
              </p>
            </div>
          )}
        </div>

        <div className='relative'>
          <div className='absolute inset-0 flex items-center'>
            <span className='w-full border-t' />
          </div>
          <div className='relative flex justify-center text-xs uppercase'>
            <span className='bg-card px-2 text-muted-foreground'>
              或使用账号
            </span>
          </div>
        </div>

        <form
          className='space-y-3'
          onSubmit={(event) => void submitAccount(event)}
        >
          <div className='space-y-1.5'>
            <Label htmlFor='status-account-username'>用户名</Label>
            <Input
              id='status-account-username'
              value={username}
              autoComplete='username'
              maxLength={32}
              onChange={(event) => setUsername(event.target.value)}
              placeholder='3–32 位字母、数字、_ 或 -'
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='status-account-password'>密码</Label>
            <PasswordInput
              id='status-account-password'
              value={password}
              autoComplete={
                mode === 'register' ? 'new-password' : 'current-password'
              }
              maxLength={256}
              onChange={(event) => setPassword(event.target.value)}
              placeholder='至少 8 位'
            />
          </div>
          {mode === 'register' ? (
            <>
              <div className='space-y-1.5'>
                <Label htmlFor='status-account-confirm-password'>
                  确认密码
                </Label>
                <PasswordInput
                  id='status-account-confirm-password'
                  value={confirmPassword}
                  autoComplete='new-password'
                  maxLength={256}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder='再输入一次密码'
                />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='status-account-invite-code'>邀请码</Label>
                <Input
                  id='status-account-invite-code'
                  value={inviteCode}
                  autoComplete='off'
                  spellCheck={false}
                  maxLength={32}
                  className='font-mono uppercase'
                  onChange={(event) =>
                    setInviteCode(event.target.value.toUpperCase())
                  }
                  placeholder='请输入管理员发放的邀请码'
                />
              </div>
            </>
          ) : null}
          {formError ? (
            <p className='text-sm text-destructive'>{formError}</p>
          ) : null}
          <Button
            type='submit'
            className='w-full sm:w-auto'
            disabled={submitting}
          >
            {submitting ? <Loader2 className='animate-spin' /> : <LogIn />}
            {mode === 'register' ? '注册并登录' : '登录'}
          </Button>
        </form>

        <button
          type='button'
          className='text-sm text-primary hover:underline'
          onClick={() => {
            setMode((current) => (current === 'login' ? 'register' : 'login'))
            setFormError('')
          }}
        >
          {mode === 'login' ? '没有账号？用邀请码注册' : '已有账号？直接登录'}
        </button>
      </CardContent>
    </Card>
  )
}

function AccountSessionChip({
  account,
  loggingOut,
  onLogout,
}: {
  account: StatusAccountPublicUser
  loggingOut: boolean
  onLogout: () => void
}) {
  const username = account.username?.trim() || '账号'
  const initials = username.slice(0, 1).toUpperCase()
  return (
    <div className='mr-1 flex min-w-0 items-center gap-2 rounded-full border bg-muted/30 py-1 pr-1 pl-1'>
      <Avatar className='size-7'>
        <AvatarFallback className='bg-primary/10 text-[10px] font-medium text-primary'>
          {initials}
        </AvatarFallback>
      </Avatar>
      <div className='min-w-0 pr-1'>
        <div className='truncate text-xs font-medium' title={username}>
          {username}
        </div>
        <div className='flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground'>
          <UserRound className='size-3' />
          <span className='truncate'>本地账号</span>
        </div>
      </div>
      <Button
        type='button'
        size='sm'
        variant='ghost'
        className='h-7 px-2 text-xs'
        disabled={loggingOut}
        onClick={onLogout}
      >
        {loggingOut ? <Loader2 className='animate-spin' /> : <LogOut />}
        退出
      </Button>
    </div>
  )
}

function LinuxDoSessionChip({
  user,
  loggingOut,
  onLogout,
}: {
  user: LinuxDoPublicUser
  loggingOut: boolean
  onLogout: () => void
}) {
  const displayName = user.name?.trim() || user.username || 'Linux.do'
  const handle = user.username?.trim() || ''
  const initials = displayName.slice(0, 1).toUpperCase()
  return (
    <div className='mr-1 flex min-w-0 items-center gap-2 rounded-full border bg-muted/30 py-1 pr-1 pl-1'>
      <Avatar className='size-7'>
        {user.avatarUrl ? (
          <AvatarImage src={user.avatarUrl} alt={displayName} />
        ) : null}
        <AvatarFallback className='bg-primary/10 text-[10px] font-medium text-primary'>
          {initials}
        </AvatarFallback>
      </Avatar>
      <div className='min-w-0 pr-1'>
        <div className='truncate text-xs font-medium' title={displayName}>
          {displayName}
        </div>
        <div className='flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground'>
          {handle ? <span className='truncate'>@{handle}</span> : null}
          {user.trustLevel != null ? (
            <Badge variant='outline' className='h-4 px-1 text-[10px]'>
              TL{user.trustLevel}
            </Badge>
          ) : null}
        </div>
      </div>
      <Button
        type='button'
        size='sm'
        variant='ghost'
        className='h-7 px-2 text-xs'
        disabled={loggingOut}
        onClick={onLogout}
      >
        {loggingOut ? <Loader2 className='animate-spin' /> : <LogOut />}
        退出
      </Button>
    </div>
  )
}

function isStatusLoginRequired(error: unknown) {
  return (
    error instanceof ApiError &&
    (error.code === 'linuxdo_login_required' ||
      error.code === 'status_login_required')
  )
}

const STATUS_ACCOUNT_USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,32}$/

function validateStatusAccountForm({
  mode,
  username,
  password,
  confirmPassword,
  inviteCode,
}: {
  mode: 'login' | 'register'
  username: string
  password: string
  confirmPassword: string
  inviteCode: string
}) {
  const trimmedUsername = username.trim()
  if (!STATUS_ACCOUNT_USERNAME_PATTERN.test(trimmedUsername)) {
    return '用户名需为 3–32 位字母、数字、下划线或连字符'
  }
  if (password.length < 8 || password.length > 256) {
    return '密码长度需为 8–256 位'
  }
  if (mode === 'register') {
    if (password !== confirmPassword) {
      return '两次输入的密码不一致'
    }
    if (!inviteCode.trim()) {
      return '请填写邀请码'
    }
  }
  return ''
}

function StatusBadge({
  loading,
  reachable,
  error,
}: {
  loading: boolean
  reachable: boolean
  error: boolean
}) {
  if (loading) {
    return (
      <Badge variant='outline' className='gap-1.5'>
        <Loader2 className='size-3 animate-spin' />
        读取中
      </Badge>
    )
  }
  if (error) {
    return <Badge variant='destructive'>读取失败</Badge>
  }
  if (!reachable) {
    return <Badge variant='warning'>上游不可达</Badge>
  }
  return <Badge variant='success'>上游正常</Badge>
}

function ProviderCard({
  provider,
  counts,
  ready,
}: {
  provider: PublicUpstreamProvider
  counts: { capacity?: number; total?: number; available?: number }
  ready: boolean
}) {
  const meta = providerMeta[provider]
  const Icon = meta.icon
  const capacity = providerCapacity(counts)
  return (
    <Card>
      <CardContent className='space-y-4 p-5'>
        <div className='flex items-start justify-between gap-3'>
          <div>
            <div className='flex items-center gap-2'>
              <Icon className='size-4 text-primary' />
              <h2 className='font-medium'>{meta.label}</h2>
            </div>
            <p className='mt-1 text-xs text-muted-foreground'>{meta.hint}</p>
          </div>
          <Badge variant='outline'>{ready ? `${capacity}%` : '—'}</Badge>
        </div>
        <ProgressBar className='h-2' value={ready ? capacity : 0} />
        <div className='flex items-center justify-between text-sm'>
          <span className='text-muted-foreground'>当前余量</span>
          <span className='tabular-nums'>{ready ? `${capacity}%` : '—'}</span>
        </div>
      </CardContent>
    </Card>
  )
}

function providerCapacity(counts: {
  capacity?: number
  total?: number
  available?: number
}) {
  if (counts.capacity != null)
    return Math.max(0, Math.min(100, counts.capacity))
  if (!counts.total) return 0
  return Math.round(((counts.available ?? 0) / counts.total) * 100)
}

function CountTile({
  label,
  value,
  display,
}: {
  label: string
  value?: number | null
  display?: string | null
}) {
  return (
    <div className='rounded-lg border bg-muted/20 px-3 py-3'>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 text-xl font-semibold tabular-nums'>
        {display ?? (value == null ? '—' : formatNumber(value, 0))}
      </div>
    </div>
  )
}

function percent(part?: number, total?: number) {
  if (!total) return '—'
  return `${Math.round(((part ?? 0) / total) * 100)}%`
}

function isUsagePeriod(value: string): value is PublicUpstreamUsagePeriod {
  return USAGE_PERIODS.includes(value as PublicUpstreamUsagePeriod)
}

function isVisitPeriod(value: string): value is PublicVisitPeriod {
  return VISIT_PERIODS.includes(value as PublicVisitPeriod)
}
