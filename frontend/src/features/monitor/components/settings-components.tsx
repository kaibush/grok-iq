import { useState, type ReactNode } from 'react'
import {
  ArrowRight,
  Copy,
  Eye,
  EyeOff,
  Send,
  Webhook,
  type Database,
  type MessageSquareText,
  type Network,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, type RuntimeSettings, type SecretSettingName } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { cn, getErrorMessage } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NumericInput } from '@/components/numeric-input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { InfoTooltip } from '@/components/info-tooltip'
import { TitledCard } from '@/components/titled-card'
import {
  REGISTER_CALLBACK_EXAMPLE_BODY,
  REGISTER_WEBHOOK_MINIMAL_BODY,
  REGISTER_WEBHOOK_RECOMMENDED_BODY,
  secretMetadata,
} from './settings-model'

export function SettingsCard({
  icon: Icon,
  title,
  description,
  descriptionAsHint = false,
  className,
  children,
}: {
  icon: typeof Network
  title: string
  description: string
  descriptionAsHint?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <TitledCard
      className={className}
      icon={<Icon />}
      title={title}
      description={descriptionAsHint ? undefined : description}
      hint={descriptionAsHint ? description : undefined}
    >
      {children}
    </TitledCard>
  )
}

export function IntegrationFlow({
  tokenConfigured,
  automaticProbe,
  priorityHold,
  callbackEnabled,
}: {
  tokenConfigured: boolean
  automaticProbe: boolean
  priorityHold: boolean
  callbackEnabled: boolean
}) {
  const holdActive = tokenConfigured && automaticProbe && priorityHold
  const callbackActive = tokenConfigured && callbackEnabled
  const steps = [
    {
      label: '注册完成',
      detail: 'grok-register 投递导入事件',
      active: true,
    },
    {
      label: '安全接收',
      detail: tokenConfigured ? '令牌校验并写入收件箱' : '等待配置联动令牌',
      active: tokenConfigured,
    },
    {
      label: '降低优先级',
      detail: holdActive
        ? '先隔离未验证账号的生产流量'
        : automaticProbe
          ? '保持 grok2api 原优先级'
          : '开启自动探针后生效',
      active: holdActive,
    },
    {
      label: '首次探针',
      detail: automaticProbe ? '稳定等待后自动入队' : '仅持久接收事件',
      active: tokenConfigured && automaticProbe,
    },
    {
      label: '恢复优先级',
      detail: holdActive
        ? '探针通过后恢复原值，失败则保持低优先级'
        : '无需调整上游优先级',
      active: holdActive,
    },
    {
      label: '回调通知',
      detail: callbackActive
        ? '检测完成后向注册机发送异步回调通知'
        : '开启回调通知后异步告知注册机',
      active: callbackActive,
    },
  ]

  return (
    <div className='rounded-xl bg-muted/20 p-3 md:p-4'>
      <div className='mb-3 flex items-center justify-between gap-3'>
        <div className='text-xs font-medium text-muted-foreground'>
          导入链路
        </div>
        <span className='text-xs text-muted-foreground'>
          接收成功即与注册机解耦
        </span>
      </div>
      <ol className='grid gap-2 sm:grid-cols-2 xl:grid-cols-6'>
        {steps.map((step, index) => (
          <li
            key={step.label}
            className={cn(
              'min-w-0 rounded-lg px-3 py-3',
              step.active
                ? 'bg-background shadow-xs ring-1 ring-primary/15'
                : 'bg-muted/30 ring-1 ring-border/60'
            )}
          >
            <div
              className={cn(
                'text-[11px] font-medium tabular-nums',
                step.active ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {index + 1}
            </div>
            <div className='mt-1 truncate text-sm font-medium'>{step.label}</div>
            <p className='mt-1 text-[11px] leading-5 text-muted-foreground'>
              {step.detail}
            </p>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function WebhookContractDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type='button'
          className='group flex min-w-0 items-center gap-3 rounded-xl border bg-muted/15 p-3.5 text-start transition-colors hover:border-primary/30 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          aria-label='查看 Webhook 协议'
        >
          <div className='flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary'>
            <Webhook className='size-4' />
          </div>
          <div className='min-w-0 flex-1'>
            <div className='text-sm font-medium'>查看 Webhook 协议</div>
            <div className='mt-0.5 truncate text-xs text-muted-foreground'>
              POST /account-imported · 注册机导入账号
            </div>
          </div>
          <ArrowRight className='size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground' />
        </button>
      </DialogTrigger>
      <DialogContent size='wide' className='gap-0 overflow-hidden p-0 sm:p-0'>
        <DialogHeader className='border-b bg-muted/15 px-5 py-4 pe-14 sm:px-6 sm:py-5 sm:pe-14'>
          <DialogTitle>Webhook 协议</DialogTitle>
          <DialogDescription>
            注册机向 GrokIQ 投递账号导入事件。POST JSON；必填字段只有 email，获取到 SSO 时建议一并传入。
          </DialogDescription>
        </DialogHeader>
        <div className='min-h-0 overflow-y-auto'>
          <WebhookContract />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function WebhookContract() {
  const copyBody = (body: string, label: string) =>
    void copyText(body)
      .then(() => toast.success(`已复制${label}`))
      .catch((error) => toast.error(getErrorMessage(error)))

  const optionalFields = [
    {
      name: 'event_id',
      type: 'string',
      description: '推荐传入；重试时保持不变，用于幂等去重。省略时按邮箱生成。',
    },
    {
      name: 'event_type',
      type: 'string',
      description: '事件类型，默认 grok2api.account_imported。',
    },
    {
      name: 'registration_id',
      type: 'string',
      description: '调用方自己的注册记录 ID。',
    },
    {
      name: 'grok2api_account_id',
      type: 'integer',
      description: '已知时可传；未知时监控端按邮箱精确匹配。',
    },
    {
      name: 'sso',
      type: 'string',
      description:
        '原始 SSO，供账号中心检测使用；支持裸 token、sso= 前缀或 email----token。获取失败时可省略或传空字符串。',
    },
    {
      name: 'bot_risk',
      type: 'boolean',
      description: '注册阶段是否发现风控，默认 false。',
    },
    {
      name: 'bfs',
      type: 'string | integer',
      description:
        '注册阶段的 bfs 风控值。bot_risk 为 true 且 bfs 为 1 或 2 时视为确认降智，接入后立即永久停用。',
    },
    {
      name: 'occurred_at',
      type: 'string',
      description: '事件发生时间，建议使用 ISO 8601。',
    },
  ]

  return (
    <section className='bg-background'>
      <div className='flex flex-col gap-2 border-b bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6'>
        <p className='text-xs leading-5 text-muted-foreground'>
          调用方使用相同令牌请求 Webhook；示例内容可分别复制。
        </p>
        <div className='flex flex-wrap gap-2 text-xs'>
          <Badge variant='outline'>POST</Badge>
          <Badge variant='outline'>Content-Type: application/json</Badge>
          <Badge variant='outline'>x-grokiq-token: 联动令牌</Badge>
        </div>
      </div>

      <div className='grid gap-0 divide-y'>
        <WebhookBodyExample
          title='最小请求体'
          description='适合简单调用方，监控端自动生成事件 ID。'
          body={REGISTER_WEBHOOK_MINIMAL_BODY}
          onCopy={() => copyBody(REGISTER_WEBHOOK_MINIMAL_BODY, '最小请求体')}
        />
        <WebhookBodyExample
          title='推荐请求体'
          description='传入稳定 event_id，并在注册机已获取 SSO 时携带原始值。'
          body={REGISTER_WEBHOOK_RECOMMENDED_BODY}
          onCopy={() =>
            copyBody(REGISTER_WEBHOOK_RECOMMENDED_BODY, '推荐请求体')
          }
        />
      </div>

      <div className='border-t px-4 py-3 sm:px-6'>
        <div className='mb-2 text-xs font-medium'>可选字段</div>
        <div className='grid gap-x-5 gap-y-2 md:grid-cols-2'>
          {optionalFields.map((field) => (
            <div
              key={field.name}
              className='grid min-w-0 grid-cols-[minmax(7rem,auto)_1fr] gap-3 text-xs leading-5'
            >
              <div className='min-w-0'>
                <code className='font-mono break-all text-foreground'>
                  {field.name}
                </code>
                <div className='text-[11px] text-muted-foreground'>
                  {field.type}
                </div>
              </div>
              <p className='text-muted-foreground'>{field.description}</p>
            </div>
          ))}
        </div>
        <p className='mt-3 border-t pt-3 text-xs leading-5 text-muted-foreground'>
          返回 HTTP 202
          表示事件已持久接收；账号匹配、重试和探针执行随后在后台完成。
        </p>
      </div>
    </section>
  )
}

export function NotifyContractDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type='button'
          className='group flex min-w-0 items-center gap-3 rounded-xl border bg-muted/15 p-3.5 text-start transition-colors hover:border-primary/30 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          aria-label='查看回调协议'
        >
          <div className='flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary'>
            <Send className='size-4' />
          </div>
          <div className='min-w-0 flex-1'>
            <div className='text-sm font-medium'>查看回调协议</div>
            <div className='mt-0.5 truncate text-xs text-muted-foreground'>
              POST /notify · 检测结果回传注册机
            </div>
          </div>
          <ArrowRight className='size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground' />
        </button>
      </DialogTrigger>
      <DialogContent size='wide' className='gap-0 overflow-hidden p-0 sm:p-0'>
        <DialogHeader className='border-b bg-muted/15 px-5 py-4 pe-14 sm:px-6 sm:py-5 sm:pe-14'>
          <DialogTitle>回调协议</DialogTitle>
          <DialogDescription>
            类似支付异步通知。GrokIQ 检测完成后向注册机 POST，注册机返回 2xx 即表示已接收。
          </DialogDescription>
        </DialogHeader>
        <div className='min-h-0 overflow-y-auto'>
          <NotifyContract />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function NotifyContract() {
  const copyBody = (body: string, label: string) =>
    void copyText(body)
      .then(() => toast.success(`已复制${label}`))
      .catch((error) => toast.error(getErrorMessage(error)))

  const fields = [
    {
      name: 'event_id',
      type: 'string',
      description: '与导入 Webhook 相同的事件 ID，用于幂等；每个导入事件只通知一次终态。',
    },
    {
      name: 'event_type',
      type: 'string',
      description: '固定为 grokiq.notify。',
    },
    {
      name: 'registration_id',
      type: 'string',
      description: '注册机自己的账号记录 ID；接收方应优先按此匹配。',
    },
    {
      name: 'email',
      type: 'string',
      description: '账号邮箱；registration_id 匹配失败时按邮箱匹配。',
    },
    {
      name: 'account_id',
      type: 'integer | null',
      description: 'GrokIQ / grok2api 账号 ID。',
    },
    {
      name: 'occurred_at',
      type: 'string',
      description: '通知时间，ISO 8601。',
    },
    {
      name: 'degraded',
      type: 'boolean',
      description: '是否降智。注册机应以此字段为准处理账号。',
    },
    {
      name: 'verdict',
      type: 'string',
      description:
        'normal、degraded、suspect、high_risk、quarantined、insufficient_samples、probe_failed、imported。',
    },
    {
      name: 'monitor_status',
      type: 'string',
      description: 'GrokIQ 当前监控状态，例如 healthy、high_risk、quarantined。',
    },
    {
      name: 'risk_score',
      type: 'number',
      description: '风险分。',
    },
    {
      name: 'risk_reasons',
      type: 'string[]',
      description: '风险原因摘要。',
    },
    {
      name: 'isolated',
      type: 'boolean',
      description: '是否已隔离。',
    },
    {
      name: 'probe_outcome',
      type: 'string',
      description:
        'passed、failed、insufficient、empty、skipped、confirmed_degraded。',
    },
    {
      name: 'run_ids',
      type: 'string[]',
      description: '本次注册探针任务 ID。',
    },
    {
      name: 'source',
      type: 'string',
      description: 'register_probe 表示探针结论；grok-register 表示注册机确认降智。',
    },
  ]

  return (
    <section className='bg-background'>
      <div className='flex flex-col gap-2 border-b bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6'>
        <p className='text-xs leading-5 text-muted-foreground'>
          开启回调通知并填写通知地址后，GrokIQ 在确认降智或注册探针结束后投递；失败会写入 Outbox 退避重试。
        </p>
        <div className='flex flex-wrap gap-2 text-xs'>
          <Badge variant='outline'>POST /api/integrations/grokiq/notify</Badge>
          <Badge variant='outline'>Content-Type: application/json</Badge>
          <Badge variant='outline'>x-grokiq-token: 联动令牌</Badge>
        </div>
      </div>

      <WebhookBodyExample
        title='回调通知请求体'
        description='注册机返回 HTTP 2xx 表示已接收。处理时读取 degraded，不要自动删号。'
        body={REGISTER_CALLBACK_EXAMPLE_BODY}
        onCopy={() => copyBody(REGISTER_CALLBACK_EXAMPLE_BODY, '回调通知请求体')}
      />

      <div className='border-t px-4 py-3 sm:px-6'>
        <div className='mb-2 text-xs font-medium'>字段说明</div>
        <div className='grid gap-x-5 gap-y-2 md:grid-cols-2'>
          {fields.map((field) => (
            <div
              key={field.name}
              className='grid min-w-0 grid-cols-[minmax(7rem,auto)_1fr] gap-3 text-xs leading-5'
            >
              <div className='min-w-0'>
                <code className='font-mono break-all text-foreground'>
                  {field.name}
                </code>
                <div className='text-[11px] text-muted-foreground'>
                  {field.type}
                </div>
              </div>
              <p className='text-muted-foreground'>{field.description}</p>
            </div>
          ))}
        </div>
        <p className='mt-3 border-t pt-3 text-xs leading-5 text-muted-foreground'>
          触发时机：注册机确认降智（bot_risk 且 bfs 为 1/2）后立即通知；否则等该导入事件的注册探针全部结束后再通知。关闭注册后探针时，导入完成也会通知一次。
        </p>
      </div>
    </section>
  )
}

function WebhookBodyExample({
  title,
  description,
  body,
  onCopy,
}: {
  title: string
  description: string
  body: string
  onCopy: () => void
}) {
  return (
    <div className='min-w-0 p-4'>
      <div className='mb-3 flex items-start justify-between gap-3'>
        <div>
          <div className='text-xs font-medium'>{title}</div>
          <p className='mt-1 text-xs leading-5 text-muted-foreground'>
            {description}
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className='size-8 shrink-0'
              onClick={onCopy}
              aria-label={`复制${title}`}
            >
              <Copy />
            </Button>
          </TooltipTrigger>
          <TooltipContent>复制请求体</TooltipContent>
        </Tooltip>
      </div>
      <pre className='max-w-full overflow-x-auto rounded-lg bg-muted/45 p-3 font-mono text-xs leading-5 text-foreground'>
        <code>{body}</code>
      </pre>
    </div>
  )
}

export function IntegrationPanel({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Network
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className='rounded-xl border bg-background p-4 md:p-5'>
      <div className='mb-4 flex items-start gap-3 border-b pb-4'>
        <div className='flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary'>
          <Icon className='size-4' />
        </div>
        <div className='min-w-0'>
          <h3 className='text-sm font-semibold'>{title}</h3>
          <p className='mt-1 text-xs leading-5 text-muted-foreground'>
            {description}
          </p>
        </div>
      </div>
      <div className='min-w-0'>{children}</div>
    </section>
  )
}

export function FixedProbeSetting({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof MessageSquareText
  label: string
  value: string
}) {
  return (
    <div className='flex min-h-20 min-w-0 items-center gap-3 rounded-lg bg-muted/20 px-4 py-3'>
      <div className='flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground'>
        <Icon className='size-4' />
      </div>
      <div className='min-w-0'>
        <div className='text-[11px] text-muted-foreground'>{label}</div>
        <div className='mt-1 text-sm font-medium break-words'>{value}</div>
      </div>
    </div>
  )
}

export function BootstrapSetting({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className='min-w-0 rounded-lg border bg-muted/[0.12] px-3 py-3'>
      <div className='text-[11px] font-medium text-muted-foreground'>
        {label}
      </div>
      <div
        className={cn(
          'mt-1.5 text-sm font-medium break-all',
          mono && 'font-mono text-xs leading-5'
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`space-y-2 ${className}`}>
      <div className='flex min-h-5 items-center gap-1.5'>
        <Label>{label}</Label>
        {hint && <InfoTooltip label={label} content={hint} />}
      </div>
      {children}
    </div>
  )
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
  hint,
  suffix,
  displayMultiplier = 1,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  hint?: string
  suffix?: string
  displayMultiplier?: number
}) {
  return (
    <Field label={label} hint={hint}>
      <div className='relative'>
        <NumericInput
          value={value * displayMultiplier}
          min={min === undefined ? undefined : min * displayMultiplier}
          max={max === undefined ? undefined : max * displayMultiplier}
          step={step * displayMultiplier}
          disabled={disabled}
          className={suffix ? 'pr-9' : undefined}
          onChange={(next) => onChange(next / displayMultiplier)}
        />
        {suffix && (
          <span className='pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-muted-foreground'>
            {suffix}
          </span>
        )}
      </div>
    </Field>
  )
}

export function RiskFieldGroup({
  title,
  hint,
  divided = false,
  children,
}: {
  title: string
  hint: string
  divided?: boolean
  children: ReactNode
}) {
  return (
    <section className={cn(divided && 'border-t pt-5')}>
      <div className='mb-3 flex items-center gap-1.5'>
        <h3 className='text-xs font-semibold tracking-wide text-muted-foreground uppercase'>
          {title}
        </h3>
        <InfoTooltip label={title} content={hint} />
      </div>
      <div className='grid gap-4 sm:grid-cols-2'>{children}</div>
    </section>
  )
}

export function RiskStatusRule({
  status,
  description,
  tone,
  divided = false,
}: {
  status: string
  description: string
  tone: 'warning' | 'danger'
  divided?: boolean
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-3 px-4 py-3.5',
        divided && 'border-t'
      )}
    >
      <Badge variant={tone === 'warning' ? 'warning' : 'destructive'}>
        {status}
      </Badge>
      <span className='text-xs leading-5 text-muted-foreground'>
        {description}
      </span>
    </div>
  )
}

export function RiskFactorRow({
  title,
  description,
  weight,
  cap,
  onWeightChange,
  onCapChange,
  automaticCap = false,
}: {
  title: string
  description: string
  weight: number
  cap?: number
  onWeightChange: (value: number) => void
  onCapChange?: (value: number) => void
  automaticCap?: boolean
}) {
  return (
    <div className='grid gap-3 border-b px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_9rem_9rem] md:items-center md:gap-4'>
      <div className='flex min-w-0 items-center gap-1.5'>
        <span className='text-sm font-medium'>{title}</span>
        <InfoTooltip label={title} content={description} />
      </div>
      <div>
        <div className='mb-1.5 text-[11px] text-muted-foreground md:hidden'>
          {automaticCap ? '满占比得分' : '每次加分'}
        </div>
        <NumericInput
          value={weight}
          min={0}
          max={100}
          step={0.1}
          aria-label={`${title}${automaticCap ? '满占比得分' : '每次加分'}`}
          onChange={onWeightChange}
        />
      </div>
      <div>
        <div className='mb-1.5 text-[11px] text-muted-foreground md:hidden'>
          最多计分
        </div>
        {automaticCap ? (
          <div className='flex h-9 items-center rounded-md border bg-muted/35 px-3 text-xs text-muted-foreground'>
            同左侧
          </div>
        ) : (
          <NumericInput
            value={cap}
            min={0}
            max={100}
            step={0.1}
            aria-label={`${title}最多计分`}
            onChange={(next) => onCapChange?.(next)}
          />
        )}
      </div>
    </div>
  )
}

export function RiskScoreField({
  label,
  hint,
  tone,
  value,
  min = 0,
  onChange,
}: {
  label: string
  hint: string
  tone: 'default' | 'warning' | 'danger'
  value: number
  min?: number
  onChange: (value: number) => void
}) {
  return (
    <div className='overflow-hidden rounded-lg border'>
      <div
        className={cn(
          'px-3 py-2 text-xs font-medium',
          tone === 'warning' &&
            'bg-amber-500/10 text-amber-700 dark:text-amber-300',
          tone === 'danger' && 'bg-destructive/10 text-destructive',
          tone === 'default' && 'bg-muted/45 text-foreground'
        )}
      >
        <span className='flex items-center gap-1.5'>
          {label}
          <InfoTooltip label={label} content={hint} />
        </span>
      </div>
      <div className='p-2'>
        <NumericInput
          value={value}
          min={min}
          max={100}
          step={0.1}
          aria-label={label}
          onChange={onChange}
        />
      </div>
    </div>
  )
}

export function SecretField({
  name,
  value,
  settings,
  clearing,
  onChange,
  onToggleClear,
}: {
  name: SecretSettingName
  value: string
  settings: RuntimeSettings
  clearing: boolean
  onChange: (value: string) => void
  onToggleClear: () => void
}) {
  const metadata = secretMetadata[name]
  const configured = Boolean(settings[metadata.configuredKey])
  const [visible, setVisible] = useState(false)
  const [revealing, setRevealing] = useState(false)

  const toggleVisibility = async () => {
    if (visible) {
      setVisible(false)
      return
    }
    if (value || !configured) {
      setVisible(true)
      return
    }
    setRevealing(true)
    try {
      const secret = await api.revealSettingSecret(name)
      onChange(secret.value)
      setVisible(true)
    } catch (error) {
      toast.error(getErrorMessage(error))
    } finally {
      setRevealing(false)
    }
  }

  return (
    <Field
      label={metadata.label}
      hint='已保存值会以密码形式载入；点击显示图标查看，留空会保留当前值'
    >
      <div className='flex gap-2'>
        <div className='relative min-w-0 flex-1'>
          <Input
            type={visible ? 'text' : 'password'}
            value={value}
            disabled={clearing}
            onChange={(event) => onChange(event.target.value)}
            placeholder={clearing ? '保存后清除当前值' : metadata.placeholder}
            autoComplete='new-password'
            className='pr-10'
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type='button'
                size='icon'
                variant='ghost'
                disabled={clearing || revealing}
                className='absolute inset-e-1 top-1/2 size-7 -translate-y-1/2 rounded-md text-muted-foreground'
                onClick={() => void toggleVisibility()}
                aria-label={visible ? '隐藏当前输入内容' : '显示当前输入内容'}
              >
                {visible ? <EyeOff /> : <Eye />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {visible ? '隐藏当前输入内容' : '显示当前输入内容'}
            </TooltipContent>
          </Tooltip>
        </div>
        <Button
          type='button'
          variant={clearing ? 'destructive' : 'outline'}
          className='shrink-0'
          onClick={onToggleClear}
        >
          {clearing ? '撤销清除' : '清除'}
        </Button>
      </div>
      <Badge
        variant={
          clearing ? 'destructive' : configured ? 'success' : 'secondary'
        }
      >
        {clearing ? '待清除' : configured ? '已配置' : '未配置'}
      </Badge>
    </Field>
  )
}

export function SettingList({ children }: { children: ReactNode }) {
  return (
    <div className='divide-y overflow-hidden rounded-xl border bg-background'>
      {children}
    </div>
  )
}

export function SettingListItem({
  label,
  description,
  checked,
  disabled = false,
  onCheckedChange,
  children,
}: {
  label: string
  description?: string
  checked?: boolean
  disabled?: boolean
  onCheckedChange?: (value: boolean) => void
  children?: ReactNode
}) {
  return (
    <div className={cn('space-y-3 p-4', disabled && 'bg-muted/10')}>
      <div className='flex items-start justify-between gap-4'>
        <div className='min-w-0'>
          <div className='text-sm font-medium'>{label}</div>
          {description ? (
            <p className='mt-1 text-xs leading-5 text-muted-foreground'>
              {description}
            </p>
          ) : null}
        </div>
        {onCheckedChange ? (
          <Switch
            checked={Boolean(checked)}
            disabled={disabled}
            onCheckedChange={onCheckedChange}
            aria-label={label}
          />
        ) : null}
      </div>
      {children}
    </div>
  )
}

export function SwitchRow({
  label,
  description,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (value: boolean) => void
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 rounded-lg border p-3',
        disabled && 'bg-muted/20 text-muted-foreground'
      )}
    >
      <div>
        <div className='flex items-center gap-1.5 text-sm font-medium'>
          {label}
          <InfoTooltip label={label} content={description} />
        </div>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

export function StatusCard({
  icon: Icon,
  label,
  value,
  detail,
  healthy,
}: {
  icon: typeof Network
  label: string
  value: string
  detail: string
  healthy: boolean
}) {
  return (
    <Card>
      <CardContent className='flex items-start gap-3 p-4'>
        <div
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
            healthy
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
          }`}
        >
          <Icon className='size-4' />
        </div>
        <div className='min-w-0'>
          <div className='text-xs text-muted-foreground'>{label}</div>
          <div className='mt-0.5 text-sm font-semibold'>{value}</div>
          <div
            className='mt-1 truncate text-xs text-muted-foreground'
            title={detail}
          >
            {detail}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function Boundary({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Database
  title: string
  text: string
}) {
  return (
    <div className='rounded-lg border bg-background p-3'>
      <Icon className='size-4 text-primary' />
      <div className='mt-2 text-sm font-semibold'>{title}</div>
      <p className='mt-1 text-xs leading-5 text-muted-foreground'>{text}</p>
    </div>
  )
}
