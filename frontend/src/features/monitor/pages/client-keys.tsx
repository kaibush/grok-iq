import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Ban,
  BarChart3,
  CalendarDays,
  CreditCard,
  Eye,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Power,
  RefreshCw,
  Search,
  Trash2,
  Users,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  type ClientKeyPlanType,
  type ManagedClientKey,
  type ScheduleExecution,
} from '@/lib/api'
import { cn, formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ProgressBar } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ActionToolbar, ToolbarAction } from '@/components/action-toolbar'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton, CopyableText } from '@/components/copy-button'
import { NumericInput } from '@/components/numeric-input'
import { EmptyState, LoadingState, Page, PageHeader } from '@/components/page'
import { SelectionToolbar } from '@/components/selection-toolbar'
import { ServerPagination } from '@/components/server-pagination'
import { StatCard } from '@/components/stat-card'
import { TablePanel } from '@/components/table-panel'
import { TitledCard } from '@/components/titled-card'
import { ClientKeyUsageDialog } from '@/features/monitor/components/client-key-usage-dialog'

const PAGE_SIZE_OPTIONS = [20, 50, 100]
const MAX_BILLING_LIMIT_USD = 900_000
const PAID_KEY_AUTO_TOPUP_JOB = 'system:paid-key-auto-topup'
const PAID_OPTIONS = [
  { value: 'all', label: '全部用户' },
  { value: 'paid', label: '付费用户' },
  { value: 'unpaid', label: '未付费' },
] as const
const PLAN_OPTIONS = [
  { value: 'all', label: '全部卡种' },
  { value: 'day', label: '天卡' },
  { value: 'week', label: '周卡' },
  { value: 'month', label: '月卡' },
  { value: 'none', label: '未设卡种' },
] as const
const ENABLED_OPTIONS = [
  { value: 'all', label: '全部启停' },
  { value: 'true', label: '已启用' },
  { value: 'false', label: '已停用' },
] as const
const UPSTREAM_OPTIONS = [
  { value: 'all', label: '全部同步状态' },
  { value: 'present', label: '仍在 grok2api' },
  { value: 'missing', label: '上游已消失' },
] as const

const PLAN_LABELS: Record<ClientKeyPlanType, string> = {
  none: '未设卡种',
  day: '天卡',
  week: '周卡',
  month: '月卡',
}

type PaidFilter = (typeof PAID_OPTIONS)[number]['value']
type PlanFilter = (typeof PLAN_OPTIONS)[number]['value']
type EnabledFilter = (typeof ENABLED_OPTIONS)[number]['value']
type UpstreamFilter = (typeof UPSTREAM_OPTIONS)[number]['value']

type EditorState = {
  id: string
  name: string
  maskedKey: string
  enabled: boolean
  expiresUnlimited: boolean
  expiresAt: string
  rpmUnlimited: boolean
  rpmLimit: number
  concurrencyUnlimited: boolean
  maxConcurrent: number
  billingUnlimited: boolean
  billingLimitUsd: number
  upstreamMissing: boolean
  paid: boolean
  planType: ClientKeyPlanType
  rechargeYuan: number
  note: string
}

type SecretState = {
  name: string
  secret: string
}

export function ClientKeysPage() {
  const queryClient = useQueryClient()
  const [draftQuery, setDraftQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [paid, setPaid] = useState<PaidFilter>('all')
  const [planType, setPlanType] = useState<PlanFilter>('all')
  const [enabled, setEnabled] = useState<EnabledFilter>('all')
  const [upstream, setUpstream] = useState<UpstreamFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [selectedNames, setSelectedNames] = useState<Record<string, string>>({})
  const [usageIds, setUsageIds] = useState<string[]>([])
  const [usageOpen, setUsageOpen] = useState(false)
  const [secret, setSecret] = useState<SecretState | null>(null)
  const [deleting, setDeleting] = useState<ManagedClientKey | null>(null)
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)

  const listParams = {
    q: appliedQuery,
    paid: paid === 'all' ? '' : paid,
    planType: planType === 'all' ? '' : planType,
    enabled: enabled === 'all' ? '' : enabled,
    upstream: upstream === 'all' ? '' : upstream,
  }

  const keysQuery = useQuery({
    queryKey: ['client-keys', appliedQuery, paid, planType, enabled, upstream, page, pageSize],
    queryFn: () =>
      api.clientKeys({
        ...listParams,
        page,
        pageSize,
      }),
    placeholderData: (previous) => previous,
  })

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings,
  })
  const schedulerQuery = useQuery({
    queryKey: ['scheduler'],
    queryFn: api.scheduler,
    refetchInterval: 15_000,
  })

  const syncMutation = useMutation({
    mutationFn: () => api.syncClientKeys(),
    onSuccess: async (result) => {
      const parts = [
        `已同步 ${formatNumber(result.fetched, 0)} 个密钥`,
        `新增 ${formatNumber(result.created, 0)}`,
        `更新 ${formatNumber(result.updated, 0)}`,
      ]
      if (result.skippedProbeKeys > 0) {
        parts.push(`跳过 ${formatNumber(result.skippedProbeKeys, 0)} 个探针密钥`)
      }
      if (result.skippedSystemKeys > 0) {
        parts.push(`跳过 ${formatNumber(result.skippedSystemKeys, 0)} 个系统密钥`)
      }
      if (result.missing > 0) {
        parts.push(`${formatNumber(result.missing, 0)} 个上游已消失`)
      }
      toast.success(parts.join('，'))
      await queryClient.invalidateQueries({ queryKey: ['client-keys'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const updateMutation = useMutation({
    mutationFn: async (payload: EditorState) => {
      const error = editorValidation(payload)
      if (error) throw new Error(error)
      const body: Parameters<typeof api.updateClientKey>[1] = {
        paid: payload.paid,
        planType: payload.paid ? payload.planType : 'none',
        rechargeYuan: payload.rechargeYuan.toFixed(2),
        note: payload.note,
      }
      if (!payload.upstreamMissing) {
        body.name = payload.name.trim()
        body.enabled = payload.enabled
        body.expiresAt = payload.expiresUnlimited
          ? ''
          : toIso(payload.expiresAt)
        body.rpmLimit = payload.rpmUnlimited ? 0 : payload.rpmLimit
        body.maxConcurrent = payload.concurrencyUnlimited
          ? 0
          : payload.maxConcurrent
        body.billingLimitUsd = payload.billingUnlimited
          ? 0
          : payload.billingLimitUsd
      }
      return api.updateClientKey(payload.id, body)
    },
    onSuccess: async (result) => {
      toast.success(`已保存 ${result.name || result.maskedKey}`)
      setEditor(null)
      await queryClient.invalidateQueries({ queryKey: ['client-keys'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const batchEnabledMutation = useMutation({
    mutationFn: (payload: { ids: string[]; enabled: boolean; clear?: boolean }) =>
      api.batchUpdateClientKeysEnabled(payload.ids, payload.enabled),
    onSuccess: async (result, payload) => {
      if (payload.clear) commitSelection(new Set())
      toast.success(
        `${payload.enabled ? '已启用' : '已停用'} ${formatNumber(result.updated, 0)} 个密钥`
      )
      await queryClient.invalidateQueries({ queryKey: ['client-keys'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteClientKey(id),
    onSuccess: async () => {
      if (deleting) {
        const next = new Set(selected)
        next.delete(deleting.id)
        commitSelection(next)
      }
      setDeleting(null)
      toast.success('已删除密钥')
      await queryClient.invalidateQueries({ queryKey: ['client-keys'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const batchDeleteMutation = useMutation({
    mutationFn: () => api.deleteClientKeys([...selected]),
    onSuccess: async (result) => {
      commitSelection(new Set())
      setBatchDeleteOpen(false)
      toast.success(`已删除 ${formatNumber(result.deleted, 0)} 个密钥`)
      await queryClient.invalidateQueries({ queryKey: ['client-keys'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const secretMutation = useMutation({
    mutationFn: (row: ManagedClientKey) =>
      api.getClientKeySecret(row.id).then((result) => ({
        name: row.name || row.maskedKey,
        secret: result.secret,
      })),
    onSuccess: (result) => setSecret(result),
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const selectMatchingMutation = useMutation({
    mutationFn: () => api.clientKeyIds(listParams),
    onSuccess: (result) => {
      if (result.ids.length === 0) {
        toast.error('当前筛选没有可选择的密钥')
        return
      }
      const matching = new Set(result.ids)
      const alreadySelected =
        matching.size === selected.size &&
        [...matching].every((id) => selected.has(id))
      if (alreadySelected) {
        commitSelection(new Set())
        toast.success('已清除当前筛选的选择')
        return
      }
      commitSelection(matching)
      if (result.truncated) {
        toast.success(
          `已选中前 ${formatNumber(result.ids.length, 0)} 个匹配密钥，共 ${formatNumber(result.total, 0)} 个`
        )
        return
      }
      toast.success(`已选中 ${formatNumber(result.ids.length, 0)} 个匹配密钥`)
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const autoTopupMutation = useMutation({
    mutationFn: () => api.runClientKeyAutoTopup(),
    onSuccess: async (result) => {
      if (result.skipped === true) {
        toast.success(result.error || '付费密钥自动加额已关闭')
      } else {
        const parts = [`已加额 ${formatNumber(result.toppedUp, 0)} 个密钥`]
        if (typeof result.skipped === 'number' && result.skipped > 0) {
          parts.push(`跳过 ${formatNumber(result.skipped, 0)}`)
        }
        if (result.failed > 0) {
          parts.push(`失败 ${formatNumber(result.failed, 0)}`)
        }
        if (result.syncError) {
          parts.push(`同步警告：${result.syncError}`)
        }
        toast.success(parts.join('，'))
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['client-keys'] }),
        queryClient.invalidateQueries({ queryKey: ['scheduler'] }),
      ])
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const ledger = keysQuery.data
  const rows = ledger?.items ?? []
  const summary = ledger?.summary
  const loading = keysQuery.isPending && !keysQuery.data
  const error = keysQuery.isError ? getErrorMessage(keysQuery.error) : ''
  const editorError = editor ? editorValidation(editor) : ''
  const pageIds = rows.map((row) => row.id)
  const selectedOnPage = pageIds.filter((id) => selected.has(id))
  const allPageSelected =
    pageIds.length > 0 && selectedOnPage.length === pageIds.length
  const pageNames = useMemo(() => {
    const next: Record<string, string> = {}
    for (const row of rows) next[row.id] = row.name || row.maskedKey
    return next
  }, [rows])
  const busy =
    updateMutation.isPending ||
    batchEnabledMutation.isPending ||
    deleteMutation.isPending ||
    batchDeleteMutation.isPending ||
    secretMutation.isPending ||
    selectMatchingMutation.isPending ||
    autoTopupMutation.isPending
  const hasFilters =
    appliedQuery !== '' ||
    paid !== 'all' ||
    planType !== 'all' ||
    enabled !== 'all' ||
    upstream !== 'all'

  function submitSearch() {
    setAppliedQuery(draftQuery.trim())
    setPage(1)
  }

  function changeFilter<T extends string>(setter: (value: T) => void, value: T) {
    setter(value)
    setPage(1)
  }

  function rememberNames(items: ManagedClientKey[]) {
    setSelectedNames((current) => {
      let changed = false
      const next = { ...current }
      for (const item of items) {
        const name = item.name || item.maskedKey
        if (next[item.id] === name) continue
        next[item.id] = name
        changed = true
      }
      return changed ? next : current
    })
  }

  function commitSelection(next: Set<string>) {
    setSelected(next)
    if (next.size === 0) {
      setUsageOpen(false)
      setUsageIds([])
    }
  }

  function togglePage(checked: boolean) {
    if (checked) rememberNames(rows)
    const next = new Set(selected)
    for (const id of pageIds) {
      if (checked) next.add(id)
      else next.delete(id)
    }
    commitSelection(next)
  }

  function toggleKey(row: ManagedClientKey, checked: boolean) {
    if (checked) rememberNames([row])
    const next = new Set(selected)
    if (checked) next.add(row.id)
    else next.delete(row.id)
    commitSelection(next)
  }

  function openUsage(ids: string[]) {
    if (ids.length === 0) {
      toast.error('请先选择密钥')
      return
    }
    setUsageIds(ids)
    setUsageOpen(true)
  }

  return (
    <Page>
      <PageHeader
        title='密钥管理'
        description='从 grok2api 同步 Client Key，并可写回名称、启停、过期时间和额度。付费标记、卡种和累计充值仍只保存在 GrokIQ。'
        actions={
          <ActionToolbar label='密钥管理操作'>
            <ToolbarAction
              label='从 grok2api 同步'
              pending={syncMutation.isPending}
              onClick={() => syncMutation.mutate()}
            >
              <RefreshCw />
            </ToolbarAction>
            <ToolbarAction
              label='刷新列表'
              pending={keysQuery.isFetching && !syncMutation.isPending}
              onClick={() => {
                void keysQuery.refetch()
                void schedulerQuery.refetch()
              }}
            >
              <KeyRound />
            </ToolbarAction>
            <SelectionToolbar
              wrap={false}
              selectedCount={selected.size}
              entityLabel='密钥'
              disabled={busy}
              onClear={() => commitSelection(new Set())}
            >
              <ToolbarAction
                label={`查看用量（${selected.size}）`}
                disabled={busy || selected.size === 0}
                onClick={() => openUsage([...selected])}
              >
                <BarChart3 />
              </ToolbarAction>
              <ToolbarAction
                label={`启用已选 ${selected.size} 个密钥`}
                pending={batchEnabledMutation.isPending}
                disabled={busy || selected.size === 0}
                onClick={() =>
                  batchEnabledMutation.mutate({
                    ids: [...selected],
                    enabled: true,
                    clear: true,
                  })
                }
              >
                <Power />
              </ToolbarAction>
              <ToolbarAction
                label={`停用已选 ${selected.size} 个密钥`}
                pending={batchEnabledMutation.isPending}
                disabled={busy || selected.size === 0}
                onClick={() =>
                  batchEnabledMutation.mutate({
                    ids: [...selected],
                    enabled: false,
                    clear: true,
                  })
                }
              >
                <Ban />
              </ToolbarAction>
              <ToolbarAction
                label={`删除已选 ${selected.size} 个密钥`}
                destructive
                disabled={busy || selected.size === 0}
                onClick={() => setBatchDeleteOpen(true)}
              >
                <Trash2 />
              </ToolbarAction>
            </SelectionToolbar>
          </ActionToolbar>
        }
      />

      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        <StatCard
          compact
          label='密钥'
          value={summary ? formatNumber(summary.total, 0) : '—'}
          detail={
            summary?.lastSyncedAt
              ? `最近同步 ${formatDate(summary.lastSyncedAt)}`
              : '尚未从 grok2api 同步'
          }
          icon={KeyRound}
          tone='sky'
          loading={loading}
          index={0}
        />
        <StatCard
          compact
          label='付费用户'
          value={summary ? formatNumber(summary.paid, 0) : '—'}
          detail={`未付费 ${summary ? formatNumber(summary.unpaid, 0) : '—'}`}
          icon={Users}
          tone='emerald'
          loading={loading}
          index={1}
        />
        <StatCard
          compact
          label='卡种'
          value={
            summary
              ? `${formatNumber(summary.day, 0)} / ${formatNumber(summary.week, 0)} / ${formatNumber(summary.month, 0)}`
              : '—'
          }
          detail='天卡 / 周卡 / 月卡'
          icon={CalendarDays}
          tone='amber'
          loading={loading}
          index={2}
        />
        <StatCard
          compact
          label='累计充值'
          value={summary ? formatYuan(summary.rechargeYuan) : '—'}
          detail={
            summary && summary.missing > 0
              ? `${formatNumber(summary.missing, 0)} 个上游已消失`
              : '按当前筛选合计'
          }
          icon={Wallet}
          tone='violet'
          loading={loading}
          index={3}
        />
      </div>

      <AutoTopupStatusCard
        enabled={settingsQuery.data?.paidKeyAutoTopupEnabled ?? true}
        thresholdPercent={
          settingsQuery.data?.paidKeyAutoTopupThresholdPercent ?? 30
        }
        amountUsd={settingsQuery.data?.paidKeyAutoTopupAmountUsd ?? 100}
        intervalSeconds={
          settingsQuery.data?.paidKeyAutoTopupIntervalSeconds ?? 60
        }
        nextRunAt={
          schedulerQuery.data?.systemJobs.find(
            (job) => job.id === PAID_KEY_AUTO_TOPUP_JOB
          )?.nextRunAt ?? null
        }
        lastExecution={
          schedulerQuery.data?.executions.find(
            (item) => item.schedule_key === PAID_KEY_AUTO_TOPUP_JOB
          ) ?? null
        }
        loading={settingsQuery.isPending || schedulerQuery.isPending}
        pending={autoTopupMutation.isPending}
        onRun={() => autoTopupMutation.mutate()}
      />

      <TablePanel
        toolbar={
          <form
            className='flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center'
            onSubmit={(event) => {
              event.preventDefault()
              submitSearch()
            }}
          >
            <div className='relative min-w-0 flex-1'>
              <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
              <Input
                value={draftQuery}
                onChange={(event) => setDraftQuery(event.target.value)}
                placeholder='搜索名称、前缀、ID 或备注，回车搜索'
                aria-label='搜索密钥'
                className='ps-9'
              />
            </div>
            <div className='flex min-w-0 flex-wrap items-center gap-2'>
              <Select
                value={paid}
                onValueChange={(value) =>
                  changeFilter(setPaid, value as PaidFilter)
                }
              >
                <SelectTrigger className='h-8 w-full sm:w-36' aria-label='付费筛选'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAID_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={planType}
                onValueChange={(value) =>
                  changeFilter(setPlanType, value as PlanFilter)
                }
              >
                <SelectTrigger className='h-8 w-full sm:w-36' aria-label='卡种筛选'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={enabled}
                onValueChange={(value) =>
                  changeFilter(setEnabled, value as EnabledFilter)
                }
              >
                <SelectTrigger className='h-8 w-full sm:w-36' aria-label='启停筛选'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENABLED_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={upstream}
                onValueChange={(value) =>
                  changeFilter(setUpstream, value as UpstreamFilter)
                }
              >
                <SelectTrigger
                  className='h-8 w-full sm:w-44'
                  aria-label='同步状态筛选'
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UPSTREAM_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type='submit' variant='outline' size='sm'>
                搜索
              </Button>
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={selectMatchingMutation.isPending}
                onClick={() => selectMatchingMutation.mutate()}
              >
                {selectMatchingMutation.isPending ? (
                  <Loader2 className='animate-spin' />
                ) : null}
                选中全部匹配
              </Button>
              <Button
                type='button'
                size='sm'
                disabled={syncMutation.isPending}
                onClick={() => syncMutation.mutate()}
              >
                {syncMutation.isPending ? (
                  <Loader2 className='animate-spin' />
                ) : (
                  <RefreshCw />
                )}
                同步密钥
              </Button>
            </div>
          </form>
        }
        footer={
          <ServerPagination
            page={page}
            pageSize={pageSize}
            total={ledger?.total ?? 0}
            disabled={loading}
            loading={keysQuery.isFetching}
            itemLabel='个密钥'
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size)
              setPage(1)
            }}
          />
        }
      >
        {error ? (
          <p className='px-1 py-3 text-sm text-destructive'>
            密钥读取失败：{error}
          </p>
        ) : loading ? (
          <LoadingState label='正在加载密钥' />
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            icon={KeyRound}
            title={hasFilters ? '没有匹配的密钥' : '还没有同步密钥'}
            description={
              hasFilters
                ? '试试调整付费、卡种或搜索条件。'
                : '点击同步密钥，从 grok2api 拉取 Client Key。本地付费标记会在后续同步中保留。'
            }
            className='border-0 bg-transparent'
          />
        ) : (
          <div className='overflow-x-auto'>
            <Table>
              <TableHeader>
                <TableRow className='hover:bg-transparent'>
                  <TableHead className='w-10'>
                    <Checkbox
                      checked={
                        allPageSelected
                          ? true
                          : selectedOnPage.length > 0
                            ? 'indeterminate'
                            : false
                      }
                      disabled={busy}
                      onCheckedChange={(value) => togglePage(value === true)}
                      aria-label='选择当前页密钥'
                    />
                  </TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>密钥</TableHead>
                  <TableHead>用户</TableHead>
                  <TableHead>卡种</TableHead>
                  <TableHead>累计充值</TableHead>
                  <TableHead>额度</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>截止日期</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>最近使用</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className={cn(
                      'hover:bg-transparent',
                      selected.has(row.id) && 'bg-primary/[0.035]'
                    )}
                  >
                    <TableCell>
                      <Checkbox
                        checked={selected.has(row.id)}
                        disabled={busy}
                        onCheckedChange={(value) =>
                          toggleKey(row, value === true)
                        }
                        aria-label={`选择 ${row.name || row.maskedKey}`}
                      />
                    </TableCell>
                    <TableCell className='max-w-[12rem]'>
                      <div className='truncate font-medium' title={row.name}>
                        {row.name || '未命名'}
                      </div>
                      {row.note ? (
                        <div
                          className='mt-0.5 truncate text-xs text-muted-foreground'
                          title={row.note}
                        >
                          {row.note}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className='font-mono text-xs'>
                      <CopyableText value={row.maskedKey} />
                    </TableCell>
                    <TableCell>
                      <PaidBadge paid={row.paid} />
                    </TableCell>
                    <TableCell>
                      <PlanBadge planType={row.planType} />
                    </TableCell>
                    <TableCell className='tabular-nums'>
                      {formatYuan(row.rechargeYuan)}
                    </TableCell>
                    <TableCell>
                      <QuotaCell row={row} />
                    </TableCell>
                    <TableCell>
                      <div className='flex flex-wrap gap-1'>
                        <Badge variant={row.enabled ? 'success' : 'secondary'}>
                          {row.enabled ? '启用' : '停用'}
                        </Badge>
                        {row.expired ? (
                          <Badge variant='warning'>已过期</Badge>
                        ) : null}
                        {row.upstreamMissing ? (
                          <Badge variant='destructive'>上游消失</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell
                      className={
                        row.expired
                          ? 'whitespace-nowrap text-amber-600 dark:text-amber-400'
                          : 'whitespace-nowrap text-muted-foreground'
                      }
                    >
                      {formatDate(row.expiresAt)}
                    </TableCell>
                    <TableCell className='whitespace-nowrap text-muted-foreground'>
                      {formatDate(row.upstreamCreatedAt ?? row.createdAt)}
                    </TableCell>
                    <TableCell className='whitespace-nowrap text-muted-foreground'>
                      {formatDate(row.lastUsedAt)}
                    </TableCell>
                    <TableCell className='text-right'>
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type='button'
                            size='icon'
                            variant='ghost'
                            className='size-7'
                            aria-label={`${row.name || row.maskedKey} 操作`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end'>
                          <DropdownMenuItem onClick={() => setEditor(toEditor(row))}>
                            <Pencil />
                            编辑密钥
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setEditor(toEditor(row))}>
                            <CreditCard />
                            标记付费
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              rememberNames([row])
                              openUsage([row.id])
                            }}
                          >
                            <BarChart3 />
                            用量
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={secretMutation.isPending}
                            onClick={() => secretMutation.mutate(row)}
                          >
                            <Eye />
                            查看密钥
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={row.upstreamMissing || busy}
                            onClick={() =>
                              batchEnabledMutation.mutate({
                                ids: [row.id],
                                enabled: !row.enabled,
                              })
                            }
                          >
                            {row.enabled ? <Ban /> : <Power />}
                            {row.enabled ? '停用' : '启用'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant='destructive'
                            onClick={() => setDeleting(row)}
                          >
                            <Trash2 />
                            删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </TablePanel>

      <ClientKeyEditorDialog
        editor={editor}
        pending={updateMutation.isPending}
        error={editorError}
        onOpenChange={(open) => {
          if (!open && !updateMutation.isPending) setEditor(null)
        }}
        onChange={setEditor}
        onSubmit={() => {
          if (!editor || editorError) return
          updateMutation.mutate(editor)
        }}
      />

      <ClientKeyUsageDialog
        open={usageOpen && usageIds.length > 0}
        onOpenChange={(open) => {
          setUsageOpen(open)
          if (!open) setUsageIds([])
        }}
        selectedIds={usageIds}
        names={{ ...selectedNames, ...pageNames }}
      />

      <Dialog
        open={secret != null}
        onOpenChange={(open) => {
          if (!open) setSecret(null)
        }}
      >
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>查看密钥</DialogTitle>
            <DialogDescription>
              明文只在这里展示一次，请尽快复制后关闭。
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-1.5'>
            <Label>{secret?.name || '密钥明文'}</Label>
            <div className='flex h-9 w-full min-w-0 overflow-hidden rounded-md border border-input bg-secondary/55'>
              <code className='flex min-w-0 flex-1 select-all items-center overflow-x-auto whitespace-nowrap px-3 font-mono text-xs text-muted-foreground'>
                {secret?.secret ?? ''}
              </code>
              <CopyButton
                value={secret?.secret ?? ''}
                className='h-full w-8 shrink-0 rounded-none border-l'
              />
            </div>
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => setSecret(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting != null}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleting(null)
        }}
        title={`删除密钥 ${deleting?.name || deleting?.maskedKey || ''}？`}
        desc='删除会同时从 grok2api 移除该密钥，本地付费标记也会一起消失。'
        cancelBtnText='取消'
        confirmText={deleteMutation.isPending ? '删除中…' : '确认删除'}
        destructive
        isLoading={deleteMutation.isPending}
        handleConfirm={() => {
          if (!deleting) return
          deleteMutation.mutate(deleting.id)
        }}
      />

      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={(open) => {
          if (!open && !batchDeleteMutation.isPending) setBatchDeleteOpen(false)
        }}
        title={`删除已选 ${selected.size} 个密钥？`}
        desc='删除会同时从 grok2api 移除这些密钥，本地付费标记也会一起消失。'
        cancelBtnText='取消'
        confirmText={
          batchDeleteMutation.isPending ? '删除中…' : `确认删除 ${selected.size} 个`
        }
        destructive
        isLoading={batchDeleteMutation.isPending}
        handleConfirm={() => batchDeleteMutation.mutate()}
      />
    </Page>
  )
}

function AutoTopupStatusCard({
  enabled,
  thresholdPercent,
  amountUsd,
  intervalSeconds,
  nextRunAt,
  lastExecution,
  loading,
  pending,
  onRun,
}: {
  enabled: boolean
  thresholdPercent: number
  amountUsd: number
  intervalSeconds: number
  nextRunAt: string | null
  lastExecution: ScheduleExecution | null
  loading: boolean
  pending: boolean
  onRun: () => void
}) {
  const lastDetail = lastExecution?.detail ?? {}
  const toppedUp =
    typeof lastDetail.toppedUp === 'number' ? lastDetail.toppedUp : null
  return (
    <TitledCard
      icon={<Wallet />}
      iconTone={enabled ? 'emerald' : 'rose'}
      title='付费密钥自动加额'
      description='仍在有效期内的付费有限额密钥，剩余额度低于阈值时会把 billingLimit 增加设定金额。'
      action={
        <Button
          type='button'
          size='sm'
          disabled={pending || loading}
          onClick={onRun}
        >
          {pending ? <Loader2 className='animate-spin' /> : <Play />}
          立即执行
        </Button>
      }
    >
      <div className='grid gap-2 sm:grid-cols-2 xl:grid-cols-5'>
        <Info
          label='任务'
          value={enabled ? '已启用' : '已关闭'}
        />
        <Info
          label='剩余低于'
          value={`${formatNumber(thresholdPercent, 0)}%`}
        />
        <Info label='每次增加' value={formatUsd(amountUsd)} />
        <Info
          label='检查间隔'
          value={`${formatNumber(intervalSeconds, 0)} 秒`}
        />
        <Info label='下次执行' value={formatDate(nextRunAt)} />
      </div>
      <p className='mt-3 text-xs text-muted-foreground'>
        {lastExecution
          ? `最近一次 ${formatDate(lastExecution.started_at)} · ${lastExecution.message || lastExecution.status}${
              toppedUp != null ? ` · 加额 ${formatNumber(toppedUp, 0)}` : ''
            }`
          : '还没有自动加额执行记录。可在计划页查看系统任务。'}
      </p>
    </TitledCard>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-lg bg-muted/40 px-3 py-2'>
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div className='mt-0.5 truncate text-sm font-semibold'>{value}</div>
    </div>
  )
}

function ClientKeyEditorDialog({
  editor,
  pending,
  error,
  onOpenChange,
  onChange,
  onSubmit,
}: {
  editor: EditorState | null
  pending: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onChange: (editor: EditorState) => void
  onSubmit: () => void
}) {
  const upstreamDisabled = Boolean(editor?.upstreamMissing)
  return (
    <Dialog open={editor != null} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg'>
        <DialogHeader className='shrink-0 px-5 py-4 pr-12'>
          <DialogTitle>编辑密钥</DialogTitle>
          <DialogDescription>
            {editor?.upstreamMissing
              ? `${editor.name || editor.maskedKey} 已从 grok2api 消失，只能改本地付费标记。`
              : '名称、启停、过期时间和额度会写回 grok2api；付费标记只保存在 GrokIQ。'}
          </DialogDescription>
        </DialogHeader>
        {editor ? (
          <div className='min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-2'>
            <div className='space-y-1.5'>
              <Label htmlFor='client-key-name'>名称</Label>
              <Input
                id='client-key-name'
                value={editor.name}
                maxLength={160}
                disabled={upstreamDisabled}
                onChange={(event) =>
                  onChange({ ...editor, name: event.target.value })
                }
              />
            </div>
            <div className='flex items-center justify-between rounded-lg border px-3 py-2'>
              <div>
                <Label htmlFor='client-key-enabled'>启用密钥</Label>
                <p className='text-xs text-muted-foreground'>
                  停用后 grok2api 会拒绝该密钥的请求
                </p>
              </div>
              <Switch
                id='client-key-enabled'
                checked={editor.enabled}
                disabled={upstreamDisabled}
                onCheckedChange={(enabled) => onChange({ ...editor, enabled })}
              />
            </div>
            <div className='space-y-1.5'>
              <div className='flex items-center justify-between gap-3'>
                <Label htmlFor='client-key-expires'>过期时间</Label>
                <div className='flex items-center gap-2'>
                  <span className='text-xs text-muted-foreground'>永不过期</span>
                  <Switch
                    checked={editor.expiresUnlimited}
                    disabled={upstreamDisabled}
                    onCheckedChange={(expiresUnlimited) =>
                      onChange({ ...editor, expiresUnlimited })
                    }
                  />
                </div>
              </div>
              <Input
                id='client-key-expires'
                type='datetime-local'
                value={editor.expiresAt}
                disabled={upstreamDisabled || editor.expiresUnlimited}
                onChange={(event) =>
                  onChange({ ...editor, expiresAt: event.target.value })
                }
              />
            </div>
            <div className='grid gap-3 sm:grid-cols-2'>
              <div className='space-y-1.5'>
                <div className='flex items-center justify-between gap-3'>
                  <Label htmlFor='client-key-rpm'>RPM</Label>
                  <div className='flex items-center gap-2'>
                    <span className='text-xs text-muted-foreground'>不限</span>
                    <Switch
                      checked={editor.rpmUnlimited}
                      disabled={upstreamDisabled}
                      onCheckedChange={(rpmUnlimited) =>
                        onChange({ ...editor, rpmUnlimited })
                      }
                    />
                  </div>
                </div>
                <NumericInput
                  id='client-key-rpm'
                  min={1}
                  max={100000}
                  value={editor.rpmLimit}
                  disabled={upstreamDisabled || editor.rpmUnlimited}
                  onChange={(rpmLimit) => onChange({ ...editor, rpmLimit })}
                />
              </div>
              <div className='space-y-1.5'>
                <div className='flex items-center justify-between gap-3'>
                  <Label htmlFor='client-key-concurrent'>并发</Label>
                  <div className='flex items-center gap-2'>
                    <span className='text-xs text-muted-foreground'>不限</span>
                    <Switch
                      checked={editor.concurrencyUnlimited}
                      disabled={upstreamDisabled}
                      onCheckedChange={(concurrencyUnlimited) =>
                        onChange({ ...editor, concurrencyUnlimited })
                      }
                    />
                  </div>
                </div>
                <NumericInput
                  id='client-key-concurrent'
                  min={1}
                  max={1024}
                  value={editor.maxConcurrent}
                  disabled={upstreamDisabled || editor.concurrencyUnlimited}
                  onChange={(maxConcurrent) =>
                    onChange({ ...editor, maxConcurrent })
                  }
                />
              </div>
            </div>
            <div className='space-y-1.5'>
              <div className='flex items-center justify-between gap-3'>
                <Label htmlFor='client-key-billing'>额度上限（USD）</Label>
                <div className='flex items-center gap-2'>
                  <span className='text-xs text-muted-foreground'>不限额</span>
                  <Switch
                    checked={editor.billingUnlimited}
                    disabled={upstreamDisabled}
                    onCheckedChange={(billingUnlimited) =>
                      onChange({ ...editor, billingUnlimited })
                    }
                  />
                </div>
              </div>
              <NumericInput
                id='client-key-billing'
                min={0.01}
                max={MAX_BILLING_LIMIT_USD}
                step={0.01}
                value={editor.billingLimitUsd}
                disabled={upstreamDisabled || editor.billingUnlimited}
                onChange={(billingLimitUsd) =>
                  onChange({ ...editor, billingLimitUsd })
                }
              />
            </div>
            <div className='h-px bg-border' />
            <div className='flex items-center justify-between rounded-lg border px-3 py-2'>
              <div>
                <Label htmlFor='client-key-paid'>付费用户</Label>
                <p className='text-xs text-muted-foreground'>
                  打开后需要选择天卡、周卡或月卡，只保存在 GrokIQ
                </p>
              </div>
              <Switch
                id='client-key-paid'
                checked={editor.paid}
                onCheckedChange={(paid) =>
                  onChange({
                    ...editor,
                    paid,
                    planType: paid
                      ? editor.planType === 'none'
                        ? 'month'
                        : editor.planType
                      : 'none',
                  })
                }
              />
            </div>
            <div className='space-y-1.5'>
              <Label>卡种</Label>
              <Select
                value={editor.planType}
                disabled={!editor.paid}
                onValueChange={(value) =>
                  onChange({
                    ...editor,
                    planType: value as ClientKeyPlanType,
                  })
                }
              >
                <SelectTrigger aria-label='选择卡种'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {editor.paid ? null : (
                    <SelectItem value='none'>未设卡种</SelectItem>
                  )}
                  <SelectItem value='day'>天卡</SelectItem>
                  <SelectItem value='week'>周卡</SelectItem>
                  <SelectItem value='month'>月卡</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='client-key-recharge'>累计充值（元）</Label>
              <NumericInput
                id='client-key-recharge'
                min={0}
                max={100000000}
                step={0.01}
                value={editor.rechargeYuan}
                onChange={(rechargeYuan) =>
                  onChange({ ...editor, rechargeYuan })
                }
              />
              <p className='text-xs text-muted-foreground'>
                按累计充值总额记录，取消付费标记时不会清零。
              </p>
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='client-key-note'>备注</Label>
              <Textarea
                id='client-key-note'
                value={editor.note}
                maxLength={500}
                onChange={(event) =>
                  onChange({ ...editor, note: event.target.value })
                }
                placeholder='可选，例如用户来源或续费说明'
              />
            </div>
            {error ? <p className='text-sm text-destructive'>{error}</p> : null}
          </div>
        ) : null}
        <DialogFooter className='shrink-0 px-5 py-3'>
          <Button
            type='button'
            variant='outline'
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type='button'
            disabled={pending || Boolean(error) || editor == null}
            onClick={onSubmit}
          >
            {pending ? <Loader2 className='animate-spin' /> : <Pencil />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function QuotaCell({ row }: { row: ManagedClientKey }) {
  if (row.unlimited || row.billingLimitUsd <= 0) {
    return <span className='text-muted-foreground'>不限额</span>
  }
  const percent = remainingPercent(row)
  const tone =
    percent <= 10 ? 'critical' : percent <= 30 ? 'warning' : 'healthy'
  return (
    <div className='min-w-[8.5rem] space-y-1.5'>
      <div className='flex items-baseline justify-between gap-2'>
        <span
          className={cn(
            'text-xs font-medium tabular-nums',
            tone === 'critical' && 'text-rose-600 dark:text-rose-400',
            tone === 'warning' && 'text-amber-600 dark:text-amber-400'
          )}
        >
          {formatUsd(row.remainingUsd)}
        </span>
        <span className='text-[10px] tabular-nums text-muted-foreground'>
          {formatUsd(row.billingLimitUsd)} · {formatNumber(percent, 0)}%
        </span>
      </div>
      <ProgressBar
        value={percent}
        indicatorClassName={
          tone === 'critical'
            ? 'bg-rose-500'
            : tone === 'warning'
              ? 'bg-amber-500'
              : undefined
        }
      />
    </div>
  )
}

function PaidBadge({ paid }: { paid: boolean }) {
  return (
    <Badge variant={paid ? 'success' : 'secondary'}>
      {paid ? '付费' : '未付费'}
    </Badge>
  )
}

function PlanBadge({ planType }: { planType: ClientKeyPlanType }) {
  if (planType === 'none') {
    return <span className='text-muted-foreground'>—</span>
  }
  return (
    <Badge variant={planType === 'month' ? 'info' : 'outline'}>
      {PLAN_LABELS[planType]}
    </Badge>
  )
}

function remainingPercent(row: ManagedClientKey) {
  if (Number.isFinite(row.remainingPercent)) {
    return Math.min(100, Math.max(0, row.remainingPercent))
  }
  if (row.unlimited || row.billingLimitUsd <= 0) return 0
  return Math.min(100, Math.max(0, (row.remainingUsd / row.billingLimitUsd) * 100))
}

function toEditor(row: ManagedClientKey): EditorState {
  return {
    id: row.id,
    name: row.name,
    maskedKey: row.maskedKey,
    enabled: row.enabled,
    expiresUnlimited: !row.expiresAt,
    expiresAt: toLocalInput(row.expiresAt),
    rpmUnlimited: row.rpmLimit === 0,
    rpmLimit: row.rpmLimit > 0 ? row.rpmLimit : 120,
    concurrencyUnlimited: row.maxConcurrent === 0,
    maxConcurrent: row.maxConcurrent > 0 ? row.maxConcurrent : 8,
    billingUnlimited: row.unlimited || row.billingLimitUsd <= 0,
    billingLimitUsd:
      row.billingLimitUsd > 0 ? row.billingLimitUsd : 10,
    upstreamMissing: row.upstreamMissing,
    paid: row.paid,
    planType: row.planType,
    rechargeYuan: row.rechargeYuan,
    note: row.note,
  }
}

function editorValidation(editor: EditorState) {
  if (editor.paid && editor.planType === 'none') {
    return '付费用户需要选择天卡、周卡或月卡'
  }
  if (editor.rechargeYuan < 0) return '累计充值不能为负数'
  if (editor.rechargeYuan > 100000000) return '累计充值不能超过 100000000 元'
  if (!editor.upstreamMissing) {
    if (!editor.name.trim()) return '密钥名称不能为空'
    if (editor.name.trim().length > 160) return '名称不能超过 160 个字符'
    if (!editor.expiresUnlimited && !toIso(editor.expiresAt)) {
      return '请填写有效的过期时间，或改为永不过期'
    }
    if (!editor.rpmUnlimited && (editor.rpmLimit < 1 || editor.rpmLimit > 100000)) {
      return 'RPM 需在 1–100000 之间，或设为不限'
    }
    if (
      !editor.concurrencyUnlimited &&
      (editor.maxConcurrent < 1 || editor.maxConcurrent > 1024)
    ) {
      return '并发需在 1–1024 之间，或设为不限'
    }
    if (
      !editor.billingUnlimited &&
      (editor.billingLimitUsd <= 0 || editor.billingLimitUsd > MAX_BILLING_LIMIT_USD)
    ) {
      return `额度上限需在 0.01–${MAX_BILLING_LIMIT_USD} 之间，或设为不限额`
    }
  }
  return ''
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function toLocalInput(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toIso(local: string) {
  if (!local.trim()) return ''
  const date = new Date(local)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}

function formatYuan(value: number) {
  return `¥${formatNumber(value, 2)}`
}

function formatUsd(value: number) {
  return `$${formatNumber(value, 2)}`
}
