import {
  Clock3,
  KeyRound,
  LoaderCircle,
  Network,
  RefreshCw,
  Route,
  ShieldAlert,
  ShieldCheck,
  Undo2,
  UserX,
} from 'lucide-react'
import { type ProbeRun } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

type RestoreStatus =
  | 'not_recorded'
  | 'pending'
  | 'restoring'
  | 'automatic_restored'
  | 'startup_restored'
  | 'manual_restored'
  | 'restore_failed'

const restoreVisuals = {
  pending: {
    label: '等待自动恢复',
    description: '任务已记录账号原设置，结束时会自动恢复。',
    icon: Clock3,
    variant: 'warning',
  },
  restoring: {
    label: '正在恢复',
    description: '正在向 grok2api 同步任务开始前的账号设置。',
    icon: LoaderCircle,
    variant: 'info',
  },
  automatic_restored: {
    label: '自动恢复完成',
    description: '任务已自动恢复账号原设置，无需人工同步。',
    icon: ShieldCheck,
    variant: 'success',
  },
  startup_restored: {
    label: '启动恢复完成',
    description: '服务重启后已自动恢复账号原设置，无需人工同步。',
    icon: RefreshCw,
    variant: 'info',
  },
  manual_restored: {
    label: '人工同步完成',
    description: '账号原设置已由人工同步。',
    icon: Undo2,
    variant: 'secondary',
  },
  restore_failed: {
    label: '需要人工同步',
    description: '自动恢复未完成，请从任务详情同步账号原设置。',
    icon: ShieldAlert,
    variant: 'destructive',
  },
} as const

export function MissingUpstreamIndicator({
  compact = false,
  interactive = true,
}: {
  compact?: boolean
  interactive?: boolean
}) {
  const badge = (
    <Badge
      variant='destructive'
      className={cn(
        'rounded-full p-0',
        compact ? 'size-5 [&>svg]:size-3' : 'size-7'
      )}
      tabIndex={interactive ? 0 : undefined}
      aria-hidden={interactive ? undefined : true}
      aria-label={interactive ? '上游账号已删除' : undefined}
    >
      <UserX />
    </Badge>
  )
  if (!interactive) {
    return (
      <span className='pointer-events-none' title='上游账号已删除'>
        {badge}
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>上游账号已删除</TooltipContent>
    </Tooltip>
  )
}

export function AccountRestoreIndicator({ run }: { run: ProbeRun }) {
  if (!run.account_settings_snapshot_at) return null
  const status = (run.account_restore_status || 'pending') as RestoreStatus
  if (status === 'not_recorded') return null
  const visual = restoreVisuals[status] ?? restoreVisuals.pending
  const Icon = visual.icon
  const attempts = run.account_restore_attempts ?? 0
  const errorDetail = run.account_restore_error
    ? ` 最近错误：${run.account_restore_error}`
    : ''
  const detail = `${visual.description} 恢复尝试 ${attempts} 次。${errorDetail}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={visual.variant}
          className='size-7 rounded-full p-0'
          tabIndex={0}
          aria-label={visual.label}
        >
          <Icon className={cn(status === 'restoring' && 'animate-spin')} />
        </Badge>
      </TooltipTrigger>
      <TooltipContent className='max-w-72'>
        <div className='font-medium'>{visual.label}</div>
        <div className='mt-0.5 text-primary-foreground/80'>{detail}</div>
      </TooltipContent>
    </Tooltip>
  )
}

export function EgressBindingIndicator({
  nodeId,
  nodeName,
  assignmentMode,
  compact = false,
}: {
  nodeId?: string | number | null
  nodeName?: string | null
  assignmentMode?: string | null
  compact?: boolean
}) {
  const normalizedNodeId =
    nodeId == null || nodeId === '' ? null : String(nodeId)
  const bound = normalizedNodeId !== null
  const modeLabel =
    assignmentMode === 'auto'
      ? '自动分配'
      : assignmentMode === 'manual'
        ? '手动绑定'
        : '固定绑定'
  const normalizedNodeName = nodeName?.trim()
  const label = bound
    ? normalizedNodeName || `出口节点 ${normalizedNodeId}`
    : '上游默认出口策略'
  const description = bound
    ? `Node ${normalizedNodeId} · ${modeLabel}到该出口节点。`
    : '未绑定固定出口，请求遵循 grok2api 当前默认出口策略；这不等同于明确直连。'
  const Icon = bound ? Network : Route

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={bound ? 'outline' : 'secondary'}
          className={cn(compact && 'size-7 p-0')}
          tabIndex={0}
          aria-label={label}
        >
          <Icon />
          {bound && !compact ? (
            <span className='max-w-36 truncate'>
              {normalizedNodeName || `出口节点 #${normalizedNodeId}`}
              {normalizedNodeName ? ` · #${normalizedNodeId}` : ''}
            </span>
          ) : null}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className='max-w-72'>
        <div className='font-medium'>{label}</div>
        <div className='mt-0.5 text-primary-foreground/80'>{description}</div>
      </TooltipContent>
    </Tooltip>
  )
}

export function AuthStatusIndicator({
  status,
  compact = false,
}: {
  status?: string | null
  compact?: boolean
}) {
  const active = status === 'active'
  const needsAuth = status === 'reauthRequired'
  const coolingDown = status === 'cooldown'
  const waitingReset = status === 'waitingReset'
  const probing = status === 'probing'
  const label = active
    ? '鉴权有效'
    : needsAuth
      ? '需要重新授权'
      : coolingDown
        ? '账号冷却中'
        : waitingReset
          ? '等待额度重置'
          : probing
            ? '上游检测中'
            : '鉴权状态未知'
  const description = active
    ? 'grok2api 当前认为账号凭据有效；这与账号启停和模型质量是不同状态。'
    : needsAuth
      ? '账号凭据已失效或需要重新授权，当前不适合执行探针。'
      : coolingDown
        ? 'grok2api 当前将账号置于冷却状态，暂不适合执行探针。'
        : waitingReset
          ? '账号正在等待上游额度重置，暂不适合执行探针。'
          : probing
            ? 'grok2api 正在检测该账号的当前可用状态。'
            : 'grok2api 未返回明确的 authStatus。'
  const variant = active
    ? 'success'
    : needsAuth
      ? 'destructive'
      : coolingDown || waitingReset
        ? 'warning'
        : probing
          ? 'info'
          : 'outline'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={variant}
          className={cn(
            'rounded-full p-0',
            compact ? 'size-5 [&>svg]:size-3' : 'size-7'
          )}
          tabIndex={0}
          aria-label={label}
        >
          <KeyRound />
        </Badge>
      </TooltipTrigger>
      <TooltipContent className='max-w-72'>
        <div className='font-medium'>{label}</div>
        <div className='mt-0.5 text-primary-foreground/80'>{description}</div>
      </TooltipContent>
    </Tooltip>
  )
}
