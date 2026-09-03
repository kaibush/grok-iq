import { useState, type ComponentType, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock3,
  Loader2,
  LockKeyhole,
  Network,
  Rows3,
  ShieldCheck,
  Workflow,
} from 'lucide-react'
import { toast } from 'sonner'
import { Logo } from '@/assets/logo'
import { api, type RuntimeSettings } from '@/lib/api'
import { cn, getErrorMessage } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NumericInput } from '@/components/numeric-input'
import { Switch } from '@/components/ui/switch'
import { PasswordInput } from '@/components/password-input'
import { ThemeSwitch } from '@/components/theme-switch'
import { SsoDirectConnectRiskNotice } from '@/features/monitor/components/sso-direct-connect-risk'

const steps = ['开始', '连接配置', '任务容量', '运行策略', '完成']

export function OnboardingPage() {
  const { redirect } = useSearch({ from: '/onboarding' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [step, setStep] = useState(0)
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null)
  const [usernameDraft, setUsernameDraft] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [workerConcurrencyDraft, setWorkerConcurrencyDraft] = useState<
    number | null
  >(null)
  const [queueLimitDraft, setQueueLimitDraft] = useState<number | null>(null)
  const [schedulerEnabledDraft, setSchedulerEnabledDraft] = useState<
    boolean | null
  >(null)
  const [recoveryEnabledDraft, setRecoveryEnabledDraft] = useState<
    boolean | null
  >(null)
  const [timezoneDraft, setTimezoneDraft] = useState<string | null>(null)
  const [analysisWindowDraft, setAnalysisWindowDraft] = useState<number | null>(
    null
  )
  const [ssoProxyDraft, setSsoProxyDraft] = useState('')
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings,
    staleTime: 0,
  })
  const onboarding = useQuery({
    queryKey: ['onboarding'],
    queryFn: api.onboarding,
    staleTime: 0,
  })

  const baseUrl = baseUrlDraft ?? settings.data?.grok2apiBaseUrl ?? ''
  const username = usernameDraft ?? settings.data?.grok2apiAdminUsername ?? ''
  const workerConcurrency =
    workerConcurrencyDraft ?? settings.data?.probeWorkerConcurrency ?? 2
  const queueLimit = queueLimitDraft ?? settings.data?.probeQueueLimit ?? 10_000
  const schedulerEnabled =
    schedulerEnabledDraft ?? settings.data?.schedulerEnabled ?? true
  const recoveryEnabled =
    recoveryEnabledDraft ?? settings.data?.quarantineRecoveryEnabled ?? true
  const timezone = timezoneDraft ?? settings.data?.schedulerTimezone ?? 'UTC'
  const analysisWindow =
    analysisWindowDraft ?? settings.data?.analysisWindowHours ?? 168
  const ssoProxy = ssoProxyDraft
  const ssoProxyConfigured = Boolean(settings.data?.ssoProxyConfigured)

  const passwordReady =
    Boolean(password.trim()) ||
    Boolean(settings.data?.grok2apiAdminPasswordConfigured)
  const connectionReady =
    Boolean(baseUrl.trim()) && Boolean(username.trim()) && passwordReady
  const capacityReady =
    Number.isInteger(workerConcurrency) &&
    workerConcurrency >= 1 &&
    workerConcurrency <= 32 &&
    Number.isInteger(queueLimit) &&
    queueLimit >= 1 &&
    queueLimit <= 100_000
  const strategyReady =
    Boolean(timezone.trim()) &&
    Number.isInteger(analysisWindow) &&
    analysisWindow >= 1 &&
    analysisWindow <= 24 * 365

  const complete = useMutation({
    mutationFn: () => {
      const payload = {
        grok2apiBaseUrl: baseUrl.trim(),
        grok2apiAdminUsername: username.trim(),
        probeWorkerConcurrency: workerConcurrency,
        probeQueueLimit: queueLimit,
        schedulerEnabled,
        quarantineRecoveryEnabled: recoveryEnabled,
        schedulerTimezone: timezone.trim(),
        analysisWindowHours: analysisWindow,
        ...(password.trim() ? { grok2apiAdminPassword: password } : {}),
        ...(ssoProxy.trim() ? { ssoProxy: ssoProxy.trim() } : {}),
      }
      return api.completeOnboarding(payload)
    },
    onSuccess: async (result) => {
      queryClient.setQueryData(['onboarding'], {
        completed: result.completed,
        ready: result.ready,
        requirements: result.requirements,
      })
      queryClient.setQueryData(['settings'], result.settings)
      await queryClient.invalidateQueries({ queryKey: ['health'] })
      toast.success('初始化完成，grok2api 连接正常')
      await navigate({ to: normalizedRedirect(redirect), replace: true })
    },
  })

  const next = () => {
    if (step === 1 && !connectionReady) {
      toast.error('请先补全 grok2api 地址、管理员用户名和密码')
      return
    }
    if (step === 2 && !capacityReady) {
      toast.error('Worker 并发数或持久队列容量超出允许范围')
      return
    }
    if (step === 3 && !strategyReady) {
      toast.error('请填写有效的调度时区和风险分析窗口')
      return
    }
    setStep((current) => Math.min(4, current + 1))
  }

  if (settings.isLoading || onboarding.isLoading) {
    return (
      <div className='flex min-h-svh items-center justify-center bg-muted/30'>
        <Loader2 className='size-6 animate-spin text-muted-foreground' />
      </div>
    )
  }

  if (settings.isError || onboarding.isError || !settings.data) {
    const error = settings.error ?? onboarding.error
    return (
      <div className='flex min-h-svh items-center justify-center bg-muted/30 p-4'>
        <Card className='w-full max-w-md'>
          <CardHeader>
            <CardTitle>初始化信息读取失败</CardTitle>
            <CardDescription>{getErrorMessage(error)}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className='w-full'
              onClick={() => {
                void settings.refetch()
                void onboarding.refetch()
              }}
            >
              重新加载
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <main className='min-h-svh bg-muted/30'>
      <header className='border-b bg-background/95'>
        <div className='mx-auto flex h-14 w-full max-w-5xl items-center px-4 sm:px-6'>
          <div className='flex items-center gap-2.5'>
            <Logo className='size-8' />
            <div>
              <div className='text-sm leading-4 font-semibold'>GrokIQ</div>
              <div className='text-[11px] text-muted-foreground'>
                系统初始化
              </div>
            </div>
          </div>
          <div className='ms-auto'>
            <ThemeSwitch />
          </div>
        </div>
      </header>

      <div className='mx-auto grid w-full max-w-5xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:py-14'>
        <nav aria-label='初始化进度' className='lg:pt-5'>
          <ol className='grid grid-cols-2 gap-1 sm:grid-cols-5 lg:grid-cols-1'>
            {steps.map((label, index) => (
              <li key={label}>
                <div
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-xs sm:justify-center lg:justify-start lg:text-sm',
                    index === step
                      ? 'bg-accent font-medium text-accent-foreground'
                      : index < step
                        ? 'text-foreground'
                        : 'text-muted-foreground'
                  )}
                >
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs',
                      index < step &&
                        'border-emerald-600 bg-emerald-600 text-white',
                      index === step &&
                        'border-primary bg-primary text-primary-foreground'
                    )}
                  >
                    {index < step ? <Check className='size-3.5' /> : index + 1}
                  </span>
                  <span className='truncate'>{label}</span>
                </div>
              </li>
            ))}
          </ol>
        </nav>

        <Card className='min-h-[30rem] w-full gap-0 py-0'>
          <CardHeader className='border-b px-5 py-6 sm:px-8'>
            <StepHeading step={step} />
          </CardHeader>
          <CardContent className='flex-1 px-5 py-6 sm:px-8 sm:py-8'>
            {step === 0 && <WelcomeStep settings={settings.data} />}
            {step === 1 && (
              <ConnectionStep
                baseUrl={baseUrl}
                username={username}
                password={password}
                passwordConfigured={
                  settings.data.grok2apiAdminPasswordConfigured
                }
                onBaseUrlChange={setBaseUrlDraft}
                onUsernameChange={setUsernameDraft}
                onPasswordChange={setPassword}
              />
            )}
            {step === 2 && (
              <CapacityStep
                workerConcurrency={workerConcurrency}
                queueLimit={queueLimit}
                onWorkerConcurrencyChange={setWorkerConcurrencyDraft}
                onQueueLimitChange={setQueueLimitDraft}
              />
            )}
            {step === 3 && (
              <StrategyStep
                schedulerEnabled={schedulerEnabled}
                recoveryEnabled={recoveryEnabled}
                timezone={timezone}
                analysisWindow={analysisWindow}
                ssoProxy={ssoProxy}
                ssoProxyConfigured={ssoProxyConfigured}
                onSchedulerEnabledChange={setSchedulerEnabledDraft}
                onRecoveryEnabledChange={setRecoveryEnabledDraft}
                onTimezoneChange={setTimezoneDraft}
                onAnalysisWindowChange={setAnalysisWindowDraft}
                onSsoProxyChange={setSsoProxyDraft}
              />
            )}
            {step === 4 && (
              <ReviewStep
                baseUrl={baseUrl}
                username={username}
                passwordReady={passwordReady}
                workerConcurrency={workerConcurrency}
                queueLimit={queueLimit}
                schedulerEnabled={schedulerEnabled}
                recoveryEnabled={recoveryEnabled}
                timezone={timezone}
                analysisWindow={analysisWindow}
                ssoProxyReady={ssoProxyConfigured || Boolean(ssoProxy.trim())}
                error={complete.error}
              />
            )}
          </CardContent>
          <CardFooter className='flex-col-reverse gap-2 border-t px-5 py-4 sm:flex-row sm:justify-between sm:px-8'>
            <Button
              type='button'
              variant='ghost'
              className='w-full sm:w-auto'
              disabled={step === 0 || complete.isPending}
              onClick={() => setStep((current) => Math.max(0, current - 1))}
            >
              <ArrowLeft />
              上一步
            </Button>
            {step < 4 ? (
              <Button type='button' className='w-full sm:w-auto' onClick={next}>
                下一步
                <ArrowRight />
              </Button>
            ) : (
              <Button
                type='button'
                className='w-full sm:w-auto'
                disabled={
                  !connectionReady ||
                  !capacityReady ||
                  !strategyReady ||
                  complete.isPending
                }
                onClick={() => complete.mutate()}
              >
                {complete.isPending ? (
                  <Loader2 className='animate-spin' />
                ) : (
                  <CheckCircle2 />
                )}
                保存、验证并进入系统
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </main>
  )
}

function StepHeading({ step }: { step: number }) {
  const values = [
    ['欢迎使用 GrokIQ', '首次登录需要完成一次系统初始化。'],
    ['连接 grok2api', '账号与概览数据依赖此管理 API。'],
    ['设置任务容量', '确认 Worker 并发与持久队列容量。'],
    ['确认运行策略', '设置周期任务、恢复策略和分析范围。'],
    ['确认并完成', '连接验证通过后即可进入系统。'],
  ]
  return (
    <>
      <CardTitle className='text-xl'>{values[step][0]}</CardTitle>
      <CardDescription className='mt-1.5 leading-6'>
        {values[step][1]}
      </CardDescription>
    </>
  )
}

function WelcomeStep({ settings }: { settings: RuntimeSettings }) {
  const configured = [
    Boolean(settings.grok2apiBaseUrl.trim()),
    Boolean(settings.grok2apiAdminUsername.trim()),
    settings.grok2apiAdminPasswordConfigured,
  ].filter(Boolean).length
  return (
    <div className='space-y-7'>
      <div className='flex size-12 items-center justify-center rounded-lg bg-primary/10 text-primary'>
        <Network className='size-6' />
      </div>
      <div className='max-w-xl space-y-3'>
        <h2 className='font-semibold'>先确认核心连接</h2>
        <p className='text-sm leading-6 text-muted-foreground'>
          系统会保留环境变量和现有设置，只需补齐缺少的内容。向导还会确认常用运行参数；通知联动和高级风险规则可进入系统后再调整。
        </p>
      </div>
      <div className='grid gap-3 sm:grid-cols-3'>
        <RequirementStatus
          label='服务地址'
          ready={Boolean(settings.grok2apiBaseUrl.trim())}
        />
        <RequirementStatus
          label='管理员用户名'
          ready={Boolean(settings.grok2apiAdminUsername.trim())}
        />
        <RequirementStatus
          label='管理员密码'
          ready={settings.grok2apiAdminPasswordConfigured}
        />
      </div>
      <Alert>
        <CheckCircle2 />
        <AlertTitle>已识别 {configured}/3 项核心配置</AlertTitle>
        <AlertDescription>
          即使三项均已配置，也需要继续确认并完成本次初始化。
        </AlertDescription>
      </Alert>
    </div>
  )
}

function ConnectionStep({
  baseUrl,
  username,
  password,
  passwordConfigured,
  onBaseUrlChange,
  onUsernameChange,
  onPasswordChange,
}: {
  baseUrl: string
  username: string
  password: string
  passwordConfigured: boolean
  onBaseUrlChange: (value: string) => void
  onUsernameChange: (value: string) => void
  onPasswordChange: (value: string) => void
}) {
  return (
    <div className='grid gap-5'>
      <SetupField
        label='grok2api 服务地址'
        configured={Boolean(baseUrl.trim())}
      >
        <Input
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          placeholder='http://127.0.0.1:8000'
          autoFocus={!baseUrl.trim()}
        />
      </SetupField>
      <SetupField label='管理员用户名' configured={Boolean(username.trim())}>
        <Input
          value={username}
          onChange={(event) => onUsernameChange(event.target.value)}
          placeholder='grok2api 管理员用户名'
          autoComplete='username'
          autoFocus={Boolean(baseUrl.trim()) && !username.trim()}
        />
      </SetupField>
      <SetupField
        label='管理员密码'
        configured={passwordConfigured || Boolean(password.trim())}
        hint={passwordConfigured ? '已配置；留空保持当前密码' : undefined}
      >
        <PasswordInput
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          placeholder={
            passwordConfigured ? '已配置，无需重复输入' : '输入管理员密码'
          }
          autoComplete='current-password'
          autoFocus={
            Boolean(baseUrl.trim()) &&
            Boolean(username.trim()) &&
            !passwordConfigured
          }
        />
      </SetupField>
    </div>
  )
}

function CapacityStep({
  workerConcurrency,
  queueLimit,
  onWorkerConcurrencyChange,
  onQueueLimitChange,
}: {
  workerConcurrency: number
  queueLimit: number
  onWorkerConcurrencyChange: (value: number) => void
  onQueueLimitChange: (value: number) => void
}) {
  return (
    <div className='space-y-6'>
      <div className='grid gap-4 sm:grid-cols-2'>
        <label className='grid gap-2 rounded-lg border p-4'>
          <span className='flex items-center gap-2 font-medium'>
            <Workflow className='size-4 text-primary' />
            Worker 并发数
          </span>
          <span className='min-h-10 text-xs leading-5 text-muted-foreground'>
            可同时执行的探针任务数。账号之间并行，同一账号仍会避免并发冲突。
          </span>
          <NumericInput
            min={1}
            max={32}
            value={workerConcurrency}
            onChange={onWorkerConcurrencyChange}
          />
          <span className='text-xs text-muted-foreground'>允许 1–32</span>
        </label>
        <label className='grid gap-2 rounded-lg border p-4'>
          <span className='flex items-center gap-2 font-medium'>
            <Rows3 className='size-4 text-primary' />
            持久队列容量
          </span>
          <span className='min-h-10 text-xs leading-5 text-muted-foreground'>
            最多保留的待执行任务数量，用于限制批量计划和周期任务的积压规模。
          </span>
          <NumericInput
            min={1}
            max={100000}
            value={queueLimit}
            onChange={onQueueLimitChange}
          />
          <span className='text-xs text-muted-foreground'>允许 1–100,000</span>
        </label>
      </div>
      <Alert>
        <Workflow />
        <AlertTitle>当前值已预填</AlertTitle>
        <AlertDescription>
          如果环境变量或数据库已有配置，这里会显示该值；否则采用系统默认值。完成初始化后仍可在系统设置中调整。
        </AlertDescription>
      </Alert>
    </div>
  )
}

function StrategyStep({
  schedulerEnabled,
  recoveryEnabled,
  timezone,
  analysisWindow,
  ssoProxy,
  ssoProxyConfigured,
  onSchedulerEnabledChange,
  onRecoveryEnabledChange,
  onTimezoneChange,
  onAnalysisWindowChange,
  onSsoProxyChange,
}: {
  schedulerEnabled: boolean
  recoveryEnabled: boolean
  timezone: string
  analysisWindow: number
  ssoProxy: string
  ssoProxyConfigured: boolean
  onSchedulerEnabledChange: (value: boolean) => void
  onRecoveryEnabledChange: (value: boolean) => void
  onTimezoneChange: (value: string) => void
  onAnalysisWindowChange: (value: number) => void
  onSsoProxyChange: (value: string) => void
}) {
  return (
    <div className='space-y-5'>
      <div className='divide-y rounded-lg border'>
        <StrategyToggle
          icon={CalendarClock}
          label='周期调度'
          description='按探针计划的 Cron 表达式自动创建任务。关闭后仍可手动执行任务。'
          checked={schedulerEnabled}
          onCheckedChange={onSchedulerEnabledChange}
        />
        <StrategyToggle
          icon={ShieldCheck}
          label='隔离自动恢复'
          description='定期检查由 GrokIQ 隔离的账号，到期后按记录状态恢复。'
          checked={recoveryEnabled}
          onCheckedChange={onRecoveryEnabledChange}
        />
      </div>
      <div className='grid gap-4 sm:grid-cols-2'>
        <label className='grid gap-2'>
          <span className='flex items-center gap-2 text-sm font-medium'>
            <Clock3 className='size-4 text-primary' />
            默认调度时区
          </span>
          <Input
            value={timezone}
            onChange={(event) => onTimezoneChange(event.target.value)}
            placeholder='UTC'
          />
          <span className='text-xs leading-5 text-muted-foreground'>
            使用 IANA 时区名称，例如 UTC、Asia/Shanghai。
          </span>
        </label>
        <label className='grid gap-2'>
          <span className='flex items-center gap-2 text-sm font-medium'>
            <Workflow className='size-4 text-primary' />
            风险分析窗口（小时）
          </span>
          <NumericInput
            min={1}
            max={8760}
            value={analysisWindow}
            onChange={onAnalysisWindowChange}
          />
          <span className='text-xs leading-5 text-muted-foreground'>
            默认 168 小时，即最近 7 天的有效探针样本。
          </span>
        </label>
      </div>
      <label className='grid gap-2'>
        <span className='flex items-center gap-2 text-sm font-medium'>
          <Network className='size-4 text-primary' />
          SSO 检测代理（选填）
        </span>
        <Input
          value={ssoProxy}
          onChange={(event) => onSsoProxyChange(event.target.value)}
          placeholder={
            ssoProxyConfigured
              ? '已配置，留空保持当前代理'
              : 'host:port 或 username:password@host:port'
          }
          autoComplete='off'
          spellCheck={false}
        />
        <span className='text-xs leading-5 text-muted-foreground'>
          可跳过。用于 SSO
          报告、账号检测和请求审计关联检查；支持代理池或单条代理。
        </span>
      </label>
      {!ssoProxyConfigured && !ssoProxy.trim() ? (
        <SsoDirectConnectRiskNotice description='可以先跳过不填。未填写时 SSO 检测将使用本机直连 IP 出口，容易导致账号被风控。' />
      ) : null}
    </div>
  )
}

function ReviewStep({
  baseUrl,
  username,
  passwordReady,
  workerConcurrency,
  queueLimit,
  schedulerEnabled,
  recoveryEnabled,
  timezone,
  analysisWindow,
  ssoProxyReady,
  error,
}: {
  baseUrl: string
  username: string
  passwordReady: boolean
  workerConcurrency: number
  queueLimit: number
  schedulerEnabled: boolean
  recoveryEnabled: boolean
  timezone: string
  analysisWindow: number
  ssoProxyReady: boolean
  error: unknown
}) {
  return (
    <div className='space-y-6'>
      <div className='divide-y rounded-lg border'>
        <ReviewRow label='服务地址' value={baseUrl || '未填写'} />
        <ReviewRow label='管理员用户名' value={username || '未填写'} />
        <ReviewRow
          label='管理员密码'
          value={passwordReady ? '已配置' : '未填写'}
        />
        <ReviewRow label='Worker 并发数' value={`${workerConcurrency} 个`} />
        <ReviewRow
          label='持久队列容量'
          value={`${queueLimit.toLocaleString()} 个任务`}
        />
        <ReviewRow
          label='周期调度'
          value={schedulerEnabled ? '已开启' : '已关闭'}
        />
        <ReviewRow
          label='隔离自动恢复'
          value={recoveryEnabled ? '已开启' : '已关闭'}
        />
        <ReviewRow label='默认调度时区' value={timezone} />
        <ReviewRow label='风险分析窗口' value={`${analysisWindow} 小时`} />
        <ReviewRow
          label='SSO 检测代理'
          value={ssoProxyReady ? '已配置' : '未填写'}
        />
        <ReviewRow label='其他高级参数' value='使用当前值或系统默认值' />
      </div>
      <Alert>
        <LockKeyhole />
        <AlertTitle>将验证管理 API</AlertTitle>
        <AlertDescription>
          完成时会保存本页配置并读取 grok2api
          账号汇总。验证失败时不会进入主系统，可返回修改后重试。
        </AlertDescription>
      </Alert>
      {error ? (
        <Alert variant='destructive'>
          <AlertTitle>连接验证失败</AlertTitle>
          <AlertDescription>{getErrorMessage(error)}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

function SetupField({
  label,
  configured,
  hint,
  children,
}: {
  label: string
  configured: boolean
  hint?: string
  children: ReactNode
}) {
  return (
    <label className='grid gap-2'>
      <span className='flex items-center gap-2 text-sm font-medium'>
        {label}
        <Badge variant={configured ? 'success' : 'warning'}>
          {configured ? '已配置' : '待填写'}
        </Badge>
      </span>
      {children}
      {hint && <span className='text-xs text-muted-foreground'>{hint}</span>}
    </label>
  )
}

function StrategyToggle({
  icon: Icon,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  description: string
  checked: boolean
  onCheckedChange: (value: boolean) => void
}) {
  return (
    <div className='flex items-start gap-4 px-4 py-4'>
      <span className='mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary'>
        <Icon className='size-4' />
      </span>
      <div className='min-w-0 flex-1'>
        <div className='text-sm font-medium'>{label}</div>
        <p className='mt-1 text-xs leading-5 text-muted-foreground'>
          {description}
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
    </div>
  )
}

function RequirementStatus({
  label,
  ready,
}: {
  label: string
  ready: boolean
}) {
  return (
    <div className='flex items-center gap-3 rounded-md border px-3 py-3'>
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full',
          ready
            ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
            : 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
        )}
      >
        {ready ? <Check className='size-4' /> : <Network className='size-4' />}
      </span>
      <div className='min-w-0'>
        <div className='truncate text-sm font-medium'>{label}</div>
        <div className='text-xs text-muted-foreground'>
          {ready ? '已提供' : '需要补充'}
        </div>
      </div>
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className='grid gap-1 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center'>
      <span className='text-sm text-muted-foreground'>{label}</span>
      <span className='min-w-0 text-sm font-medium break-words'>{value}</span>
    </div>
  )
}

function normalizedRedirect(value?: string): string {
  return value?.startsWith('/') &&
    !value.startsWith('//') &&
    !value.startsWith('/onboarding')
    ? value
    : '/'
}
