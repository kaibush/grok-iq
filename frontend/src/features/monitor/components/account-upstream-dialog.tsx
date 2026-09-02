import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Copy, Server } from 'lucide-react'
import { toast } from 'sonner'
import { formatAccountSecondaryLabel } from '@/lib/account-label'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { cn, formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { EnabledBadge } from '@/components/enabled-badge'
import { CopyButton } from '@/components/copy-button'
import { EmptyState, LoadingState } from '@/components/page'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type AccountIdentity = {
  id: number | string
  name?: string
  email?: string
  createdAt?: string | null
}

const UPSTREAM_FIELD_LABELS: Record<string, string> = {
  id: '账号 ID',
  name: '名称',
  email: '邮箱',
  provider: '提供商',
  enabled: '启用状态',
  authStatus: '鉴权状态',
  priority: '优先级',
  maxConcurrent: '最大并发',
  failureCount: '失败次数',
  lastUsedAt: '最近使用',
  createdAt: '创建时间',
  updatedAt: '更新时间',
  egressNodeId: '出口节点 ID',
  egressAssignmentMode: '出口绑定模式',
  buildBotFlagged: 'Build Bot 标记',
  quota: '配额',
  type: '类型',
  source: '来源',
  confidence: '置信度',
  status: '状态',
  unit: '单位',
  used: '已用',
  limit: '总量',
  remaining: '剩余',
  usagePercent: '使用占比',
  limitKnown: '已知总量',
  windowHours: '窗口小时',
  observed: '已观测',
  confirmed: '已确认',
  periodStart: '周期开始',
  periodEnd: '周期结束',
  exhaustedAt: '耗尽时间',
  nextProbeAt: '下次探测',
  lastConfirmedAt: '最近确认',
}

function formatUpstreamValue(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') {
    return formatNumber(value, Number.isInteger(value) ? 0 : 1)
  }
  if (typeof value === 'string') {
    return /^\d{4}-\d{2}-\d{2}T/.test(value) ? formatDate(value) : value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function flattenUpstreamFields(
  value: unknown,
  prefix = ''
): { path: string; value: string }[] {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [{ path: prefix, value: formatUpstreamValue(value) }] : []
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    return prefix ? [{ path: prefix, value: '{}' }] : []
  }
  return entries.flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key
    if (item != null && typeof item === 'object' && !Array.isArray(item)) {
      return flattenUpstreamFields(item, path)
    }
    return [{ path, value: formatUpstreamValue(item) }]
  })
}

function isHighlightUpstreamPath(path: string): boolean {
  return (
    path === 'enabled' ||
    path === 'createdAt' ||
    path === 'quota' ||
    path.startsWith('quota.')
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function formatQuotaAmount(value: unknown, unit: unknown): string {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return formatUpstreamValue(value)
  const normalizedUnit = String(unit || '')
  const digits = normalizedUnit === 'credits' ? 2 : 0
  const suffix =
    normalizedUnit === 'credits'
      ? ' credits'
      : normalizedUnit === 'tokens'
        ? ' Token'
        : ''
  return `${formatNumber(amount, digits)}${suffix}`
}

function remainingQuotaDisplay(quota: Record<string, unknown> | null): {
  percent: number | null
  label: string
  detail: string
} {
  if (!quota || quota.type === 'unknown') {
    return {
      percent: null,
      label: '待同步',
      detail: 'grok2api 尚未提供可用的额度数据',
    }
  }
  const usage = Number(quota.usagePercent)
  const usagePercent = Number.isFinite(usage)
    ? Math.min(100, Math.max(0, usage))
    : null
  const limit = Number(quota.limit)
  const unit = String(quota.unit || '')
  const status = String(quota.status || '')
  const hasQuotaRange =
    quota.limitKnown === true ||
    (Number.isFinite(limit) && limit > 0) ||
    unit === 'percent' ||
    status !== 'active'

  if (status === 'waitingReset') {
    const recoveryAt = quota.nextProbeAt || quota.periodEnd
    const recovery =
      typeof recoveryAt === 'string' && recoveryAt
        ? `，预计恢复 ${formatDate(recoveryAt)}`
        : ''
    return {
      percent: 0,
      label: '0%',
      detail: `额度已用尽，等待重置${recovery}`,
    }
  }

  if (!hasQuotaRange || usagePercent == null) {
    const used =
      quota.used == null
        ? ''
        : `已观测使用 ${formatQuotaAmount(quota.used, quota.unit)}，`
    return {
      percent: null,
      label: '未估算',
      detail: `${used}上游未提供额度总量`,
    }
  }

  const percent = Math.max(0, 100 - usagePercent)
  const approximate = quota.limitKnown === false && quota.type === 'free'
  const label = `${approximate ? '≈' : ''}${formatNumber(percent, 0)}%`
  const typeLabel =
    quota.type === 'paid' ? '付费' : quota.type === 'free' ? '免费' : ''
  const details: string[] = []
  if (Number.isFinite(limit) && limit > 0 && unit !== 'percent') {
    details.push(
      `${approximate ? '估算剩余' : '剩余'} ${formatQuotaAmount(quota.remaining, quota.unit)} / 总量 ${formatQuotaAmount(quota.limit, quota.unit)}`
    )
  }
  details.push(`已使用 ${formatNumber(usagePercent, 0)}%`)
  if (typeLabel) details.push(typeLabel)
  if (quota.confirmed) details.push('上游确认')
  else if (quota.observed) details.push('本地观测')
  else if (approximate) details.push('估算')
  return { percent, label, detail: details.join(' · ') }
}

function upstreamFieldLabel(path: string): string {
  if (UPSTREAM_FIELD_LABELS[path]) return UPSTREAM_FIELD_LABELS[path]
  const last = path.split('.').pop() || path
  const mapped = UPSTREAM_FIELD_LABELS[last]
  if (!mapped) return path
  if (!path.includes('.')) return mapped
  const parent = path.slice(0, path.lastIndexOf('.'))
  const parentLabel = UPSTREAM_FIELD_LABELS[parent] || parent
  return `${parentLabel} · ${mapped}`
}

export function AccountUpstreamDialog({
  open,
  accountId,
  account,
  onOpenChange,
}: {
  open: boolean
  accountId: number | null
  account?: AccountIdentity | null
  onOpenChange: (open: boolean) => void
}) {
  const query = useQuery({
    queryKey: ['account-upstream', accountId],
    queryFn: () => api.accountUpstream(accountId!),
    enabled: open && accountId != null,
  })
  const accountLabel =
    account?.name || account?.email || (accountId != null ? `账号 ${accountId}` : '上游账号')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size='wide' className='overflow-hidden'>
        <DialogHeader className='shrink-0'>
          <DialogTitle className='flex items-center gap-2'>
            <Server className='size-5 text-primary' />
            <span className='min-w-0 truncate'>{accountLabel}</span>
            {account ? (
              <CopyButton
                value={account.email?.trim() || String(account.id)}
                className='size-6'
              />
            ) : null}
          </DialogTitle>
          <DialogDescription>
            {account
              ? formatAccountSecondaryLabel({
                  id: account.id,
                  email: account.email,
                  createdAt: account.createdAt,
                  accountLabel,
                })
              : '查看 grok2api 上游账号的全部字段'}
          </DialogDescription>
        </DialogHeader>
        <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain pe-1'>
          {query.isLoading && !query.data ? (
            <LoadingState />
          ) : query.isError ? (
            <EmptyState
              icon={Server}
              title='无法加载上游账号'
              description={getErrorMessage(query.error)}
              compact
            />
          ) : query.data?.missingUpstream || query.data?.account == null ? (
            <EmptyState
              icon={Server}
              title='上游账号不存在'
              description='grok2api 里已经找不到这个账号，只剩本系统记录。'
              compact
            />
          ) : (
            <AccountUpstreamDetail account={query.data.account} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AccountUpstreamDetail({
  account,
}: {
  account: Record<string, unknown>
}) {
  const [moreOpen, setMoreOpen] = useState(false)
  const extraFields = flattenUpstreamFields(account).filter(
    (field) => !isHighlightUpstreamPath(field.path)
  )
  const rawJson = JSON.stringify(account, null, 2)
  const remaining = remainingQuotaDisplay(asRecord(account.quota))
  const enabled = account.enabled === true
  const enabledUnknown = typeof account.enabled !== 'boolean'
  const remainingTone =
    remaining.percent == null
      ? 'border-muted bg-muted/15'
      : remaining.percent <= 0
        ? 'border-destructive/30 bg-destructive/8'
        : remaining.percent <= 25
          ? 'border-amber-500/30 bg-amber-500/8'
          : remaining.percent <= 60
            ? 'border-sky-500/30 bg-sky-500/8'
            : 'border-emerald-500/30 bg-emerald-500/8'
  const remainingText =
    remaining.percent == null
      ? 'text-muted-foreground'
      : remaining.percent <= 0
        ? 'text-destructive'
        : remaining.percent <= 25
          ? 'text-amber-700 dark:text-amber-300'
          : remaining.percent <= 60
            ? 'text-sky-700 dark:text-sky-300'
            : 'text-emerald-700 dark:text-emerald-300'
  const remainingBar =
    remaining.percent == null
      ? 'bg-muted-foreground/30'
      : remaining.percent <= 0
        ? 'bg-destructive'
        : remaining.percent <= 25
          ? 'bg-amber-500'
          : remaining.percent <= 60
            ? 'bg-sky-500'
            : 'bg-emerald-500'
  const copyUpstreamJson = () => {
    void copyText(rawJson)
      .then(() => toast.success('已复制上游 JSON'))
      .catch((error) => toast.error(getErrorMessage(error)))
  }
  return (
    <div className='space-y-4'>
      <div className='grid gap-3 sm:grid-cols-3'>
        <div className={cn('rounded-lg border p-4', remainingTone)}>
          <div className='text-[11px] text-muted-foreground'>剩余额度占比</div>
          <div
            className={cn(
              'mt-1 text-2xl font-semibold tabular-nums',
              remainingText
            )}
          >
            {remaining.label}
          </div>
          {remaining.percent != null ? (
            <div className='mt-3 h-1.5 overflow-hidden rounded-full bg-background/80'>
              <div
                className={cn(
                  'h-full rounded-full transition-[width]',
                  remainingBar
                )}
                style={{ width: `${remaining.percent}%` }}
              />
            </div>
          ) : null}
          <div className='mt-2 text-xs leading-5 text-muted-foreground'>
            {remaining.detail}
          </div>
        </div>
        <div
          className={cn(
            'rounded-lg border p-4',
            enabledUnknown
              ? 'border-muted bg-muted/15'
              : enabled
                ? 'border-emerald-500/30 bg-emerald-500/8'
                : 'border-zinc-400/40 bg-zinc-500/10'
          )}
        >
          <div className='text-[11px] text-muted-foreground'>是否启用</div>
          <div className='mt-2'>
            <EnabledBadge enabled={enabled} unknown={enabledUnknown} />
          </div>
          <div className='mt-2 text-xs leading-5 text-muted-foreground'>
            grok2api 当前调度状态
          </div>
        </div>
        <div className='rounded-lg border bg-muted/15 p-4'>
          <div className='text-[11px] text-muted-foreground'>创建时间</div>
          <div className='mt-1 text-lg font-semibold tabular-nums'>
            {formatUpstreamValue(account.createdAt)}
          </div>
          <div className='mt-2 text-xs leading-5 text-muted-foreground'>
            上游账号创建时间
          </div>
        </div>
      </div>
      <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
        <div className='overflow-hidden rounded-lg border'>
          <div className='flex items-center gap-2 px-2 py-1.5'>
            <CollapsibleTrigger asChild>
              <button
                type='button'
                className='flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm font-medium hover:bg-muted/40'
              >
                <span>其他字段</span>
                <span className='flex items-center gap-2 text-xs font-normal text-muted-foreground'>
                  {extraFields.length} 项
                  <ChevronDown
                    className={cn(
                      'size-4 transition-transform',
                      moreOpen && 'rotate-180'
                    )}
                  />
                </span>
              </button>
            </CollapsibleTrigger>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='shrink-0'
              onClick={copyUpstreamJson}
            >
              <Copy />
              复制 JSON
            </Button>
          </div>
          <CollapsibleContent>
            <div className='space-y-4 border-t p-4'>
              {extraFields.length ? (
                <dl className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
                  {extraFields.map((field) => (
                    <div
                      key={field.path}
                      className='rounded-lg border bg-muted/15 p-3'
                    >
                      <dt className='text-[11px] text-muted-foreground'>
                        {upstreamFieldLabel(field.path)}
                      </dt>
                      <dd
                        className='mt-1 text-sm leading-5 break-all'
                        title={field.path}
                      >
                        {field.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className='text-sm text-muted-foreground'>没有更多字段</p>
              )}
              <pre className='overflow-x-auto rounded-lg border bg-background p-3 font-mono text-xs leading-6 whitespace-pre-wrap'>
                {rawJson}
              </pre>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  )
}
