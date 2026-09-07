import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Outlet, useLocation } from '@tanstack/react-router'
import {
  Activity,
  KeyRound,
  Network,
  Save,
  TestTube2,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, type SecretSettingName, type WechatTestScenario } from '@/lib/api'
import { cn, getErrorMessage } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { ActionToolbar, ToolbarAction } from '@/components/action-toolbar'
import { EmptyState, LoadingState, Page, PageHeader } from '@/components/page'
import { settingsSections } from '@/components/layout/data/settings-navigation'
import {
  RECOMMENDED_RISK_SCORING,
  buildSettingsPayload,
  mergeEditableSettings,
  registerWebhookUrl,
  toSettingsForm,
  validateSettings,
  type SettingsForm,
  type SettingsSetter,
} from '@/features/monitor/components/settings-model'
import {
  SettingsWorkspaceContext,
  type SettingsWorkspaceValue,
} from './settings-workspace'

export function SettingsLayout() {
  const queryClient = useQueryClient()
  const pathname = useLocation({ select: (location) => location.pathname })
  const settings = useQuery({
    queryKey: ['settings', 'editor'],
    queryFn: api.editableSettings,
  })
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 15_000,
  })
  const profiles = useQuery({
    queryKey: ['probe-profiles'],
    queryFn: api.profiles,
  })
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [clearSecrets, setClearSecrets] = useState<SecretSettingName[]>([])

  useEffect(() => {
    if (!settings.data) return
    // 切换子路由不会卸载此 Provider，因此未保存内容会保留。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm(toSettingsForm(settings.data))
    setClearSecrets([])
  }, [settings.data])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form || !settings.data) throw new Error('设置尚未加载')
      const submittedForm = form
      const submittedClearSecrets = [...clearSecrets]
      validateSettings(submittedForm)
      const value = await api.updateSettings(
        buildSettingsPayload(
          submittedForm,
          submittedClearSecrets,
          settings.data
        )
      )
      return { value, submittedForm, submittedClearSecrets }
    },
    onSuccess: ({ value, submittedForm, submittedClearSecrets }) => {
      const editableValue = mergeEditableSettings(
        value,
        submittedForm,
        submittedClearSecrets
      )
      queryClient.setQueryData(['settings'], value)
      queryClient.setQueryData(['settings', 'editor'], editableValue)
      setForm(toSettingsForm(editableValue))
      setClearSecrets([])
      toast.success('运行时设置已保存并热应用')
      void queryClient.invalidateQueries({ queryKey: ['health'] })
      void queryClient.invalidateQueries({ queryKey: ['scheduler'] })
      void queryClient.invalidateQueries({ queryKey: ['request-audits'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const testMutation = useMutation({
    mutationFn: async () => {
      if (!form || !settings.data) throw new Error('设置尚未加载')
      const submittedForm = form
      const submittedClearSecrets = [...clearSecrets]
      validateSettings(submittedForm)
      const value = await api.updateSettings(
        buildSettingsPayload(
          submittedForm,
          submittedClearSecrets,
          settings.data
        )
      )
      const result = await api.testGrok2api()
      return { value, submittedForm, submittedClearSecrets, result }
    },
    onSuccess: ({ value, submittedForm, submittedClearSecrets, result }) => {
      const editableValue = mergeEditableSettings(
        value,
        submittedForm,
        submittedClearSecrets
      )
      queryClient.setQueryData(['settings'], value)
      queryClient.setQueryData(['settings', 'editor'], editableValue)
      setForm(toSettingsForm(editableValue))
      setClearSecrets([])
      toast.success(`连接测试通过：${result.baseUrl}`)
      void queryClient.invalidateQueries({ queryKey: ['health'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const wechatTestMutation = useMutation({
    mutationFn: async (scenario: WechatTestScenario) => {
      if (!form || !settings.data) throw new Error('设置尚未加载')
      const submittedForm = form
      const submittedClearSecrets = [...clearSecrets]
      validateSettings(submittedForm)
      const value = await api.updateSettings(
        buildSettingsPayload(
          submittedForm,
          submittedClearSecrets,
          settings.data
        )
      )
      const result = await api.testWechat(scenario)
      return { value, submittedForm, submittedClearSecrets, result }
    },
    onSuccess: ({ value, submittedForm, submittedClearSecrets, result }) => {
      const editableValue = mergeEditableSettings(
        value,
        submittedForm,
        submittedClearSecrets
      )
      queryClient.setQueryData(['settings'], value)
      queryClient.setQueryData(['settings', 'editor'], editableValue)
      setForm(toSettingsForm(editableValue))
      setClearSecrets([])
      const scenarioLabel =
        result.scenario === 'keyQuality'
          ? '密钥正常率'
          : result.scenario === 'upstreamHealth'
            ? '上游成功率'
            : '账号异常'
      toast.success(
        `${scenarioLabel}测试消息已发送给 ${result.sent} 个接收人`
      )
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const originalForm = useMemo(
    () => (settings.data ? toSettingsForm(settings.data) : null),
    [settings.data]
  )
  const dirty = Boolean(
    form &&
      originalForm &&
      (clearSecrets.length > 0 ||
        JSON.stringify(form) !== JSON.stringify(originalForm))
  )

  useEffect(() => {
    if (!dirty) return undefined
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [dirty])

  if (settings.isError) {
    return (
      <Page>
        <EmptyState
          title='设置加载失败'
          description={getErrorMessage(settings.error)}
        />
      </Page>
    )
  }

  if (settings.isLoading || !settings.data || !form) {
    return (
      <Page>
        <LoadingState label='正在加载运行时配置' />
      </Page>
    )
  }

  const settingsValue = settings.data
  const webhookUrl = registerWebhookUrl()
  const upstream = (health.data?.upstream ?? {}) as Record<string, unknown>
  const integration = (health.data?.integration ?? {}) as Record<
    string,
    unknown
  >
  const registerTokenReady =
    !clearSecrets.includes('grokRegisterWebhookToken') &&
    (Boolean(form.grokRegisterWebhookToken.trim()) ||
      settingsValue.grokRegisterWebhookTokenConfigured)
  const busy =
    saveMutation.isPending ||
    testMutation.isPending ||
    wechatTestMutation.isPending
  const set: SettingsSetter = (key, value) =>
    setForm((current) => (current ? { ...current, [key]: value } : current))

  const restoreRecommendedRiskScoring = () => {
    setForm((current) =>
      current ? { ...current, ...RECOMMENDED_RISK_SCORING } : current
    )
    toast.success('已填入推荐风险评分参数，保存后生效')
  }

  const toggleSecretClear = (name: SecretSettingName) => {
    setClearSecrets((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name]
    )
    const field = name as keyof Pick<
      SettingsForm,
      | 'grok2apiAdminPassword'
      | 'grokRegisterWebhookToken'
      | 'ssoProxy'
      | 'wechatAppSecret'
    >
    set(field, '' as SettingsForm[typeof field])
  }

  const activeSection =
    settingsSections.find(
      (section) =>
        pathname === section.href || pathname.startsWith(`${section.href}/`)
    ) ??
    settingsSections[0]
  const workspaceValue: SettingsWorkspaceValue = {
    form,
    settings: settingsValue,
    clearSecrets,
    set,
    toggleSecretClear,
    profiles: profiles.data ?? [],
    profilesLoading: profiles.isLoading,
    registerTokenReady,
    webhookUrl,
    busy,
    wechatTestPending: wechatTestMutation.isPending,
    testWechat: (scenario) => wechatTestMutation.mutate(scenario),
    restoreRecommendedRiskScoring,
  }

  return (
    <SettingsWorkspaceContext.Provider value={workspaceValue}>
      <Page className='space-y-4'>
        <PageHeader
          title={activeSection.title}
          description={activeSection.description}
          actions={
            <div className='flex items-center gap-2'>
              {dirty && <Badge variant='warning'>有未保存修改</Badge>}
              <ActionToolbar label='系统设置操作'>
                {activeSection.value === 'connection' && (
                  <ToolbarAction
                    label='保存设置并测试 grok2api 连接'
                    disabled={busy}
                    pending={testMutation.isPending}
                    onClick={() => testMutation.mutate()}
                  >
                    <TestTube2 />
                  </ToolbarAction>
                )}
                <ToolbarAction
                  label='保存全部设置并热应用'
                  disabled={busy || !dirty}
                  pending={saveMutation.isPending}
                  onClick={() => saveMutation.mutate()}
                >
                  <Save />
                </ToolbarAction>
              </ActionToolbar>
            </div>
          }
        />

        <Card className='py-0'>
          <CardContent className='grid gap-0 p-0 sm:grid-cols-3'>
            <SettingsStatus
              icon={Network}
              label='grok2api'
              value={upstream.available ? '连接正常' : '连接异常'}
              detail={form.grok2apiBaseUrl}
              healthy={upstream.available === true}
            />
            <SettingsStatus
              icon={KeyRound}
              label='管理鉴权'
              value={integration.adminConfigured ? '已配置' : '待配置'}
              detail='管理员会话自动刷新'
              healthy={integration.adminConfigured === true}
              divided
            />
            <SettingsStatus
              icon={Activity}
              label='任务 Worker'
              value={`${form.probeWorkerConcurrency} 个并发`}
              detail={`队列容量 ${form.probeQueueLimit}`}
              healthy
              divided
            />
          </CardContent>
        </Card>

        <main
          key={activeSection.value}
          className='min-w-0 animate-in fade-in-0 slide-in-from-end-1 duration-150 motion-reduce:animate-none'
        >
          <Outlet />
        </main>
      </Page>
    </SettingsWorkspaceContext.Provider>
  )
}

function SettingsStatus({
  icon: Icon,
  label,
  value,
  detail,
  healthy,
  divided = false,
}: {
  icon: LucideIcon
  label: string
  value: string
  detail: string
  healthy: boolean
  divided?: boolean
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-3 px-4 py-3.5',
        divided && 'border-t sm:border-t-0 sm:border-l'
      )}
    >
      <div
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg',
          healthy
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
        )}
      >
        <Icon className='size-4' />
      </div>
      <div className='min-w-0'>
        <div className='text-[11px] text-muted-foreground'>{label}</div>
        <div className='truncate text-sm font-semibold'>{value}</div>
        <div
          className='truncate text-[11px] text-muted-foreground'
          title={detail}
        >
          {detail}
        </div>
      </div>
    </div>
  )
}

export function SettingsRouteContent({ children }: { children: ReactNode }) {
  return <div className='min-w-0 space-y-4'>{children}</div>
}
