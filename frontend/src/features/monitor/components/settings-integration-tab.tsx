import {
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  KeyRound,
  Layers3,
  MessageSquareText,
  Power,
  Send,
  ShieldCheck,
  Webhook,
  Workflow,
} from 'lucide-react'
import { toast } from 'sonner'
import { IconGithub } from '@/assets/brand-icons'
import type {
  ProbeProfile,
  RuntimeSettings,
  SecretSettingName,
} from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { cn, getErrorMessage } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NumericInput } from '@/components/numeric-input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ProfileMultiSelect } from '@/features/monitor/components/profile-multi-select'
import {
  Field,
  FixedProbeSetting,
  IntegrationFlow,
  NotifyContractDialog,
  NumberField,
  SecretField,
  SettingList,
  SettingListItem,
  SettingsCard,
  WebhookContractDialog,
} from './settings-components'
import {
  GROK_REGISTER_REPOSITORY_URL,
  REGISTER_CALLBACK_PLACEHOLDER_URL,
  moveOrderedId,
  syncRegisterProbeProfileRounds,
  type SettingsForm,
  type SettingsSetter,
} from './settings-model'

export function SettingsIntegrationTab({
  form,
  settings,
  clearSecrets,
  profiles,
  profilesLoading,
  registerTokenReady,
  webhookUrl,
  set,
  toggleSecretClear,
}: {
  form: SettingsForm
  settings: RuntimeSettings
  clearSecrets: SecretSettingName[]
  profiles: ProbeProfile[]
  profilesLoading: boolean
  registerTokenReady: boolean
  webhookUrl: string
  set: SettingsSetter
  toggleSecretClear: (name: SecretSettingName) => void
}) {
  const automaticProbe = form.initialProbeOnRegister
  const priorityHold = automaticProbe && form.registerPriorityHoldEnabled
  const statusLabel = !registerTokenReady
    ? '等待配置令牌'
    : automaticProbe
      ? '自动探针已开启'
      : '仅接收事件'
  const statusVariant = !registerTokenReady
    ? 'warning'
    : automaticProbe
      ? 'success'
      : 'secondary'

  return (
    <Tabs defaultValue='register' className='space-y-4'>
      <TabsList className='h-auto w-full justify-start overflow-x-auto sm:w-fit'>
        <TabsTrigger value='register'>
          <Webhook />
          注册接入
        </TabsTrigger>
        <TabsTrigger value='import'>
          <Workflow />
          导入探针
        </TabsTrigger>
      </TabsList>

      <TabsContent value='register' className='mt-0 space-y-4'>
      <SettingsCard
        icon={Webhook}
        title='grok-register 自动联动'
        description='注册完成后自动投递账号导入事件，由监控端完成持久接收、账号匹配与首次探针调度。'
      >
        <div className='space-y-4'>
          <div className='flex flex-wrap items-center gap-2'>
            <Badge variant={statusVariant}>
              <Power />
              {statusLabel}
            </Badge>
            {priorityHold ? (
              <Badge variant='info'>导入后先降权</Badge>
            ) : null}
          </div>

          <a
            href={GROK_REGISTER_REPOSITORY_URL}
            target='_blank'
            rel='noopener noreferrer'
            className='group flex min-w-0 items-center gap-3 rounded-xl border bg-muted/15 p-3.5 transition-colors hover:border-primary/30 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
            aria-label='在 GitHub 新标签页打开 grok-register 项目'
          >
            <div className='flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background'>
              <IconGithub className='size-4' />
            </div>
            <div className='min-w-0 flex-1'>
              <div className='text-sm font-medium'>查看配套注册项目</div>
              <div className='mt-0.5 truncate text-xs text-muted-foreground'>
                github.com/kaibush/grok-register
              </div>
            </div>
            <ExternalLink className='size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground' />
          </a>

          <div className='grid gap-2 md:grid-cols-2'>
            <WebhookContractDialog />
            <NotifyContractDialog />
          </div>

          <IntegrationFlow
            tokenConfigured={registerTokenReady}
            automaticProbe={automaticProbe}
            priorityHold={form.registerPriorityHoldEnabled}
            callbackEnabled={form.registerCallbackEnabled}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        icon={KeyRound}
        title='接入配置'
        description='令牌与 Webhook 地址用于建立两个项目之间的安全连接。'
      >
        <div className='grid gap-4 lg:grid-cols-2'>
          <SecretField
            name='grokRegisterWebhookToken'
            value={form.grokRegisterWebhookToken}
            settings={settings}
            clearing={clearSecrets.includes('grokRegisterWebhookToken')}
            onChange={(value) => set('grokRegisterWebhookToken', value)}
            onToggleClear={() => toggleSecretClear('grokRegisterWebhookToken')}
          />
          <Field
            label='Webhook 接收地址'
            hint='复制完整地址到注册机；请求头：x-grokiq-token'
          >
            <div className='flex h-9 min-w-0 items-center rounded-md border bg-muted/25 pl-3'>
              <code
                className='min-w-0 flex-1 truncate text-xs text-muted-foreground'
                title={webhookUrl}
              >
                {webhookUrl}
              </code>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type='button'
                    size='icon'
                    variant='ghost'
                    className='size-8 shrink-0 rounded-sm'
                    onClick={() =>
                      void copyText(webhookUrl)
                        .then(() => toast.success('已复制完整 Webhook 地址'))
                        .catch((error) => toast.error(getErrorMessage(error)))
                    }
                    aria-label='复制完整 Webhook 地址'
                  >
                    <Copy />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>复制完整地址</TooltipContent>
              </Tooltip>
            </div>
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={Send}
        title='检测回调通知'
        description='类似支付异步通知：探针结束或确认降智后，向注册机 POST 回调通知，方便注册侧处理降智账号。'
      >
        <div className='space-y-4'>
          <SettingList>
            <SettingListItem
              label='启用回调通知'
              description='与导入 Webhook 共用联动令牌。每个导入事件只发送一次终态回调通知；失败会写入 Outbox 并退避重试。'
              checked={form.registerCallbackEnabled}
              onCheckedChange={(value) => set('registerCallbackEnabled', value)}
            >
              <div className='grid gap-4 md:grid-cols-2'>
                <Field
                  label='通知地址'
                  hint='对应支付系统的 notify_url。统一 Compose 内使用 grok-register 容器名。'
                >
                  <Input
                    value={form.registerCallbackUrl}
                    placeholder={REGISTER_CALLBACK_PLACEHOLDER_URL}
                    disabled={!form.registerCallbackEnabled}
                    onChange={(event) =>
                      set('registerCallbackUrl', event.target.value)
                    }
                  />
                </Field>
                <NumberField
                  label='请求超时'
                  hint='单次投递超时；失败后由持久 Outbox 退避重试。'
                  value={form.registerCallbackTimeoutSeconds}
                  min={1}
                  max={60}
                  step={1}
                  suffix='秒'
                  disabled={!form.registerCallbackEnabled}
                  onChange={(value) =>
                    set('registerCallbackTimeoutSeconds', value)
                  }
                />
              </div>
            </SettingListItem>
          </SettingList>
        </div>
      </SettingsCard>
      </TabsContent>

      <TabsContent value='import' className='mt-0 space-y-4'>
      <SettingsCard
        icon={Workflow}
        title='导入后处理'
        description='匹配到 grok2api 账号后，按顺序执行降权、稳定等待、首次探针和通过后恢复。'
      >
        <SettingList>
          <SettingListItem
            label='注册后创建探针'
            description='匹配账号后按稳定窗口等待，再补齐出口并加入持久队列。关闭后只接收导入事件。'
            checked={form.initialProbeOnRegister}
            onCheckedChange={(value) => set('initialProbeOnRegister', value)}
          >
            <div className='max-w-xs'>
              <NumberField
                label='新账号稳定等待'
                hint='Webhook 接收后延迟创建首次探针，用于等待模型权限传播；设为 0 可关闭。账号实际冷却时间仍会优先。'
                value={form.registerProbeStabilizationSeconds}
                min={0}
                max={300}
                step={1}
                suffix='秒'
                disabled={!automaticProbe}
                onChange={(value) =>
                  set('registerProbeStabilizationSeconds', value)
                }
              />
            </div>
          </SettingListItem>
          <SettingListItem
            label='注册后降低 grok2api 优先级'
            description='匹配到新账号后立即降低上游路由优先级，避免未验证账号进入生产流量。全部注册探针通过后恢复原值；恢复失败由联动后台定时重试，探针未通过则保持低优先级。'
            checked={form.registerPriorityHoldEnabled}
            disabled={!automaticProbe}
            onCheckedChange={(value) =>
              set('registerPriorityHoldEnabled', value)
            }
          >
            {priorityHold ? (
              <div className='max-w-xs'>
                <NumberField
                  label='注册账号临时优先级'
                  hint='需低于普通账号，默认 -1000000。探针通过后恢复为导入时记录的原值。'
                  value={form.registerPriorityHold}
                  min={-2000000000}
                  max={0}
                  step={1}
                  onChange={(value) => set('registerPriorityHold', value)}
                />
              </div>
            ) : null}
          </SettingListItem>
          <SettingListItem
            label='降智后换出口再测'
            description='注册探针出现降智信号后，自动改绑到另一个健康出口并再创建一个任务；已用过的出口不会重复选择。有可用替代出口时，自动隔离会延后到续测链结束。'
            checked={form.registerProbeSwitchOnDegradation}
            disabled={!automaticProbe}
            onCheckedChange={(value) =>
              set('registerProbeSwitchOnDegradation', value)
            }
          />
        </SettingList>
      </SettingsCard>

      <SettingsCard
        icon={Layers3}
        title='首次探针策略'
        description='选择新账号导入后使用的探针方案，并为每个方案单独设置执行轮次和顺序；同一账号会按此顺序串行执行。执行方式和出口策略保持固定。'
        className={cn(!automaticProbe && 'opacity-70')}
      >
        <div className='space-y-4'>
          <Field
            label='探针方案'
            hint='可多选；选择顺序即执行顺序，也可在下方列表调整。每个方案分别生成一个持久任务。'
          >
            <ProfileMultiSelect
              profiles={profiles}
              value={form.registerProbeProfileIds}
              onChange={(value) => {
                set('registerProbeProfileIds', value)
                set(
                  'registerProbeProfileRounds',
                  syncRegisterProbeProfileRounds(
                    value,
                    form.registerProbeProfileRounds,
                    form.registerProbeRounds
                  )
                )
              }}
              enabledOnly
              disabled={profilesLoading || !automaticProbe}
              invalid={automaticProbe && !form.registerProbeProfileIds.length}
            />
          </Field>
          <Field
            label='各方案执行轮数'
            hint='每个选中方案单独设置 1–20 轮。使用上下箭头调整执行顺序，同一账号按此顺序串行执行。'
          >
            {form.registerProbeProfileIds.length ? (
              <div className='space-y-2'>
                {form.registerProbeProfileIds.map((profileId, index) => {
                  const profile = profiles.find((item) => item.id === profileId)
                  const canMove = !profilesLoading && automaticProbe
                  return (
                    <div
                      key={profileId}
                      className='flex items-center justify-between gap-3 rounded-lg border bg-muted/15 px-3 py-2.5'
                    >
                      <div className='flex min-w-0 flex-1 items-center gap-3'>
                        <div className='flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium text-muted-foreground'>
                          {index + 1}
                        </div>
                        <div className='min-w-0'>
                          <div className='truncate text-sm font-medium'>
                            {profile?.name || profileId}
                          </div>
                          <div className='truncate font-mono text-[11px] text-muted-foreground'>
                            {profileId}
                          </div>
                        </div>
                      </div>
                      <div className='flex shrink-0 items-center gap-1'>
                        <Button
                          type='button'
                          size='icon'
                          variant='ghost'
                          className='size-7'
                          disabled={!canMove || index === 0}
                          aria-label={`将 ${profile?.name || profileId} 上移`}
                          onClick={() =>
                            set(
                              'registerProbeProfileIds',
                              moveOrderedId(
                                form.registerProbeProfileIds,
                                profileId,
                                -1
                              )
                            )
                          }
                        >
                          <ChevronUp className='size-3.5' />
                        </Button>
                        <Button
                          type='button'
                          size='icon'
                          variant='ghost'
                          className='size-7'
                          disabled={
                            !canMove ||
                            index === form.registerProbeProfileIds.length - 1
                          }
                          aria-label={`将 ${profile?.name || profileId} 下移`}
                          onClick={() =>
                            set(
                              'registerProbeProfileIds',
                              moveOrderedId(
                                form.registerProbeProfileIds,
                                profileId,
                                1
                              )
                            )
                          }
                        >
                          <ChevronDown className='size-3.5' />
                        </Button>
                      </div>
                      <div className='relative w-24 shrink-0'>
                        <NumericInput
                          min={1}
                          max={20}
                          step={1}
                          disabled={profilesLoading || !automaticProbe}
                          className='pr-8'
                          value={
                            form.registerProbeProfileRounds[profileId] ??
                            form.registerProbeRounds
                          }
                          onChange={(next) =>
                            set('registerProbeProfileRounds', {
                              ...form.registerProbeProfileRounds,
                              [profileId]: next,
                            })
                          }
                        />
                        <span className='pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-muted-foreground'>
                          轮
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className='text-sm text-muted-foreground'>
                先选择探针方案，再为每个方案设置执行轮次和顺序。
              </p>
            )}
          </Field>
          <div className='grid gap-3 sm:grid-cols-2'>
            <FixedProbeSetting
              icon={MessageSquareText}
              label='执行方式'
              value='完整对话'
            />
            <FixedProbeSetting
              icon={ShieldCheck}
              label='出口策略'
              value='账号当前绑定出口'
            />
          </div>
        </div>
      </SettingsCard>
      </TabsContent>
    </Tabs>
  )
}
