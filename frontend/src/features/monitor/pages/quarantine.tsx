import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Activity,
  ChevronDown,
  Copy,
  Eye,
  Images,
  Loader2,
  Network,
  Pencil,
  Play,
  Plus,
  PowerOff,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  ShieldBan,
  SlidersHorizontal,
  StickyNote,
  Trash2,
  Undo2,
  UserX,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatAccountSecondaryLabel } from '@/lib/account-label'
import {
  api,
  type AccountQuarantineLocalDeleteResult,
  type OperatorNote,
  type ProbeSample,
  type UpstreamAccount,
} from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { MonitorStatusCell } from '@/components/monitor-status-badge'
import { cn, formatDate, formatNumber, formatRelativeTime, getErrorMessage } from '@/lib/utils'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { usePaintDeferredValue } from '@/hooks/use-paint-deferred-value'
import { usePersistedViewState } from '@/hooks/use-persisted-view-state'
import { useServerTableLoading } from '@/hooks/use-server-table-loading'
import { EnabledBadge } from '@/components/enabled-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ActionToolbar, ToolbarAction } from '@/components/action-toolbar'
import { ExportMenu } from '@/components/export-menu'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { EmptyState, LoadingState, Page, PageHeader } from '@/components/page'
import { TablePanel } from '@/components/table-panel'
import { PersistedViewNotice } from '@/components/persisted-view-notice'
import { SelectionToolbar } from '@/components/selection-toolbar'
import {
  ServerPagination,
  ServerTableLoadingOverlay,
} from '@/components/server-pagination'
import { AccountSampleExplorer } from '@/features/monitor/components/account-sample-explorer'
import {
  pickPreviewSample,
  previewItemsFromSamples,
  ResultPreviewGallery,
} from '@/features/monitor/components/result-preview-gallery'
import {
  ACCOUNT_UPSTREAM_STATUS_OPTIONS,
  type UpstreamStatusFilter,
} from '@/features/monitor/components/account-upstream-status'
import {
  DispositionBanner,
  DispositionSummary,
  dispositionOrigin,
} from '@/features/monitor/components/disposition-summary'
import {
  buildEgressNodeNameMap,
  getEgressNodeName,
  type EgressNodeNameMap,
} from '@/features/monitor/components/egress-node-names'
import { FilterChip } from '@/features/monitor/components/filter-chip'
import { ProbeDialog } from '@/features/monitor/components/probe-dialog'
import { QuarantineStatsBoard } from '@/features/monitor/components/quarantine-stats-board'

type SsoRiskFilter =
  | 'all'
  | 'missing'
  | 'unverified'
  | 'pending'
  | 'clean'
  | 'flagged'
  | 'failed'
  | 'change_egress'

type IsolationUpstreamStatusFilter = UpstreamStatusFilter | 'missing'

const RESTORE_PRIORITY_MIN = -2_000_000_000
const RESTORE_PRIORITY_MAX = 2_000_000_000

function quarantineDeleteRetainedIds(
  result: Pick<
    AccountQuarantineLocalDeleteResult,
    'skippedAccountIds' | 'failedAccountIds' | 'skippedNotQuarantinedAccountIds'
  >
): number[] {
  return Array.from(
    new Set([
      ...(result.skippedAccountIds ?? []),
      ...(result.failedAccountIds ?? []),
      ...(result.skippedNotQuarantinedAccountIds ?? []),
    ])
  )
}

function parseRestorePriority(value: string): {
  priority?: number
  error?: string
} {
  const text = value.trim()
  if (!text) return {}
  if (!/^-?\d+$/.test(text)) {
    return { error: '请输入整数优先级' }
  }
  const priority = Number(text)
  if (
    !Number.isSafeInteger(priority) ||
    priority < RESTORE_PRIORITY_MIN ||
    priority > RESTORE_PRIORITY_MAX
  ) {
    return { error: '优先级超出可设置范围' }
  }
  return { priority }
}

const QUARANTINE_VIEW_STORAGE_KEY = 'grokiq.monitor.quarantine-view.v1'
type IsolationSourceFilter =
  | 'all'
  | 'grok2api'
  | 'probe'
  | 'request_audit'
  | 'register'
  | 'manual'
  | 'sso'

const defaultQuarantineView = {
  page: 1,
  pageSize: 50,
  search: '',
  upstreamStatus: 'all' as IsolationUpstreamStatusFilter,
  ssoRisk: 'all' as SsoRiskFilter,
  egressNodeId: 'all',
  source: 'all' as IsolationSourceFilter,
}

const isolationUpstreamStatusOptions: {
  value: IsolationUpstreamStatusFilter
  label: string
}[] = [
  ...ACCOUNT_UPSTREAM_STATUS_OPTIONS,
  { value: 'missing', label: '上游缺失' },
]

const isolationSourceOptions: {
  value: IsolationSourceFilter
  label: string
}[] = [
  { value: 'all', label: '全部来源' },
  { value: 'grok2api', label: 'grok2api 降智停用' },
  { value: 'probe', label: 'GrokIQ 探针' },
  { value: 'request_audit', label: 'GrokIQ 请求审计' },
  { value: 'register', label: 'GrokIQ 注册联动' },
  { value: 'manual', label: 'GrokIQ 手动' },
  { value: 'sso', label: 'GrokIQ SSO' },
]

const ssoRiskLabels: Record<SsoRiskFilter, string> = {
  all: '全部 SSO 风控状态',
  missing: '缺少 SSO',
  unverified: 'SSO 未复检',
  pending: 'SSO 待复检',
  clean: 'SSO 正常',
  flagged: 'SSO 已标记',
  failed: 'SSO 复检失败',
  change_egress: '建议更换出口',
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

function RiskReasonCell({ account }: { account: UpstreamAccount }) {
  const assessment = account.assessment
  return (
    <DispositionSummary
      disposition={assessment?.disposition}
      sampleReasons={assessment?.risk_reasons ?? []}
      sampleCount={assessment?.sample_count ?? 0}
      anomalyCount={assessment?.anomaly_count ?? 0}
      hardCount={assessment?.hard_anomaly_count ?? 0}
      score={assessment?.risk_score ?? 0}
    />
  )
}

function accountOperatorNotes(account: UpstreamAccount): OperatorNote[] {
  const notes = account.assessment?.operator_notes
  if (Array.isArray(notes) && notes.length > 0) {
    return notes.filter((note) => String(note.content || '').trim())
  }
  const legacy = String(account.assessment?.operator_note ?? '').trim()
  if (!legacy) return []
  return [{ id: 'legacy', content: legacy, created_at: '', updated_at: null }]
}

function OperatorNoteCell({
  account,
  open,
  onOpenChange,
}: {
  account: UpstreamAccount
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const client = useQueryClient()
  const notes = accountOperatorNotes(account)
  const latest = notes[0]
  const [composer, setComposer] = useState<'add' | string | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['accounts'] })
    void client.invalidateQueries({
      queryKey: ['account', Number(account.id)],
    })
  }
  const addMutation = useMutation({
    mutationFn: (note: string) =>
      api.addAccountOperatorNote(Number(account.id), note),
    onSuccess: () => {
      setComposer(null)
      setDraft('')
      toast.success('备注已添加')
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: invalidate,
  })
  const updateMutation = useMutation({
    mutationFn: ({ noteId, note }: { noteId: string; note: string }) =>
      api.updateAccountOperatorNote(Number(account.id), noteId, note),
    onSuccess: () => {
      setComposer(null)
      setDraft('')
      toast.success('备注已修改')
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: invalidate,
  })
  const deleteMutation = useMutation({
    mutationFn: (noteId: string) =>
      api.deleteAccountOperatorNote(Number(account.id), noteId),
    onSuccess: () => {
      setPendingDeleteId(null)
      if (typeof composer === 'string') {
        setComposer(null)
        setDraft('')
      }
      toast.success('备注已删除')
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: invalidate,
  })
  const busy =
    addMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending
  const accountLabel = account.name || account.email || account.id
  const startAdd = () => {
    setPendingDeleteId(null)
    setComposer('add')
    setDraft('')
    onOpenChange(true)
  }
  const startEdit = (note: OperatorNote) => {
    setPendingDeleteId(null)
    setComposer(note.id)
    setDraft(note.content)
  }
  return (
    <div className='flex items-center gap-1'>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (busy) return
          if (!next) {
            setComposer(null)
            setDraft('')
            setPendingDeleteId(null)
          }
          onOpenChange(next)
        }}
      >
        <PopoverTrigger asChild>
          {latest ? (
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='h-8 max-w-52 gap-1.5 px-2.5 text-xs font-normal'
              aria-label={`查看 ${accountLabel} 的隔离备注`}
            >
              <span className='truncate' title={latest.content}>
                {latest.content}
              </span>
              <span className='shrink-0 text-muted-foreground'>
                {notes.length} 项
              </span>
            </Button>
          ) : (
            <button
              type='button'
              className='inline-flex h-8 items-center text-muted-foreground'
              aria-label={`查看 ${accountLabel} 的隔离备注`}
            >
              —
            </button>
          )}
        </PopoverTrigger>
        <PopoverContent
          align='start'
          className='w-96 p-0'
          onClick={(event) => event.stopPropagation()}
        >
          <div className='flex items-start justify-between gap-3 border-b px-3 py-2.5'>
            <div>
              <div className='text-sm font-medium'>隔离备注</div>
              <div className='mt-1 text-[11px] leading-5 text-muted-foreground'>
                {notes.length
                  ? `${notes.length} 条记录，含时间戳`
                  : '只保存在本系统，方便以后回忆为什么隔离'}
              </div>
            </div>
            <Button
              type='button'
              size='icon'
              variant='outline'
              className='size-8'
              disabled={busy}
              onClick={startAdd}
              aria-label={`为 ${accountLabel} 添加隔离备注`}
            >
              <Plus />
            </Button>
          </div>
          {composer === 'add' ? (
            <div className='space-y-3 border-b p-3'>
              <Textarea
                value={draft}
                maxLength={2000}
                rows={4}
                autoFocus
                placeholder='例如：出口异常、人工确认降智、先观察几天'
                onChange={(event) => setDraft(event.target.value)}
                disabled={busy}
              />
              <div className='flex items-center justify-between gap-3'>
                <span className='text-[11px] text-muted-foreground tabular-nums'>
                  {draft.length}/2000
                </span>
                <div className='flex gap-2'>
                  <Button
                    type='button'
                    size='sm'
                    variant='ghost'
                    disabled={busy}
                    onClick={() => {
                      setComposer(null)
                      setDraft('')
                    }}
                  >
                    取消
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    disabled={busy || !draft.trim()}
                    onClick={() => addMutation.mutate(draft)}
                  >
                    {addMutation.isPending ? (
                      <>
                        <Loader2 className='animate-spin' />
                        添加中…
                      </>
                    ) : (
                      '添加'
                    )}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          {notes.length ? (
            <ul className='max-h-80 space-y-2 overflow-y-auto p-2'>
              {notes.map((note) => {
                const editing = composer === note.id
                const timestamp = note.updated_at || note.created_at
                return (
                  <li
                    key={note.id}
                    className='rounded-md bg-muted/40 px-2.5 py-2'
                  >
                    <div className='flex items-start justify-between gap-2'>
                      <div className='text-[11px] leading-5 text-muted-foreground tabular-nums'>
                        {timestamp ? formatDate(timestamp) : '时间未知'}
                        {note.updated_at ? ' · 已修改' : ''}
                      </div>
                      <div className='flex shrink-0'>
                        <Button
                          type='button'
                          size='icon'
                          variant='ghost'
                          className='size-7'
                          disabled={busy}
                          onClick={() => startEdit(note)}
                          aria-label='修改这条备注'
                        >
                          <Pencil className='size-3.5' />
                        </Button>
                        {pendingDeleteId === note.id ? (
                          <Button
                            type='button'
                            size='sm'
                            variant='ghost'
                            className='h-7 px-2 text-destructive'
                            disabled={busy}
                            onClick={() => deleteMutation.mutate(note.id)}
                          >
                            {deleteMutation.isPending &&
                            deleteMutation.variables === note.id ? (
                              <Loader2 className='animate-spin' />
                            ) : (
                              '确认删除'
                            )}
                          </Button>
                        ) : (
                          <Button
                            type='button'
                            size='icon'
                            variant='ghost'
                            className='size-7'
                            disabled={busy}
                            onClick={() => {
                              setComposer(null)
                              setPendingDeleteId(note.id)
                            }}
                            aria-label='删除这条备注'
                          >
                            <Trash2 className='size-3.5' />
                          </Button>
                        )}
                      </div>
                    </div>
                    {editing ? (
                      <div className='mt-2 space-y-2'>
                        <Textarea
                          value={draft}
                          maxLength={2000}
                          rows={3}
                          onChange={(event) => setDraft(event.target.value)}
                          disabled={busy}
                        />
                        <div className='flex items-center justify-between gap-3'>
                          <span className='text-[11px] text-muted-foreground tabular-nums'>
                            {draft.length}/2000
                          </span>
                          <div className='flex gap-2'>
                            <Button
                              type='button'
                              size='sm'
                              variant='ghost'
                              disabled={busy}
                              onClick={() => {
                                setComposer(null)
                                setDraft('')
                              }}
                            >
                              取消
                            </Button>
                            <Button
                              type='button'
                              size='sm'
                              disabled={
                                busy ||
                                !draft.trim() ||
                                draft.trim() === note.content.trim()
                              }
                              onClick={() =>
                                updateMutation.mutate({
                                  noteId: note.id,
                                  note: draft,
                                })
                              }
                            >
                              {updateMutation.isPending ? (
                                <>
                                  <Loader2 className='animate-spin' />
                                  保存中…
                                </>
                              ) : (
                                '保存'
                              )}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className='mt-1 text-xs leading-5 whitespace-pre-wrap'>
                        {note.content}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : composer === 'add' ? null : (
            <p className='px-3 py-2.5 text-xs text-muted-foreground'>
              暂无备注，点击右上角 + 添加
            </p>
          )}
        </PopoverContent>
      </Popover>
      <Button
        type='button'
        size='icon'
        variant='ghost'
        className='size-8'
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation()
          startAdd()
        }}
        aria-label={`为 ${accountLabel} 添加隔离备注`}
      >
        <Plus />
      </Button>
    </div>
  )
}

export function QuarantinePage() {
  const client = useQueryClient()
  const statsFetching =
    useIsFetching({ queryKey: ['accounts', 'quarantine-stats'] }) > 0
  const view = usePersistedViewState(
    QUARANTINE_VIEW_STORAGE_KEY,
    defaultQuarantineView
  )
  const {
    page,
    pageSize,
    search,
    upstreamStatus = 'all',
    ssoRisk = 'all',
    egressNodeId = 'all',
    source = 'all',
  } = view.value
  const updateView = (patch: Partial<typeof defaultQuarantineView>) =>
    view.setValue((current) => ({ ...current, ...patch }))
  const [deferredSearch] = useDebouncedValue(search.trim())
  const committedQuery = useMemo(
    () => ({
      page,
      pageSize,
      search: deferredSearch,
      upstreamStatus,
      ssoRisk,
      egressNodeId,
      source,
    }),
    [
      deferredSearch,
      egressNodeId,
      page,
      pageSize,
      source,
      ssoRisk,
      upstreamStatus,
    ]
  )
  const tableQuery = usePaintDeferredValue(committedQuery)
  const [selected, setSelected] = useState<number[]>([])
  const [selectedDisabled, setSelectedDisabled] = useState<number[]>([])
  const [selectedMissing, setSelectedMissing] = useState<number[]>([])
  const [probeOpen, setProbeOpen] = useState(false)
  const [probeAccountIds, setProbeAccountIds] = useState<number[]>([])
  const [probeDisabledCount, setProbeDisabledCount] = useState(0)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restorePriority, setRestorePriority] = useState('')
  const [disableOpen, setDisableOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteUpstreamOpen, setDeleteUpstreamOpen] = useState(false)
  const [deleteUpstreamAlsoLocal, setDeleteUpstreamAlsoLocal] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [noteEditorId, setNoteEditorId] = useState<number | null>(null)
  const [upstreamOpen, setUpstreamOpen] = useState(false)
  const [upstreamId, setUpstreamId] = useState<number | null>(null)
  const [previewAccount, setPreviewAccount] = useState<UpstreamAccount | null>(
    null
  )
  const [previewIndex, setPreviewIndex] = useState(0)
  const [previewPage, setPreviewPage] = useState(1)
  const [previewLand, setPreviewLand] = useState<'start' | 'end'>()
  const previewSeeded = useRef(false)
  const tableQueryPending =
    tableQuery.page !== committedQuery.page ||
    tableQuery.pageSize !== committedQuery.pageSize ||
    tableQuery.search !== committedQuery.search ||
    tableQuery.upstreamStatus !== committedQuery.upstreamStatus ||
    tableQuery.ssoRisk !== committedQuery.ssoRisk ||
    tableQuery.egressNodeId !== committedQuery.egressNodeId ||
    tableQuery.source !== committedQuery.source
  const query = useQuery({
    queryKey: [
      'accounts',
      'quarantine',
      tableQuery.page,
      tableQuery.pageSize,
      tableQuery.search,
      tableQuery.upstreamStatus,
      tableQuery.ssoRisk,
      tableQuery.egressNodeId,
      tableQuery.source,
    ],
    queryFn: ({ signal }) =>
      api.quarantineAccounts(
        {
          page: tableQuery.page,
          pageSize: tableQuery.pageSize,
          search: tableQuery.search,
          status:
            tableQuery.upstreamStatus === 'all'
              ? ''
              : tableQuery.upstreamStatus,
          ssoRisk: tableQuery.ssoRisk === 'all' ? '' : tableQuery.ssoRisk,
          egressNodeId:
            tableQuery.egressNodeId === 'all' ? '' : tableQuery.egressNodeId,
          source: tableQuery.source === 'all' ? '' : tableQuery.source,
        },
        signal
      ),
    placeholderData: (previous) => previous,
  })
  const accounts = useMemo(() => query.data?.items ?? [], [query.data?.items])
  const { beginTableInteraction, tableLoading: showTableLoading } =
    useServerTableLoading({
      isFetching: query.isFetching,
      inputPending: tableQueryPending,
    })
  const tableFilterKey = [
    tableQuery.search,
    tableQuery.upstreamStatus,
    tableQuery.ssoRisk,
    tableQuery.egressNodeId,
    tableQuery.source,
  ].join('|')
  const appliedFilterKeyRef = useRef(tableFilterKey)
  useEffect(() => {
    if (tableQueryPending) {
      beginTableInteraction()
      return
    }
    if (appliedFilterKeyRef.current === tableFilterKey) return
    appliedFilterKeyRef.current = tableFilterKey
    setSelected((current) => (current.length === 0 ? current : []))
    setSelectedDisabled((current) => (current.length === 0 ? current : []))
    setSelectedMissing((current) => (current.length === 0 ? current : []))
  }, [beginTableInteraction, tableFilterKey, tableQueryPending])

  const detail = useQuery({
    queryKey: ['account', detailId],
    queryFn: () => api.account(detailId!),
    enabled: detailOpen && detailId != null,
  })
  const samplesQuery = useQuery({
    queryKey: ['account-samples', detailId],
    queryFn: () => api.accountSamples(detailId!, { page: 1, pageSize: 50 }),
    enabled: detailOpen && detailId != null,
  })
  const previewQuery = useQuery({
    queryKey: [
      'account-samples',
      previewAccount ? Number(previewAccount.id) : 0,
      'gallery',
      previewPage,
    ],
    queryFn: () =>
      api.accountSamples(Number(previewAccount!.id), {
        page: previewPage,
        pageSize: 50,
      }),
    enabled: previewAccount != null,
  })
  const previewItems = useMemo(
    () =>
      previewAccount
        ? previewItemsFromSamples(previewQuery.data?.items ?? [], previewAccount)
        : [],
    [previewAccount, previewQuery.data?.items]
  )
  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: api.profiles,
    enabled: probeOpen,
    staleTime: 60_000,
  })
  const {
    data: egressData,
    error: egressQueryError,
    isError: egressIsError,
    isFetching: egressFetching,
    refetch: refetchEgress,
  } = useQuery({
    queryKey: ['egress'],
    queryFn: () => api.egress({ pageSize: 500 }),
    staleTime: 60_000,
  })
  const egressNodeNames = useMemo(
    () => buildEgressNodeNameMap(egressData?.items),
    [egressData?.items]
  )
  useEffect(() => {
    if (!previewAccount) {
      previewSeeded.current = false
      return
    }
    if (previewQuery.isFetching) return
    if (previewQuery.isError) {
      toast.error(getErrorMessage(previewQuery.error))
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreviewAccount(null)
      return
    }
    if (previewQuery.isSuccess && previewItems.length === 0) {
      if ((previewQuery.data?.total ?? 0) === 0) {
        toast.error('该账号没有可预览的样本正文')
        setPreviewAccount(null)
      }
      return
    }
    if (previewQuery.isSuccess && previewItems.length > 0) {
      if (previewLand === 'end') {
        previewSeeded.current = true
        setPreviewIndex(previewItems.length - 1)
        setPreviewLand(undefined)
        return
      }
      if (previewLand === 'start') {
        previewSeeded.current = true
        setPreviewIndex(0)
        setPreviewLand(undefined)
        return
      }
      if (!previewSeeded.current) {
        previewSeeded.current = true
        const picked = pickPreviewSample(previewQuery.data?.items ?? [])
        const index = previewItems.findIndex(
          (item) => item.sampleId === picked?.id
        )
        setPreviewIndex(index >= 0 ? index : 0)
      }
    }
  }, [
    previewAccount,
    previewItems,
    previewQuery.data?.items,
    previewQuery.error,
    previewQuery.isError,
    previewLand,
    previewQuery.isFetching,
    previewQuery.isSuccess,
  ])
  const detailAccount =
    detail.data?.account ??
    accounts.find((item) => Number(item.id) === detailId) ??
    null
  const samples: ProbeSample[] =
    samplesQuery.data?.items ?? detail.data?.history.samples ?? []
  const upstreamQuery = useQuery({
    queryKey: ['account-upstream', upstreamId],
    queryFn: () => api.accountUpstream(upstreamId!),
    enabled: upstreamOpen && upstreamId != null,
  })
  const upstreamListAccount =
    accounts.find((item) => Number(item.id) === upstreamId) ?? null

  const openAccountSamples = useCallback((id: number) => {
    setDetailId(id)
    setDetailOpen(true)
  }, [])
  const openAccountUpstream = useCallback((id: number) => {
    setUpstreamId(id)
    setUpstreamOpen(true)
  }, [])
  const setNoteEditorOpen = useCallback((id: number, open: boolean) => {
    setNoteEditorId((current) => {
      if (open) return id
      return current === id ? null : current
    })
  }, [])

  const allChecked =
    accounts.length > 0 &&
    accounts.every((item) => selected.includes(Number(item.id)))

  const selectedMissingSet = useMemo(
    () => new Set(selectedMissing),
    [selectedMissing]
  )
  const selectedDisabledSet = useMemo(
    () => new Set(selectedDisabled),
    [selectedDisabled]
  )
  const probeableSelected = useMemo(
    () => selected.filter((id) => !selectedMissingSet.has(id)),
    [selected, selectedMissingSet]
  )

  const toggleCurrentPageSelection = useCallback(
    (checked: boolean) => {
      const pageIds = accounts.map((item) => Number(item.id))
      const missingIds = accounts
        .filter((item) => item.missingUpstream)
        .map((item) => Number(item.id))
      const disabledIds = accounts
        .filter((item) => !item.missingUpstream && !item.enabled)
        .map((item) => Number(item.id))
      setSelected((current) =>
        checked
          ? Array.from(new Set([...current, ...pageIds]))
          : current.filter((id) => !pageIds.includes(id))
      )
      setSelectedMissing((current) =>
        checked
          ? Array.from(new Set([...current, ...missingIds]))
          : current.filter((id) => !pageIds.includes(id))
      )
      setSelectedDisabled((current) =>
        checked
          ? Array.from(new Set([...current, ...disabledIds]))
          : current.filter((id) => !pageIds.includes(id))
      )
    },
    [accounts]
  )
  const toggleAccountSelection = useCallback(
    (id: number, checked: boolean) => {
      const account = accounts.find((item) => Number(item.id) === id)
      const missing = Boolean(account?.missingUpstream)
      const disabled = Boolean(account && !missing && !account.enabled)
      setSelected((current) =>
        checked
          ? [...new Set([...current, id])]
          : current.filter((item) => item !== id)
      )
      setSelectedMissing((current) =>
        checked && missing
          ? [...new Set([...current, id])]
          : current.filter((item) => item !== id)
      )
      setSelectedDisabled((current) =>
        checked && disabled
          ? [...new Set([...current, id])]
          : current.filter((item) => item !== id)
      )
    },
    [accounts]
  )

  const openProbeDialog = useCallback(
    (accountIds: number[], disabledCount: number) => {
      if (!accountIds.length) {
        toast.error('没有可创建探针的账号')
        return
      }
      setProbeAccountIds(accountIds)
      setProbeDisabledCount(disabledCount)
      setProbeOpen(true)
      void refetchEgress()
    },
    [refetchEgress]
  )

  const syncSelection = useCallback((accountIds: number[]) => {
    setSelected(accountIds)
    setSelectedDisabled((current) =>
      current.filter((id) => accountIds.includes(id))
    )
    setSelectedMissing((current) =>
      current.filter((id) => accountIds.includes(id))
    )
  }, [])

  const restorePriorityParsed = parseRestorePriority(restorePriority)
  const restoreMutation = useMutation({
    mutationFn: ({
      accountIds,
      priority,
    }: {
      accountIds: number[]
      priority?: number
    }) =>
      api.accountBatchAction({
        account_ids: accountIds,
        action: 'restore',
        note: '隔离区恢复上游',
        propagate: true,
        ...(priority != null ? { priority } : {}),
      }),
    onSuccess: (result) => {
      const skippedAccountIds = result.skippedAccountIds ?? []
      const failedAccountIds = result.failedAccountIds ?? []
      const retainedAccountIds = Array.from(
        new Set([...skippedAccountIds, ...failedAccountIds])
      )
      setRestoreOpen(false)
      syncSelection(retainedAccountIds)
      if (detailId != null && !retainedAccountIds.includes(detailId)) {
        setDetailOpen(false)
      }
      if (failedAccountIds.length > 0 || skippedAccountIds.length > 0) {
        const details = [`已恢复上游 ${result.updated} 个账号`]
        if (failedAccountIds.length) {
          details.push(`${failedAccountIds.length} 个恢复失败并保留选择`)
        }
        if (skippedAccountIds.length) {
          details.push(`${skippedAccountIds.length} 个账号已跳过`)
        }
        toast.warning(details.join('；'))
      } else {
        toast.success(`已恢复上游 ${result.updated} 个账号`)
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['accounts'] })
      void client.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  const disableMutation = useMutation({
    mutationFn: (accountIds: number[]) =>
      api.updateAccountsEnabled(accountIds, false),
    onSuccess: (result) => {
      const skippedAccountIds = result.skippedAccountIds ?? []
      const failedAccountIds = result.failedAccountIds ?? []
      const retainedAccountIds = Array.from(
        new Set([...skippedAccountIds, ...failedAccountIds])
      )
      setDisableOpen(false)
      syncSelection(retainedAccountIds)
      if (failedAccountIds.length > 0 || skippedAccountIds.length > 0) {
        const details = [`已停用上游 ${result.updated} 个账号`]
        if (failedAccountIds.length) {
          details.push(`${failedAccountIds.length} 个停用失败并保留选择`)
        }
        if (skippedAccountIds.length) {
          details.push(`${skippedAccountIds.length} 个设置受任务保护并跳过`)
        }
        toast.warning(details.join('；'))
      } else if (result.updated !== result.eligible) {
        toast.warning(
          `批量停用完成：上游更新 ${result.updated} / ${result.eligible} 个账号`
        )
      } else {
        toast.success(`已停用上游 ${result.updated} 个账号`)
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['accounts'] })
      void client.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (accountIds: number[]) => api.deleteQuarantineLocal(accountIds),
    onSuccess: (result) => {
      const skippedAccountIds = result.skippedAccountIds ?? []
      const failedAccountIds = result.failedAccountIds ?? []
      const retainedAccountIds = Array.from(
        new Set([...skippedAccountIds, ...failedAccountIds])
      )
      setDeleteOpen(false)
      syncSelection(retainedAccountIds)
      if (detailId != null && !retainedAccountIds.includes(detailId)) {
        setDetailOpen(false)
      }
      if (failedAccountIds.length > 0 || skippedAccountIds.length > 0) {
        const details = [`已删除 ${result.deleted} 条本系统记录`]
        if (failedAccountIds.length) {
          details.push(`${failedAccountIds.length} 个删除失败并保留选择`)
        }
        if (skippedAccountIds.length) {
          details.push(`${skippedAccountIds.length} 个账号已跳过`)
        }
        toast.warning(details.join('；'))
      } else {
        toast.success(`已删除 ${result.deleted} 条本系统记录`)
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['accounts'] })
      void client.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  const deleteUpstreamMutation = useMutation({
    mutationFn: async ({
      accountIds,
      alsoDeleteLocal,
    }: {
      accountIds: number[]
      alsoDeleteLocal: boolean
    }) => {
      const upstream = await api.deleteQuarantineUpstream(accountIds)
      const upstreamRetainedIds = new Set(quarantineDeleteRetainedIds(upstream))
      const successfulIds = accountIds.filter(
        (accountId) => !upstreamRetainedIds.has(accountId)
      )
      let local: AccountQuarantineLocalDeleteResult | null = null
      let localError: unknown = null
      if (alsoDeleteLocal && successfulIds.length > 0) {
        try {
          local = await api.deleteQuarantineLocal(successfulIds)
        } catch (error) {
          localError = error
        }
      }
      return {
        accountIds,
        alsoDeleteLocal,
        successfulIds,
        upstream,
        local,
        localError,
      }
    },
    onSuccess: (result) => {
      const {
        accountIds,
        alsoDeleteLocal,
        successfulIds,
        upstream,
        local,
        localError,
      } = result
      const skippedAccountIds = upstream.skippedAccountIds ?? []
      const failedAccountIds = upstream.failedAccountIds ?? []
      const skippedNotQuarantinedAccountIds =
        upstream.skippedNotQuarantinedAccountIds ?? []
      const localSkippedAccountIds = local?.skippedAccountIds ?? []
      const localFailedAccountIds = local?.failedAccountIds ?? []
      const localRetainedIds = new Set(
        alsoDeleteLocal
          ? localError
            ? successfulIds
            : [...localSkippedAccountIds, ...localFailedAccountIds]
          : []
      )
      const retainedAccountIds = Array.from(
        new Set([
          ...skippedAccountIds,
          ...failedAccountIds,
          ...skippedNotQuarantinedAccountIds,
          ...successfulIds.filter((accountId) =>
            localRetainedIds.has(accountId)
          ),
          ...selected.filter((id) => !accountIds.includes(id)),
        ])
      )
      setDeleteUpstreamOpen(false)
      setDeleteUpstreamAlsoLocal(false)
      syncSelection(retainedAccountIds)
      if (
        detailId != null &&
        alsoDeleteLocal &&
        !localError &&
        successfulIds.includes(detailId) &&
        !localRetainedIds.has(detailId)
      ) {
        setDetailOpen(false)
      }
      const details = [`已删除上游 ${upstream.deleted} 个账号`]
      if (alsoDeleteLocal) {
        if (localError) {
          details.push(
            `本系统记录删除失败，本地隔离记录仍保留：${getErrorMessage(localError)}`
          )
        } else if (local) {
          details.push(`已删除 ${local.deleted} 条本系统记录`)
          if (localFailedAccountIds.length) {
            details.push(
              `${localFailedAccountIds.length} 个本系统记录删除失败并保留选择`
            )
          }
          if (localSkippedAccountIds.length) {
            details.push(`${localSkippedAccountIds.length} 个本系统记录已跳过`)
          }
        }
      }
      if (failedAccountIds.length) {
        details.push(`${failedAccountIds.length} 个删除失败并保留选择`)
      }
      if (skippedAccountIds.length) {
        details.push(`${skippedAccountIds.length} 个设置受任务保护并跳过`)
      }
      if (skippedNotQuarantinedAccountIds.length) {
        details.push(
          `${skippedNotQuarantinedAccountIds.length} 个账号不在隔离区并跳过`
        )
      }
      const isWarning =
        failedAccountIds.length > 0 ||
        skippedAccountIds.length > 0 ||
        skippedNotQuarantinedAccountIds.length > 0 ||
        Boolean(localError) ||
        localFailedAccountIds.length > 0 ||
        localSkippedAccountIds.length > 0
      if (isWarning) {
        toast.warning(details.join('；'))
      } else {
        toast.success(details.join('；'))
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['accounts'] })
      void client.invalidateQueries({
        queryKey: ['accounts', 'quarantine-stats'],
      })
      void client.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  const restorePending = restoreMutation.isPending
  const disablePending = disableMutation.isPending
  const deletePending = deleteMutation.isPending
  const deleteUpstreamPending = deleteUpstreamMutation.isPending
  const selectionActionPending =
    restorePending || disablePending || deletePending || deleteUpstreamPending
  const upstreamStatusLabel =
    isolationUpstreamStatusOptions.find(
      (option) => option.value === upstreamStatus
    )?.label ?? '全部上游状态'
  const viewSummary = [
    search.trim() ? `搜索“${search.trim()}”` : '',
    upstreamStatusLabel,
    ssoRiskLabels[ssoRisk],
    egressNodeId === 'all' ? '全部出口绑定' : `出口节点 ${egressNodeId}`,
    isolationSourceOptions.find((item) => item.value === source)?.label ??
      '全部来源',
    `第 ${page} 页 · 每页 ${pageSize} 条`,
  ]
    .filter(Boolean)
    .join(' · ')
  const activeFilterCount = [
    upstreamStatus !== 'all',
    ssoRisk !== 'all',
    egressNodeId !== 'all',
    source !== 'all',
  ].filter(Boolean).length
  const egressFilterLabel =
    egressNodeId === 'unbound'
      ? '未绑定'
      : (getEgressNodeName(egressNodeNames, egressNodeId) ??
        `节点 #${egressNodeId}`)
  const hasActiveFilters = activeFilterCount > 0 || Boolean(search.trim())

  return (
    <Page>
      <PageHeader
        title='隔离区'
        description={
          <div className='space-y-2'>
            <p>
              隔离后账号默认保留在本地并停用上游，不自动删除 grok2api
              账号。可查看样本，恢复上游需确认；也可批量删除 grok2api
              账号，或只删除本系统记录。
            </p>
            <p>
              来源包括人工移入、请求审计永久停用、探针按监控判定自动隔离，以及 grok2api 降智二次命中后的停用同步。请求审计页面的「高风险」不会直接把账号送进这里，要达到停用次数后才会进来。
            </p>
            <p>
              探针到期停用是另一条可恢复链路；隔离区账号不会走到期自动恢复。
            </p>
          </div>
        }
        hintContentClassName='max-w-[28rem]'
        descriptionAsHint
        actions={
            <ActionToolbar label='隔离区操作'>
              <ToolbarAction
                label='刷新隔离页'
                pending={query.isFetching || statsFetching}
                onClick={() => {
                  void query.refetch()
                  void client.invalidateQueries({
                    queryKey: ['accounts', 'quarantine-stats'],
                  })
                }}
              >
                <RefreshCw />
              </ToolbarAction>
            <ExportMenu
              label='导出隔离名单'
              onExport={(format) => api.exportQuarantine(format)}
            />
            <SelectionToolbar
              wrap={false}
              selectedCount={selected.length}
              entityLabel='账号'
              disabled={selectionActionPending}
              onClear={() => {
                setSelected([])
                setSelectedDisabled([])
                setSelectedMissing([])
              }}
            >
              <ToolbarAction
                label={
                  probeableSelected.length
                    ? selectedMissing.length
                      ? `测试已选 ${probeableSelected.length} 个可探测账号`
                      : `测试已选 ${selected.length} 个账号`
                    : '已选账号缺少上游记录，无法创建探针'
                }
                disabled={
                  selectionActionPending || probeableSelected.length === 0
                }
                onClick={() =>
                  openProbeDialog(
                    probeableSelected,
                    probeableSelected.filter((id) =>
                      selectedDisabledSet.has(id)
                    ).length
                  )
                }
              >
                <Play />
              </ToolbarAction>
              <ToolbarAction
                label={`恢复已选 ${selected.length} 个账号的上游`}
                pending={restorePending}
                disabled={selectionActionPending || selected.length === 0}
                onClick={() => {
                  setRestorePriority('')
                  setRestoreOpen(true)
                }}
              >
                <Undo2 />
              </ToolbarAction>
              <ToolbarAction
                label={`停用已选 ${selected.length} 个账号的上游`}
                destructive
                pending={disablePending}
                disabled={selectionActionPending || selected.length === 0}
                onClick={() => setDisableOpen(true)}
              >
                <PowerOff />
              </ToolbarAction>
              <ToolbarAction
                label={
                  selected.length > 0 && probeableSelected.length === 0
                    ? '已选账号缺少上游记录，无法删除 grok2api 账号'
                    : `删除已选 ${probeableSelected.length} 个账号的上游`
                }
                destructive
                pending={deleteUpstreamPending}
                disabled={
                  selectionActionPending || probeableSelected.length === 0
                }
                onClick={() => {
                  setDeleteUpstreamAlsoLocal(false)
                  setDeleteUpstreamOpen(true)
                }}
              >
                <UserX />
              </ToolbarAction>
              <ToolbarAction
                label={`删除已选 ${selected.length} 个账号的本系统记录`}
                destructive
                pending={deletePending}
                disabled={selectionActionPending || selected.length === 0}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 />
              </ToolbarAction>
            </SelectionToolbar>
          </ActionToolbar>
        }
      />
      <QuarantineStatsBoard />
      <TablePanel
        toolbar={
          <div className='space-y-2' aria-busy={showTableLoading}>
            <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
              <div className='relative min-w-0 flex-1'>
                <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                <Input
                  value={search}
                  onChange={(event) =>
                    updateView({ search: event.target.value, page: 1 })
                  }
                  placeholder='搜索名称、邮箱或账号 ID'
                  className='h-8 pr-8 pl-8'
                />
                {showTableLoading && (
                  <Loader2 className='absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-primary' />
                )}
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant='outline'
                    className='h-8 shrink-0 gap-2 px-3'
                  >
                    <SlidersHorizontal className='size-4' />
                    筛选条件
                    {activeFilterCount > 0 && (
                      <Badge
                        variant='secondary'
                        className='min-w-5 justify-center px-1.5'
                      >
                        {activeFilterCount}
                      </Badge>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align='end'
                  className='w-[min(25rem,calc(100vw-2rem))] p-0'
                >
                  <div className='border-b px-4 py-3'>
                    <div className='flex items-center justify-between gap-3'>
                      <div>
                        <div className='text-sm font-semibold'>隔离筛选</div>
                        <div className='mt-0.5 text-xs text-muted-foreground'>
                          组合条件，快速缩小隔离账号范围
                        </div>
                      </div>
                      {activeFilterCount > 0 && (
                        <Button
                          variant='ghost'
                          size='sm'
                          className='h-8'
                          onClick={() =>
                            updateView({
                              upstreamStatus: 'all',
                              ssoRisk: 'all',
                              egressNodeId: 'all',
                              source: 'all',
                              page: 1,
                            })
                          }
                        >
                          清除全部
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className='space-y-4 p-4'>
                    <div className='space-y-2'>
                      <div className='text-[11px] font-semibold tracking-wide text-muted-foreground uppercase'>
                        上游状态
                      </div>
                      <Select
                        value={upstreamStatus}
                        onValueChange={(value) =>
                          updateView({
                            upstreamStatus:
                              value as IsolationUpstreamStatusFilter,
                            page: 1,
                          })
                        }
                      >
                        <SelectTrigger>
                          <Activity className='size-4 text-muted-foreground' />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {isolationUpstreamStatusOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className='space-y-2'>
                      <div className='text-[11px] font-semibold tracking-wide text-muted-foreground uppercase'>
                        检测与出口
                      </div>
                      <Select
                        value={egressNodeId}
                        onValueChange={(value) =>
                          updateView({ egressNodeId: value, page: 1 })
                        }
                      >
                        <SelectTrigger>
                          <Network className='size-4 text-muted-foreground' />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='all'>全部出口绑定</SelectItem>
                          <SelectItem value='unbound'>未绑定出口</SelectItem>
                          {(egressData?.items ?? []).map((node) => (
                            <SelectItem key={node.id} value={String(node.id)}>
                              {node.name || `节点 #${node.id}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className='space-y-2'>
                      <div className='text-[11px] font-semibold tracking-wide text-muted-foreground uppercase'>
                        隔离来源
                      </div>
                      <Select
                        value={source}
                        onValueChange={(value) =>
                          updateView({
                            source: value as IsolationSourceFilter,
                            page: 1,
                          })
                        }
                      >
                        <SelectTrigger>
                          <ShieldBan className='size-4 text-muted-foreground' />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {isolationSourceOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className='space-y-2'>
                      <div className='text-[11px] font-semibold tracking-wide text-muted-foreground uppercase'>
                        SSO 风控
                      </div>
                      <Select
                        value={ssoRisk}
                        onValueChange={(value) =>
                          updateView({
                            ssoRisk: value as SsoRiskFilter,
                            page: 1,
                          })
                        }
                      >
                        <SelectTrigger>
                          <ShieldAlert className='size-4 text-muted-foreground' />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(ssoRiskLabels).map(
                            ([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            {(activeFilterCount > 0 || search.trim()) && (
              <div className='flex flex-wrap items-center gap-1.5'>
                <span className='mr-1 text-xs text-muted-foreground'>
                  当前条件
                </span>
                {search.trim() && (
                  <FilterChip
                    label={`搜索：${search.trim()}`}
                    onClear={() => updateView({ search: '', page: 1 })}
                  />
                )}
                {upstreamStatus !== 'all' && (
                  <FilterChip
                    label={`上游：${upstreamStatusLabel}`}
                    onClear={() =>
                      updateView({ upstreamStatus: 'all', page: 1 })
                    }
                  />
                )}
                {ssoRisk !== 'all' && (
                  <FilterChip
                    label={`SSO：${ssoRiskLabels[ssoRisk]}`}
                    onClear={() => updateView({ ssoRisk: 'all', page: 1 })}
                  />
                )}
                {egressNodeId !== 'all' && (
                  <FilterChip
                    label={`出口：${egressFilterLabel}`}
                    onClear={() => updateView({ egressNodeId: 'all', page: 1 })}
                  />
                )}
                {source !== 'all' && (
                  <FilterChip
                    label={`来源：${
                      isolationSourceOptions.find(
                        (item) => item.value === source
                      )?.label ?? source
                    }`}
                    onClear={() => updateView({ source: 'all', page: 1 })}
                  />
                )}
              </div>
            )}
          {view.active && (
            <PersistedViewNotice
              restored={view.restored}
              summary={viewSummary}
              onClear={() => {
                beginTableInteraction()
                view.clear()
              }}
            />
          )}
          </div>
        }
        footer={
          accounts.length ? (
            <ServerPagination
              page={page}
              pageSize={pageSize}
              total={query.data?.total ?? 0}
              disabled={showTableLoading}
              loading={showTableLoading}
              itemLabel='账号'
              onPageChange={(value) => {
                beginTableInteraction()
                updateView({ page: value })
              }}
              onPageSizeChange={(value) => {
                beginTableInteraction()
                updateView({ pageSize: value, page: 1 })
              }}
            />
          ) : null
        }
      >
          {query.isLoading && !query.data ? (
            <LoadingState />
          ) : query.isError && !query.data ? (
            <EmptyState
              icon={ShieldBan}
              title='无法加载隔离账号'
              description={getErrorMessage(query.error)}
            />
          ) : accounts.length ? (
            <>
              <div className='relative min-h-40' aria-busy={showTableLoading}>
                <QuarantineTable
                  accounts={accounts}
                  selected={selected}
                  allChecked={allChecked}
                  noteEditorId={noteEditorId}
                  onToggleCurrentPage={toggleCurrentPageSelection}
                  onToggleAccount={toggleAccountSelection}
                  onNoteEditorOpenChange={setNoteEditorOpen}
                  onOpenUpstream={openAccountUpstream}
                  onOpenSamples={openAccountSamples}
                  onPreview={(account) => {
                    previewSeeded.current = false
                    setPreviewIndex(0)
                    setPreviewPage(1)
                    setPreviewLand(undefined)
                    setPreviewAccount(account)
                  }}
                  onProbe={(account) => {
                    const id = Number(account.id)
                    if (account.missingUpstream) {
                      toast.error('该账号缺少上游记录，无法创建探针任务')
                      return
                    }
                    openProbeDialog([id], account.enabled ? 0 : 1)
                  }}
                />
                {showTableLoading && (
                  <ServerTableLoadingOverlay
                    page={page}
                    itemLabel='账号'
                    message='正在更新隔离筛选结果…'
                  />
                )}
              </div>
            </>
          ) : (
            <div className='relative min-h-48' aria-busy={showTableLoading}>
              <EmptyState
                icon={ShieldBan}
                title={
                  hasActiveFilters ? '没有匹配的隔离账号' : '当前没有隔离账号'
                }
                description={
                  hasActiveFilters
                    ? '没有匹配当前筛选的隔离账号，请调整条件后重试。'
                    : '隔离后账号会保留在本地并停用上游；可从账号探针人工移入。'
                }
                action={
                  hasActiveFilters ? undefined : (
                    <Button asChild>
                      <Link to='/accounts'>去账号探针</Link>
                    </Button>
                  )
                }
              />
              {showTableLoading && (
                <ServerTableLoadingOverlay
                  page={page}
                  itemLabel='账号'
                  message='正在更新隔离筛选结果…'
                />
              )}
            </div>
          )}
      </TablePanel>

      <ConfirmDialog
        open={restoreOpen}
        onOpenChange={(open) => {
          if (!open && !restorePending) setRestoreOpen(false)
        }}
        title={`恢复 ${selected.length} 个账号的上游？`}
        desc={
          <div className='space-y-2'>
            <p>
              恢复会按隔离前状态重新启用上游，降智/高风险账号回到调度池可能继续被风控。
            </p>
            <p className='text-muted-foreground'>
              这不会删除 grok2api 账号，也不会清除本系统已保存的评估和样本。
            </p>
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          restorePending ? (
            <>
              <Loader2 className='animate-spin' />
              恢复中…
            </>
          ) : (
            <>
              <Undo2 />
              确认恢复上游
            </>
          )
        }
        isLoading={restorePending}
        disabled={selected.length === 0 || Boolean(restorePriorityParsed.error)}
        handleConfirm={() => {
          if (restorePriorityParsed.error) return
          restoreMutation.mutate({
            accountIds: selected,
            priority: restorePriorityParsed.priority,
          })
        }}
      >
        <div className='space-y-2'>
          <Label htmlFor='quarantine-restore-priority'>上游优先级</Label>
          <Input
            id='quarantine-restore-priority'
            inputMode='numeric'
            value={restorePriority}
            onChange={(event) => setRestorePriority(event.target.value)}
            placeholder='留空则保持当前优先级'
            disabled={restorePending}
          />
          <p
            className={cn(
              'text-xs leading-5',
              restorePriorityParsed.error
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            {restorePriorityParsed.error ||
              '可选。恢复后写入 grok2api，数字越大越优先调度。'}
          </p>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={disableOpen}
        onOpenChange={(open) => {
          if (!open && !disablePending) setDisableOpen(false)
        }}
        title={`停用 ${selected.length} 个账号的上游？`}
        desc={
          <div className='space-y-2'>
            <p>
              将通过 grok2api 把已选账号设为停用，账号仍留在隔离区，不会移出隔离区，也不会删除 grok2api 账号。
            </p>
            <p className='text-muted-foreground'>
              已经停用的账号会再次写入停用状态。正在执行探针或等待账号设置恢复的账号会被跳过并保留选择。
            </p>
            <p className='font-medium text-foreground'>
              这只改上游启用状态，不清除本系统评估、样本和隔离备注。
            </p>
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          disablePending ? (
            <>
              <Loader2 className='animate-spin' />
              停用中…
            </>
          ) : (
            <>
              <PowerOff />
              确认停用上游
            </>
          )
        }
        destructive
        isLoading={disablePending}
        disabled={selected.length === 0}
        handleConfirm={() => disableMutation.mutate(selected)}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !deletePending) setDeleteOpen(false)
        }}
        title={`删除 ${selected.length} 个账号的本系统记录？`}
        desc={
          <div className='space-y-2'>
            <p>
              只删除 GrokIQ 本地评估/样本/告警，不会删除 grok2api
              账号；上游若仍停用会保持停用。
            </p>
            <p className='font-medium text-foreground'>
              删除后这些账号会离开隔离区列表，本地证据不可恢复。
            </p>
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          deletePending ? (
            <>
              <Loader2 className='animate-spin' />
              删除中…
            </>
          ) : (
            <>
              <Trash2 />
              确认删除本系统记录
            </>
          )
        }
        destructive
        isLoading={deletePending}
        disabled={selected.length === 0}
        handleConfirm={() => deleteMutation.mutate(selected)}
      />
      <ConfirmDialog
        open={deleteUpstreamOpen}
        onOpenChange={(open) => {
          if (!open && !deleteUpstreamPending) {
            setDeleteUpstreamOpen(false)
            setDeleteUpstreamAlsoLocal(false)
          }
        }}
        title={`删除 ${probeableSelected.length} 个账号的上游？`}
        desc={
          <div className='space-y-2'>
            <p>
              将通过 grok2api API 永久删除当前 {probeableSelected.length}{' '}
              个有上游记录的账号，此操作不可撤销。
            </p>
            <p className='font-medium text-foreground'>
              {deleteUpstreamAlsoLocal
                ? '勾选后，上游删除成功的账号会继续删除 GrokIQ 本地评估、样本和隔离记录，并离开隔离区列表。'
                : '默认不会删除 GrokIQ 本地评估、样本和隔离记录；那些会保留，直到使用「删除本系统记录」。'}
            </p>
            <p className='text-muted-foreground'>
              正在执行探针或等待账号设置恢复的账号会被跳过并保留选择。
            </p>
            <p className='text-muted-foreground'>
              已选但标记为上游缺失的账号不会包含在这次删除里。
            </p>
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          deleteUpstreamPending ? (
            <>
              <Loader2 className='animate-spin' />
              删除中…
            </>
          ) : deleteUpstreamAlsoLocal ? (
            <>
              <UserX />
              确认删除上游和本地记录
            </>
          ) : (
            <>
              <UserX />
              确认删除上游
            </>
          )
        }
        destructive
        isLoading={deleteUpstreamPending}
        disabled={probeableSelected.length === 0}
        handleConfirm={() =>
          deleteUpstreamMutation.mutate({
            accountIds: probeableSelected,
            alsoDeleteLocal: deleteUpstreamAlsoLocal,
          })
        }
      >
        <div className='flex items-start gap-2 rounded-lg border p-3'>
          <Checkbox
            id='quarantine-delete-upstream-also-local'
            checked={deleteUpstreamAlsoLocal}
            disabled={deleteUpstreamPending}
            onCheckedChange={(value) =>
              setDeleteUpstreamAlsoLocal(value === true)
            }
            className='mt-0.5'
          />
          <div className='space-y-1'>
            <Label
              htmlFor='quarantine-delete-upstream-also-local'
              className='text-sm font-medium leading-5'
            >
              同时删除本地隔离记录
            </Label>
            <p className='text-xs leading-5 text-muted-foreground'>
              仅处理上游删除成功的账号；失败或被跳过的账号会保留选择。
            </p>
          </div>
        </div>
      </ConfirmDialog>
      <Dialog open={upstreamOpen} onOpenChange={setUpstreamOpen}>
        <DialogContent size='wide' className='overflow-hidden'>
          <DialogHeader className='shrink-0'>
            <DialogTitle className='flex items-center gap-2'>
              <Server className='size-5 text-primary' />
              <span className='min-w-0 truncate'>
                {upstreamListAccount?.name ||
                  upstreamListAccount?.email ||
                  `账号 ${upstreamId}`}
              </span>
              {upstreamListAccount ? (
                <CopyButton
                  value={
                    upstreamListAccount.email?.trim() ||
                    String(upstreamListAccount.id)
                  }
                  className='size-6'
                />
              ) : null}
            </DialogTitle>
            <DialogDescription>
              {upstreamListAccount
                ? formatAccountSecondaryLabel({
                    id: upstreamListAccount.id,
                    email: upstreamListAccount.email,
                    createdAt: upstreamListAccount.createdAt,
                    accountLabel:
                      upstreamListAccount.name ||
                      upstreamListAccount.email ||
                      `账号 ${upstreamId}`,
                  })
                : '查看 grok2api 上游账号的全部字段'}
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain pe-1'>
            {upstreamQuery.isLoading && !upstreamQuery.data ? (
              <LoadingState />
            ) : upstreamQuery.isError ? (
              <EmptyState
                icon={Server}
                title='无法加载上游账号'
                description={getErrorMessage(upstreamQuery.error)}
                compact
              />
            ) : upstreamQuery.data?.missingUpstream ||
              upstreamQuery.data?.account == null ? (
              <EmptyState
                icon={Server}
                title='上游账号不存在'
                description='grok2api 里已经找不到这个账号，只剩本系统隔离记录。'
                compact
              />
            ) : (
              <QuarantineUpstreamDetail account={upstreamQuery.data.account} />
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ResultPreviewGallery
        open={previewAccount != null}
        onOpenChange={(open) => {
          if (!open) setPreviewAccount(null)
        }}
        items={previewItems}
        index={previewIndex}
        onIndexChange={setPreviewIndex}
        page={previewPage}
        pageCount={Math.max(
          1,
          Math.ceil((previewQuery.data?.total ?? 0) / 50)
        )}
        total={previewQuery.data?.total}
        pageLoading={
          previewQuery.isFetching && previewQuery.data?.page !== previewPage
        }
        onPageChange={(nextPage, land) => {
          previewSeeded.current = false
          setPreviewLand(land)
          setPreviewPage(nextPage)
          setPreviewIndex(0)
        }}
        onOpenQuarantine={() => setPreviewAccount(null)}
      />
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent size='wide' className='overflow-hidden'>
          <DialogHeader className='shrink-0'>
            <DialogTitle className='flex items-center gap-2'>
              <ShieldBan className='size-5 text-primary' />
              <span className='min-w-0 truncate'>
                {detailAccount?.name ||
                  detailAccount?.email ||
                  `账号 ${detailId}`}
              </span>
              {detailAccount ? (
                <CopyButton
                  value={
                    detailAccount.email?.trim() || String(detailAccount.id)
                  }
                  className='size-6'
                />
              ) : null}
            </DialogTitle>
            <DialogDescription>
              {detailAccount
                ? formatAccountSecondaryLabel({
                    id: detailAccount.id,
                    email: detailAccount.email,
                    createdAt: detailAccount.createdAt,
                    accountLabel:
                      detailAccount.name ||
                      detailAccount.email ||
                      `账号 ${detailId}`,
                  })
                : '查看隔离账号的探针样本'}
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain pe-1'>
            {samplesQuery.isLoading && !samplesQuery.data ? (
              <LoadingState />
            ) : (
              <QuarantineSampleDetail
                account={detailAccount}
                samples={samples}
                egressNodeNames={egressNodeNames}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ProbeDialog
        open={probeOpen}
        onOpenChange={setProbeOpen}
        accountIds={probeAccountIds}
        disabledAccountCount={probeDisabledCount}
        profiles={profiles.data ?? []}
        profilesLoading={profiles.isFetching && !profiles.data}
        profilesError={profiles.isError ? getErrorMessage(profiles.error) : ''}
        onRefreshProfiles={() => void profiles.refetch()}
        egress={egressData?.items ?? []}
        egressLoading={egressFetching}
        egressError={egressIsError ? getErrorMessage(egressQueryError) : ''}
        onRefreshEgress={() => void refetchEgress()}
        onCreated={() => {
          setSelected([])
          setSelectedDisabled([])
          setSelectedMissing([])
          setProbeAccountIds([])
          setProbeDisabledCount(0)
          void client.invalidateQueries({ queryKey: ['runs'] })
          void client.invalidateQueries({ queryKey: ['dashboard'] })
          void client.invalidateQueries({ queryKey: ['accounts'] })
        }}
      />
    </Page>
  )
}

function isolationTimestamp(account: UpstreamAccount) {
  return account.assessment?.disposition?.at || account.assessment?.updated_at || null
}

function IsolationTimeCell({ account }: { account: UpstreamAccount }) {
  const value = isolationTimestamp(account)
  if (!value) {
    return <span className='text-muted-foreground'>—</span>
  }
  return (
    <div className='min-w-32'>
      <div className='whitespace-nowrap tabular-nums'>{formatDate(value)}</div>
      <div className='text-xs text-muted-foreground'>{formatRelativeTime(value)}</div>
    </div>
  )
}

function QuarantineTable({
  accounts,
  selected,
  allChecked,
  noteEditorId,
  onToggleCurrentPage,
  onToggleAccount,
  onNoteEditorOpenChange,
  onOpenUpstream,
  onOpenSamples,
  onPreview,
  onProbe,
}: {
  accounts: UpstreamAccount[]
  selected: number[]
  allChecked: boolean
  noteEditorId: number | null
  onToggleCurrentPage: (checked: boolean) => void
  onToggleAccount: (id: number, checked: boolean) => void
  onNoteEditorOpenChange: (id: number, open: boolean) => void
  onOpenUpstream: (id: number) => void
  onOpenSamples: (id: number) => void
  onPreview: (account: UpstreamAccount) => void
  onProbe: (account: UpstreamAccount) => void
}) {
  const selectedIdSet = useMemo(() => new Set(selected), [selected])
  return (
    <Table
      rememberRowKey='monitor-quarantine'
      className='[&_td]:py-1.5 [&_th]:h-8'
    >
      <TableHeader>
        <TableRow>
          <TableHead className='w-10'>
            <Checkbox
              checked={allChecked}
              onCheckedChange={(value) => onToggleCurrentPage(value === true)}
              aria-label='选择当前页隔离账号'
            />
          </TableHead>
          <TableHead>账号</TableHead>
          <TableHead>监控判定</TableHead>
          <TableHead>上游启用状态</TableHead>
          <TableHead>样本数</TableHead>
          <TableHead>最近样本时间</TableHead>
          <TableHead>隔离时间</TableHead>
          <TableHead>隔离原因</TableHead>
          <TableHead>备注</TableHead>
          <TableHead className='text-right'>操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => {
          const id = Number(account.id)
          return (
            <QuarantineRow
              key={account.id}
              account={account}
              selected={selectedIdSet.has(id)}
              noteOpen={noteEditorId === id}
              onSelectedChange={(checked) => onToggleAccount(id, checked)}
              onNoteOpenChange={(open) => onNoteEditorOpenChange(id, open)}
              onOpenUpstream={() => onOpenUpstream(id)}
              onOpenSamples={() => onOpenSamples(id)}
              onPreview={() => onPreview(account)}
              onProbe={() => onProbe(account)}
            />
          )
        })}
      </TableBody>
    </Table>
  )
}

function QuarantineRow({
  account,
  selected,
  noteOpen,
  onSelectedChange,
  onNoteOpenChange,
  onOpenUpstream,
  onOpenSamples,
  onPreview,
  onProbe,
}: {
  account: UpstreamAccount
  selected: boolean
  noteOpen: boolean
  onSelectedChange: (checked: boolean) => void
  onNoteOpenChange: (open: boolean) => void
  onOpenUpstream: () => void
  onOpenSamples: () => void
  onPreview: () => void
  onProbe: () => void
}) {
  const id = Number(account.id)
  const assessment = account.assessment
  const accountLabel = account.name || account.email || `账号 ${id}`
  const secondaryAccountLabel = formatAccountSecondaryLabel({
    id: account.id,
    email: account.email,
    createdAt: account.createdAt,
    accountLabel,
  })
  const origin = dispositionOrigin(assessment?.disposition)
  return (
    <TableRow rowId={id}>
      <TableCell>
        <Checkbox
          checked={selected}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={`选择账号 ${accountLabel}`}
        />
      </TableCell>
      <TableCell>
        <div className='flex items-start gap-1'>
          <div className='min-w-0'>
            <div className='flex flex-wrap items-center gap-1.5'>
              <div className='font-medium'>{accountLabel}</div>
              {origin.originLabel ? (
                <Badge
                  variant={
                    origin.origin === 'grok2api' ? 'secondary' : 'outline'
                  }
                  className='h-5 px-1.5 text-[10px]'
                >
                  {origin.originLabel}
                </Badge>
              ) : null}
            </div>
            <div
              className='max-w-80 text-xs text-muted-foreground'
              title={secondaryAccountLabel}
            >
              {secondaryAccountLabel}
            </div>
          </div>
          <CopyButton
            value={account.email?.trim() || String(id)}
            className='size-6'
          />
        </div>
      </TableCell>
      <TableCell>
        <MonitorStatusCell
          status={assessment?.monitor_status}
          score={assessment?.risk_score}
        />
      </TableCell>
      <TableCell>
        {account.missingUpstream ? (
          <Badge variant='outline'>上游缺失</Badge>
        ) : (
          <EnabledBadge enabled={account.enabled} prefix='上游' />
        )}
      </TableCell>
      <TableCell>
        <span className='tabular-nums'>{assessment?.sample_count ?? 0}</span>
      </TableCell>
      <TableCell className='whitespace-nowrap tabular-nums'>
        {formatDate(assessment?.latest_sample_at)}
      </TableCell>
      <TableCell>
        <IsolationTimeCell account={account} />
      </TableCell>
      <TableCell>
        <RiskReasonCell account={account} />
      </TableCell>
      <TableCell>
        <OperatorNoteCell
          account={account}
          open={noteOpen}
          onOpenChange={onNoteOpenChange}
        />
      </TableCell>
      <TableCell className='text-right'>
        <div className='inline-flex items-center justify-end'>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size='icon'
                variant='ghost'
                disabled={Boolean(account.missingUpstream)}
                onClick={onProbe}
                aria-label={`为 ${accountLabel} 创建探针任务`}
              >
                <Play />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {account.missingUpstream
                ? '缺少上游记录，无法创建探针'
                : '创建探针任务'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size='icon'
                variant='ghost'
                onClick={onOpenUpstream}
                aria-label={`查看 ${accountLabel} 的上游信息`}
              >
                <Server />
              </Button>
            </TooltipTrigger>
            <TooltipContent>查看上游信息</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size='icon'
                variant='ghost'
                onClick={onPreview}
                aria-label={`预览 ${accountLabel} 的结果`}
              >
                <Images />
              </Button>
            </TooltipTrigger>
            <TooltipContent>预览结果</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size='icon'
                variant='ghost'
                onClick={onOpenSamples}
                aria-label={`查看 ${accountLabel} 的样本`}
              >
                <Eye />
              </Button>
            </TooltipTrigger>
            <TooltipContent>查看样本</TooltipContent>
          </Tooltip>
        </div>
      </TableCell>
    </TableRow>
  )
}

function QuarantineSampleDetail({
  account,
  samples,
  egressNodeNames,
}: {
  account: UpstreamAccount | null
  samples: ProbeSample[]
  egressNodeNames: EgressNodeNameMap
}) {
  const reasons = account?.assessment?.risk_reasons ?? []
  const notes = account ? accountOperatorNotes(account) : []
  const disposition = account?.assessment?.disposition
  return (
    <div className='space-y-4'>
      {account && (
        <div className='flex flex-wrap items-center gap-2'>
          <MonitorStatusCell
            status={account.assessment?.monitor_status}
            score={account.assessment?.risk_score}
          />
          {account.missingUpstream ? (
            <Badge variant='outline'>上游缺失</Badge>
          ) : (
            <EnabledBadge enabled={account.enabled} prefix='上游' />
          )}
          <span className='text-xs text-muted-foreground'>
            {account.assessment?.sample_count ?? samples.length} 条样本
          </span>
        </div>
      )}
      {notes.length > 0 ? (
        <div className='rounded-lg border bg-muted/30 p-3'>
          <div className='flex items-center gap-2 text-sm font-medium'>
            <StickyNote className='size-4 text-muted-foreground' />
            隔离备注
          </div>
          <ul className='mt-2 space-y-2'>
            {notes.map((note) => (
              <li key={note.id} className='text-sm leading-6'>
                <div className='text-[11px] text-muted-foreground tabular-nums'>
                  {note.updated_at || note.created_at
                    ? formatDate(note.updated_at || note.created_at)
                    : '时间未知'}
                  {note.updated_at ? ' · 已修改' : ''}
                </div>
                <p className='whitespace-pre-wrap text-muted-foreground'>
                  {note.content}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <DispositionBanner disposition={disposition} sampleReasons={reasons} />
      <AccountSampleExplorer
        key={account?.id ?? 'quarantine-samples'}
        samples={samples}
        egressNodeNames={egressNodeNames}
      />
    </div>
  )
}

function QuarantineUpstreamDetail({
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
