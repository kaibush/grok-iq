import {
  type ReactNode,
  type ComponentType,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import {
  Activity,
  ArrowUp,
  Ban,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Clock3,
  CircleAlert,
  CircleCheck,
  CircleX,
  Eye,
  Filter,
  Gauge,
  History,
  Images,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ServerCog,
  SlidersHorizontal,
  Square,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatAccountSecondaryLabel } from '@/lib/account-label'
import {
  api,
  type ExecutionMode,
  type ProbeProfile,
  type ProbeRun,
  type ProbeSample,
  type RunSelectionAction,
  type RunSelectionItem,
  type UpstreamAccount,
} from '@/lib/api'
import { extractHtmlPreviews } from '@/lib/formatted-content'
import { StatusBadge } from '@/lib/status'
import { cn, formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { formatDualTps, tpsOverridden } from '@/lib/tps'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { usePaintDeferredValue } from '@/hooks/use-paint-deferred-value'
import { usePersistedViewState } from '@/hooks/use-persisted-view-state'
import { useServerTableLoading } from '@/hooks/use-server-table-loading'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { EnabledBadge } from '@/components/enabled-badge'
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
import { Input } from '@/components/ui/input'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ActionToolbar, ToolbarAction } from '@/components/action-toolbar'
import { ExportMenu } from '@/components/export-menu'
import { CopyButton, CopyableText } from '@/components/copy-button'
import {
  FormattedContentPreviewButton,
  HtmlPreviewButton,
  MarkdownView,
  SourceCodeView,
} from '@/components/formatted-content'
import { ProgressBar } from '@/components/ui/progress'
import { Page, PageHeader, LoadingState, EmptyState } from '@/components/page'
import { TablePanel } from '@/components/table-panel'
import { PersistedViewNotice } from '@/components/persisted-view-notice'
import { SelectionToolbar } from '@/components/selection-toolbar'
import {
  ServerPagination,
  ServerTableLoadingOverlay,
} from '@/components/server-pagination'
import {
  AccountRestoreIndicator,
  EgressBindingIndicator,
} from '@/features/monitor/components/account-state-indicators'
import {
  buildEgressNodeNameMap,
  formatEgressNodeText,
  getEgressNodeName,
  type EgressNodeNameMap,
} from '@/features/monitor/components/egress-node-names'
import {
  ModelBindWindowError,
  ModelBindWindowHint,
  isModelBindWindowIssue,
} from '@/features/monitor/components/model-bind-window-hint'
import { EgressNodeReference } from '@/features/monitor/components/egress-node-reference'
import { FilterChip } from '@/features/monitor/components/filter-chip'
import { ReasoningPanel } from '@/features/monitor/components/reasoning-panel'
import { DualTpsValue, SampleTpsDetail } from '@/features/monitor/components/tps-display'
import { AccountProbeDetailDialog } from '@/features/monitor/components/account-probe-detail-dialog'
import {
  previewItemsFromRuns,
  ResultPreviewGallery,
} from '@/features/monitor/components/result-preview-gallery'
import { ProbeDialog } from '@/features/monitor/components/probe-dialog'
import {
  isRunsPath,
  pinnedAccountIdFromRunsSearch,
  readRunsSearch,
  type RunsSearch,
} from '@/features/monitor/pages/runs-search'

const terminal = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
])

const activeRunStatuses = new Set([
  'queued',
  'running',
  'cancel_requested',
  'recovering',
])

const cancellableRunStatuses = new Set(['queued', 'running', 'recovering'])

const runStatusMeta: Record<
  string,
  { label: string; icon: ComponentType<{ className?: string }>; tone: string }
> = {
  queued: {
    label: '任务排队中',
    icon: Clock3,
    tone: 'text-muted-foreground',
  },
  running: { label: '任务执行中', icon: RefreshCw, tone: 'text-sky-600' },
  cancel_requested: {
    label: '任务取消中',
    icon: Square,
    tone: 'text-amber-600',
  },
  recovering: { label: '任务恢复中', icon: Undo2, tone: 'text-amber-600' },
  completed: {
    label: '任务已完成',
    icon: CircleCheck,
    tone: 'text-emerald-600',
  },
  completed_with_errors: {
    label: '任务部分异常',
    icon: CircleAlert,
    tone: 'text-amber-600',
  },
  failed: { label: '任务失败', icon: CircleX, tone: 'text-destructive' },
  cancelled: { label: '任务已取消', icon: Ban, tone: 'text-muted-foreground' },
}

const degradationClassifications = new Set([
  'elevated',
  'buffered_soft',
  'buffered_hard',
  'fast_risk',
  'marker_miss',
  'reasoning_zero',
  'reasoning_zero_observe',
])
const warningClassifications = new Set(['insufficient'])

const RUNS_VIEW_STORAGE_KEY = 'grokiq.monitor.runs-view.v1'
const defaultRunsView = {
  status: 'all',
  search: '',
  createdFrom: '',
  createdTo: '',
  page: 1,
  pageSize: 50,
}

function PinnedAccountBar({
  accountId,
  detail,
  onClear,
  onOpenDetail,
}: {
  accountId: number
  detail?: UpstreamAccount
  onClear: () => void
  onOpenDetail: () => void
}) {
  const name = detail?.name || `账号 ${accountId}`
  const secondary = formatAccountSecondaryLabel({
    id: accountId,
    email: detail?.email,
    createdAt: detail?.createdAt,
    accountLabel: name,
  })
  return (
    <div className='flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between'>
      <div className='min-w-0'>
        <div className='text-[11px] font-medium tracking-wide text-muted-foreground uppercase'>
          已筛选账号
        </div>
        <button
          type='button'
          onClick={onOpenDetail}
          className='mt-0.5 block max-w-full truncate text-left text-sm font-semibold hover:text-primary hover:underline'
        >
          {name}
        </button>
        <p className='truncate text-xs text-muted-foreground' title={secondary}>
          {secondary}
        </p>
        <p className='mt-1 text-[11px] text-muted-foreground'>
          已按该账号过滤任务中心
        </p>
      </div>
      <Button type='button' variant='ghost' className='h-8' onClick={onClear}>
        清除筛选
      </Button>
    </div>
  )
}

export function RunsPage() {
  const client = useQueryClient()
  const navigate = useNavigate()
  const pathname = useLocation({ select: (location) => location.pathname })
  const rawSearch = useSearch({ strict: false })
  const isActive = isRunsPath(pathname)
  const parsedSearch = isActive ? readRunsSearch(rawSearch) : null
  const [cachedSearch, setCachedSearch] = useState<RunsSearch>({})
  if (
    parsedSearch &&
    (parsedSearch.account !== cachedSearch.account ||
      parsedSearch.run !== cachedSearch.run)
  ) {
    setCachedSearch(parsedSearch)
  }
  const runsSearch = parsedSearch ?? cachedSearch
  const pinnedAccountId = pinnedAccountIdFromRunsSearch(runsSearch)
  const runsView = usePersistedViewState(RUNS_VIEW_STORAGE_KEY, defaultRunsView)
  const { status, search, createdFrom, createdTo, page, pageSize } =
    runsView.value
  const setRunsViewValue = runsView.setValue
  const updateRunsView = (patch: Partial<typeof defaultRunsView>) =>
    setRunsViewValue((current) => ({ ...current, ...patch }))
  const [deferredSearch] = useDebouncedValue(search.trim())
  const createdFromIso = toIsoDateTime(createdFrom)
  const createdToIso = toIsoDateTime(createdTo)
  const committedQuery = useMemo(
    () => ({
      status,
      search: deferredSearch,
      createdFrom: createdFromIso,
      createdTo: createdToIso,
      page,
      pageSize,
    }),
    [createdFromIso, createdToIso, deferredSearch, page, pageSize, status]
  )
  // Apply filter/page query after the overlay and select close have painted.
  const tableQuery = usePaintDeferredValue(committedQuery)
  const [selection, setSelection] = useState<Map<string, RunSelectionItem>>(
    () => new Map()
  )
  const [allFilteredSelected, setAllFilteredSelected] = useState(false)
  const [probeSelection, setProbeSelection] = useState<{
    accountIds: number[]
    taskCount: number
  } | null>(null)
  const [egressBindingOpen, setEgressBindingOpen] = useState(false)
  const [egressBindingTarget, setEgressBindingTarget] = useState<string>()
  const [bulkCancelOpen, setBulkCancelOpen] = useState(false)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [bulkRestoreOpen, setBulkRestoreOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [accountDetailId, setAccountDetailId] = useState<number | null>(null)
  const [resultPreview, setResultPreview] = useState<{
    page: number
    index: number
    land?: 'start' | 'end'
    sampleId?: string
  } | null>(null)
  const detailScrollRef = useRef<HTMLDivElement | null>(null)
  const detailScrollTopRef = useRef(0)
  const openDetail = useCallback((id: string) => {
    detailScrollTopRef.current = 0
    setDetailId(id)
  }, [])
  const closeDetail = useCallback(() => {
    detailScrollTopRef.current = 0
    setDetailId(null)
    if (!isActive || !runsSearch.run) return
    void navigate({
      to: '/runs',
      search: runsSearch.account ? { account: runsSearch.account } : {},
    } as never)
  }, [isActive, navigate, runsSearch.account, runsSearch.run])
  const clearPinnedAccount = useCallback(() => {
    void navigate({ to: '/runs', search: {} } as never)
  }, [navigate])
  const runId = isActive ? runsSearch.run?.trim() || '' : ''
  if (runId && detailId !== runId) {
    setDetailId(runId)
  }
  useEffect(() => {
    if (pinnedAccountId == null) return
    setRunsViewValue((current) =>
      current.page === 1 ? current : { ...current, page: 1 }
    )
  }, [pinnedAccountId, setRunsViewValue])
  const invalidTimeRange = Boolean(
    createdFromIso && createdToIso && createdFromIso > createdToIso
  )
  const tableQueryPending =
    tableQuery.status !== committedQuery.status ||
    tableQuery.search !== committedQuery.search ||
    tableQuery.createdFrom !== committedQuery.createdFrom ||
    tableQuery.createdTo !== committedQuery.createdTo ||
    tableQuery.page !== committedQuery.page ||
    tableQuery.pageSize !== committedQuery.pageSize
  const query = useQuery({
    queryKey: [
      'runs',
      tableQuery.status,
      tableQuery.search,
      tableQuery.createdFrom,
      tableQuery.createdTo,
      tableQuery.page,
      tableQuery.pageSize,
      pinnedAccountId,
    ],
    queryFn: ({ signal }) =>
      api.runs(
        {
          page: tableQuery.page,
          pageSize: tableQuery.pageSize,
          status: tableQuery.status === 'all' ? '' : tableQuery.status,
          search: pinnedAccountId != null ? '' : tableQuery.search,
          accountId: pinnedAccountId ?? undefined,
          createdFrom: tableQuery.createdFrom,
          createdTo: tableQuery.createdTo,
        },
        signal
      ),
    enabled: !invalidTimeRange,
    placeholderData: (previous) => previous,
    refetchInterval: (value) => {
      const activeCount = value.state.data?.activeCount
      if (typeof activeCount === 'number') {
        return activeCount > 0 ? 2_000 : false
      }
      return (value.state.data?.items ?? []).some((run) =>
        activeRunStatuses.has(run.status)
      )
        ? 2_000
        : false
    },
    refetchIntervalInBackground: false,
  })
  const egress = useQuery({
    queryKey: ['egress'],
    queryFn: () => api.egress({ pageSize: 500 }),
    staleTime: 60_000,
  })
  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: api.profiles,
    staleTime: 60_000,
  })
  const pinnedAccountQuery = useQuery({
    queryKey: ['account', pinnedAccountId],
    queryFn: () => api.account(pinnedAccountId!, 1),
    enabled: pinnedAccountId != null,
    staleTime: 30_000,
  })
  const egressNodeNames = useMemo(
    () => buildEgressNodeNameMap(egress.data?.items),
    [egress.data?.items]
  )
  const detail = useQuery({
    queryKey: ['run', detailId],
    queryFn: () => api.run(detailId!),
    enabled: detailId != null,
    refetchInterval: (value) =>
      value.state.data && terminal.has(value.state.data.run.status)
        ? false
        : 1_500,
  })
  const { beginTableInteraction, tableLoading: showTableLoading } =
    useServerTableLoading({
      isFetching: query.isFetching,
      inputPending: tableQueryPending,
    })
  const tableFilterKey = [
    tableQuery.status,
    tableQuery.search,
    tableQuery.createdFrom,
    tableQuery.createdTo,
    pinnedAccountId ?? '',
  ].join('|')
  const appliedFilterKeyRef = useRef(tableFilterKey)
  useEffect(() => {
    if (tableQueryPending) {
      beginTableInteraction()
      return
    }
    if (appliedFilterKeyRef.current === tableFilterKey) return
    appliedFilterKeyRef.current = tableFilterKey
    // Wait until the overlay has painted before dropping checkboxes, so the
    // first filter frame only updates the controls and loading state.
    setSelection((current) => (current.size === 0 ? current : new Map()))
    setAllFilteredSelected(false)
  }, [beginTableInteraction, tableFilterKey, tableQueryPending])
  const currentPageRuns = useMemo(
    () => query.data?.items ?? [],
    [query.data?.items]
  )
  const profileNameById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const profile of profiles.data ?? []) {
      map[profile.id] = profile.name
    }
    return map
  }, [profiles.data])
  const previewPage = resultPreview?.page ?? tableQuery.page
  const previewRunsQuery = useQuery({
    queryKey: [
      'runs',
      'preview',
      tableQuery.status,
      tableQuery.search,
      tableQuery.createdFrom,
      tableQuery.createdTo,
      previewPage,
      tableQuery.pageSize,
      pinnedAccountId,
    ],
    queryFn: ({ signal }) =>
      api.runs(
        {
          page: previewPage,
          pageSize: tableQuery.pageSize,
          status: tableQuery.status === 'all' ? '' : tableQuery.status,
          search: pinnedAccountId != null ? '' : tableQuery.search,
          accountId: pinnedAccountId ?? undefined,
          createdFrom: tableQuery.createdFrom,
          createdTo: tableQuery.createdTo,
        },
        signal
      ),
    enabled: resultPreview != null && !invalidTimeRange,
  })
  const previewSource =
    resultPreview &&
    resultPreview.page === tableQuery.page &&
    query.data
      ? query.data
      : previewRunsQuery.data?.page === previewPage
        ? previewRunsQuery.data
        : undefined
  const previewSampleId = resultPreview?.sampleId
  const previewSampleIndex = resultPreview?.index
  const previewItems = useMemo(() => {
    const items = previewItemsFromRuns(
      previewSource?.items ?? [],
      profileNameById
    )
    if (!previewSampleId) return items
    return items.map((item, itemIndex) =>
      itemIndex === previewSampleIndex
        ? { ...item, sampleId: previewSampleId }
        : item
    )
  }, [previewSource?.items, profileNameById, previewSampleId, previewSampleIndex])
  const previewTotal = previewSource?.total ?? query.data?.total ?? 0
  const previewPageCount = Math.max(
    1,
    Math.ceil(previewTotal / Math.max(tableQuery.pageSize, 1))
  )
  const previewPageLoading =
    resultPreview != null &&
    previewSource?.page !== resultPreview.page &&
    previewRunsQuery.isFetching
  if (
    resultPreview?.land &&
    previewItems.length > 0 &&
    previewSource?.page === resultPreview.page
  ) {
    const nextIndex = resultPreview.land === 'end' ? previewItems.length - 1 : 0
    setResultPreview((current) => {
      if (!current?.land || current.page !== resultPreview.page) return current
      return { ...current, index: nextIndex, land: undefined }
    })
  }
  const openRunPreview = useCallback(
    (runId: string, sampleId?: string) => {
      const items = previewItemsFromRuns(currentPageRuns, profileNameById)
      if (!items.length && !(query.data?.total ?? 0)) {
        toast.error('当前筛选没有可预览的任务样本')
        return
      }
      const index = Math.max(
        0,
        items.findIndex((item) => item.runId === runId)
      )
      setResultPreview({
        page,
        index,
        sampleId,
      })
    },
    [currentPageRuns, page, profileNameById, query.data?.total]
  )
  const currentPageRunMap = useMemo(
    () => new Map(currentPageRuns.map((run) => [run.id, run])),
    [currentPageRuns]
  )
  const currentPageActionable = useMemo(
    () =>
      currentPageRuns
        .map((run) => runSelectionItem(run))
        .filter((item): item is RunSelectionItem => item != null),
    [currentPageRuns]
  )
  const selectedItems = useMemo(
    () => Array.from(selection.values()),
    [selection]
  )
  const selectedRunIds = useMemo(
    () => selectedItems.map((item) => item.id),
    [selectedItems]
  )
  const selectedAccountIds = useMemo(
    () =>
      Array.from(
        new Set(
          selectedItems
            .map((item) => item.accountId)
            .filter((accountId) => accountId > 0)
        )
      ),
    [selectedItems]
  )
  const selectedCancellableRuns = useMemo(
    () => selectedItems.filter((item) => item.action === 'cancel'),
    [selectedItems]
  )
  const selectedDeletableRuns = useMemo(
    () => selectedItems.filter((item) => item.action === 'delete'),
    [selectedItems]
  )
  const selectedRestorableRuns = useMemo(
    () => selectedItems.filter((item) => item.action === 'restore'),
    [selectedItems]
  )
  const selectedCurrentPageCount = useMemo(
    () => currentPageActionable.filter((item) => selection.has(item.id)).length,
    [currentPageActionable, selection]
  )
  const allCurrentPageSelected =
    currentPageActionable.length > 0 &&
    selectedCurrentPageCount === currentPageActionable.length
  const selectAllChecked = allCurrentPageSelected
    ? true
    : selectedCurrentPageCount > 0
      ? 'indeterminate'
      : false
  useEffect(() => {
    // Refresh cached metadata for selected runs visible on the current page,
    // and drop any that are no longer actionable. Off-page selections (from a
    // filter-wide "select all") are preserved with their fetched metadata.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelection((current) => {
      let changed = false
      const next = new Map(current)
      for (const [id, item] of current) {
        const run = currentPageRunMap.get(id)
        if (!run) continue
        const fresh = runSelectionItem(run)
        if (!fresh) {
          next.delete(id)
          changed = true
          continue
        }
        if (
          fresh.action !== item.action ||
          fresh.accountId !== item.accountId
        ) {
          next.set(id, fresh)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [currentPageRunMap])
  useLayoutEffect(() => {
    const element = detailScrollRef.current
    if (!element || detailId == null) return
    element.scrollTop = Math.min(
      detailScrollTopRef.current,
      Math.max(0, element.scrollHeight - element.clientHeight)
    )
  }, [detail.data, detailId])
  const mutate = useMutation({
    mutationFn: async ({
      action,
      id,
    }: {
      action: 'cancel' | 'retry' | 'delete' | 'restore'
      id: string
    }) => {
      if (action === 'cancel') await api.cancelRun(id)
      else if (action === 'retry') await api.retryRun(id)
      else if (action === 'restore') await api.restoreRunAccountSettings(id)
      else await api.deleteRun(id)
    },
    onSuccess: (_, variables) => {
      toast.success(
        variables.action === 'delete'
          ? '任务已删除'
          : variables.action === 'restore'
            ? '已按任务记录同步账号原设置'
            : variables.action === 'retry'
              ? '已重新加入队列'
              : '已请求取消'
      )
      if (variables.action === 'delete') {
        closeDetail()
        setSelection((current) => {
          if (!current.has(variables.id)) return current
          const next = new Map(current)
          next.delete(variables.id)
          return next
        })
      }
      void client.invalidateQueries({ queryKey: ['runs'] })
      void client.invalidateQueries({ queryKey: ['run'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const bulkDelete = useMutation({
    mutationFn: api.deleteRuns,
    onSuccess: (result, requestedIds) => {
      const skipped = new Set(result.skippedRunIds)
      toast.success(
        result.skippedRunIds.length
          ? `已删除 ${result.deleted} 个任务及其历史样本，${result.skippedRunIds.length} 个任务不可删除`
          : `已删除 ${result.deleted} 个任务及其历史样本`
      )
      setSelection((current) => {
        const next = new Map(current)
        for (const id of requestedIds) {
          if (!skipped.has(id)) next.delete(id)
        }
        return next
      })
      setAllFilteredSelected(false)
      setBulkDeleteOpen(false)
      if (
        detailId &&
        requestedIds.includes(detailId) &&
        !skipped.has(detailId)
      ) {
        closeDetail()
      }
      void client.invalidateQueries({ queryKey: ['runs'] })
      void client.invalidateQueries({ queryKey: ['run'] })
      void client.invalidateQueries({ queryKey: ['accounts'] })
      void client.invalidateQueries({ queryKey: ['account'] })
      void client.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const bulkCancel = useMutation({
    mutationFn: api.cancelRuns,
    onSuccess: (result, requestedIds) => {
      const messages = []
      if (result.cancelled)
        messages.push(`${result.cancelled} 个排队任务已取消`)
      if (result.cancelRequested) {
        messages.push(`${result.cancelRequested} 个执行任务正在停止`)
      }
      if (result.alreadyStopping) {
        messages.push(`${result.alreadyStopping} 个任务已在停止中`)
      }
      if (result.skipped) messages.push(`${result.skipped} 个终态任务已跳过`)
      if (result.alreadyStopping || result.skipped) {
        toast.warning(messages.join('，') || '所选任务状态未发生变化')
      } else {
        toast.success(messages.join('，') || '所选任务已进入停止流程')
      }
      setSelection((current) => {
        const next = new Map(current)
        for (const id of requestedIds) next.delete(id)
        return next
      })
      setAllFilteredSelected(false)
      setBulkCancelOpen(false)
      void client.invalidateQueries({ queryKey: ['runs'] })
      void client.invalidateQueries({ queryKey: ['run'] })
      void client.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const bulkRestore = useMutation({
    mutationFn: api.restoreRunsAccountSettings,
    onSuccess: (result, requestedIds) => {
      const failed = new Set(result.failedRunIds)
      if (result.failed) {
        toast.warning(
          `${result.restored} 个任务已按记录同步账号原设置，${result.failed} 个任务同步失败`
        )
      } else {
        toast.success(`已按记录同步 ${result.restored} 个任务的账号原设置`)
      }
      setSelection((current) => {
        const next = new Map(current)
        for (const id of requestedIds) {
          if (!failed.has(id)) next.delete(id)
        }
        return next
      })
      setAllFilteredSelected(false)
      setBulkRestoreOpen(false)
      void client.invalidateQueries({ queryKey: ['runs'] })
      void client.invalidateQueries({ queryKey: ['run'] })
      void client.invalidateQueries({ queryKey: ['accounts'] })
      void client.invalidateQueries({ queryKey: ['account'] })
      void client.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const selectionMutation = useMutation({
    mutationFn: () =>
      api.runSelection({
        status: tableQuery.status === 'all' ? '' : tableQuery.status,
        search: pinnedAccountId != null ? '' : tableQuery.search,
        accountId: pinnedAccountId ?? undefined,
        createdFrom: tableQuery.createdFrom,
        createdTo: tableQuery.createdTo,
      }),
    onSuccess: (result) => {
      setSelection(new Map(result.items.map((item) => [item.id, item])))
      setAllFilteredSelected(result.selectable > 0)
      if (!result.selectable) {
        toast.warning('当前筛选下没有可操作的任务')
        return
      }
      toast.success(
        result.excluded
          ? `已选择全部 ${result.selectable} 个可操作任务，跳过 ${result.excluded} 个执行中的任务`
          : `已选择全部 ${result.selectable} 个可操作任务`
      )
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const egressBindingMutation = useMutation({
    mutationFn: ({
      accountIds,
      egressNodeId,
    }: {
      accountIds: number[]
      egressNodeId: number | null
    }) => api.updateAccountsEgress(accountIds, egressNodeId),
    onSuccess: (result, variables) => {
      const skippedAccountIds = result.skippedAccountIds ?? []
      const failedAccountIds = result.failedAccountIds ?? []
      const unavailableAccountIdSet = new Set([
        ...skippedAccountIds,
        ...failedAccountIds,
      ])
      const updatedAccountIds = variables.accountIds.filter(
        (accountId) => !unavailableAccountIdSet.has(accountId)
      )
      setEgressBindingOpen(false)
      setEgressBindingTarget(undefined)
      const actionLabel = variables.egressNodeId == null ? '解绑' : '绑定'
      if (failedAccountIds.length || skippedAccountIds.length) {
        const details = [`已${actionLabel} ${result.updated} 个账号出口`]
        if (failedAccountIds.length) {
          details.push(`${failedAccountIds.length} 个操作失败并保留选择`)
        }
        if (skippedAccountIds.length) {
          details.push(`${skippedAccountIds.length} 个设置受任务保护并保留选择`)
        }
        toast.warning(details.join('；'))
      } else {
        toast.success(
          `已${actionLabel} ${result.updated} 个账号出口，可直接建立任务`
        )
      }
      if (result.updated > 0 && updatedAccountIds.length > 0) {
        setProbeSelection({
          accountIds: updatedAccountIds,
          taskCount: selectedRunIds.length,
        })
        void egress.refetch()
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['accounts'] })
      void client.invalidateQueries({ queryKey: ['account'] })
      void client.invalidateQueries({ queryKey: ['egress'] })
    },
  })

  const clearSelection = () => {
    setSelection((current) => (current.size === 0 ? current : new Map()))
    setAllFilteredSelected(false)
  }

  const clearRunsView = () => {
    beginTableInteraction()
    runsView.clear()
  }

  const todayRange = localDayRange(new Date())
  const todayActive =
    createdFrom === todayRange.from && createdTo === todayRange.to
  const timeFilterActive = Boolean(createdFrom || createdTo)
  const activeFilterCount = [status !== 'all', timeFilterActive].filter(
    Boolean
  ).length
  const timeFilterLabel = todayActive
    ? '今天'
    : createdFrom || createdTo
      ? `${createdFrom ? formatDateTimeInput(createdFrom) : '不限'} 至 ${createdTo ? formatDateTimeInput(createdTo) : '不限'}`
      : ''
  const applyTimeRange = (from: string, to: string) => {
    beginTableInteraction()
    updateRunsView({ createdFrom: from, createdTo: to, page: 1 })
  }
  const runsViewSummary = [
    search.trim() ? `搜索“${search.trim()}”` : '',
    status !== 'all'
      ? (runStatusMeta[status]?.label ?? `状态 ${status}`)
      : '全部状态',
    createdFrom || createdTo
      ? `${createdFrom ? formatDateTimeInput(createdFrom) : '不限'} 至 ${createdTo ? formatDateTimeInput(createdTo) : '不限'}`
      : '',
    `第 ${page} 页 · 每页 ${pageSize} 条`,
  ]
    .filter(Boolean)
    .join(' · ')

  const toggleRunSelection = useCallback((run: ProbeRun, checked: boolean) => {
    setAllFilteredSelected(false)
    setSelection((current) => {
      const next = new Map(current)
      if (checked) {
        const item = runSelectionItem(run)
        if (item) next.set(run.id, item)
      } else {
        next.delete(run.id)
      }
      return next
    })
  }, [])

  const toggleCurrentPageSelection = useCallback(
    (checked: boolean) => {
      setAllFilteredSelected(false)
      setSelection((current) => {
        const next = new Map(current)
        if (checked) {
          for (const item of currentPageActionable) next.set(item.id, item)
        } else {
          for (const run of currentPageRuns) next.delete(run.id)
        }
        return next
      })
    },
    [currentPageActionable, currentPageRuns]
  )

  const mutateRun = mutate.mutate
  const handleRunAction = useCallback(
    (action: 'cancel' | 'retry' | 'delete' | 'restore', id: string) => {
      mutateRun({ action, id })
    },
    [mutateRun]
  )

  const bulkPending =
    bulkCancel.isPending || bulkDelete.isPending || bulkRestore.isPending
  const selectionActionPending =
    bulkPending ||
    selectionMutation.isPending ||
    egressBindingMutation.isPending
  const bindableEgress = (egress.data?.items ?? []).filter(
    (node) => node.enabled && node.proxyConfigured
  )
  const pinnedAccountDetail = pinnedAccountQuery.data?.account
  const pinnedAccountLabel =
    pinnedAccountDetail?.name ||
    pinnedAccountDetail?.email ||
    (pinnedAccountId != null ? `账号 ${pinnedAccountId}` : '')

  return (
    <Page>
      <PageHeader
        title='任务中心'
        description='Cron、注册联动和手动探针共用持久队列；支持进度查看、批量重测、取消、重试与删除。'
        descriptionAsHint
        actions={
            <ActionToolbar label='任务列表操作'>
              <ToolbarAction
                label='刷新任务列表'
                pending={query.isFetching}
                onClick={() => void query.refetch()}
              >
                <RefreshCw />
              </ToolbarAction>
              <ToolbarAction
                label={
                  allFilteredSelected
                    ? '清除当前筛选的全选'
                    : '全选当前筛选下的所有可操作任务'
                }
                active={allFilteredSelected}
                pending={selectionMutation.isPending}
                disabled={
                  showTableLoading ||
                  bulkPending ||
                  invalidTimeRange ||
                  (query.data?.total ?? 0) === 0
                }
                onClick={() => {
                  if (allFilteredSelected) {
                    clearSelection()
                    toast.success('已清除当前筛选的全选')
                    return
                  }
                  selectionMutation.mutate()
                }}
              >
                <ListChecks />
              </ToolbarAction>
            <ExportMenu
              label='导出样本'
              onExport={(format) =>
                api.exportProbeSamples({
                  format,
                  accountId: pinnedAccountId ?? undefined,
                })
              }
            />
            <SelectionToolbar
              wrap={false}
              selectedCount={selectedRunIds.length}
              entityLabel='任务'
              disabled={selectionActionPending}
              onClear={clearSelection}
            >
              <ToolbarAction
                label={
                  selectedAccountIds.length
                    ? `测试已选任务中的 ${selectedAccountIds.length} 个账号`
                    : '所选任务中没有可测试账号'
                }
                disabled={
                  selectedAccountIds.length === 0 || selectionActionPending
                }
                onClick={() => {
                  setProbeSelection({
                    accountIds: selectedAccountIds,
                    taskCount: selectedRunIds.length,
                  })
                  void egress.refetch()
                }}
              >
                <Play />
              </ToolbarAction>
              <ToolbarAction
                label={
                  selectedAccountIds.length
                    ? `设置 ${selectedAccountIds.length} 个账号的出口`
                    : '所选任务中没有可设置出口的账号'
                }
                pending={egressBindingMutation.isPending}
                disabled={
                  selectedAccountIds.length === 0 || selectionActionPending
                }
                onClick={() => {
                  setEgressBindingTarget(undefined)
                  setEgressBindingOpen(true)
                  void egress.refetch()
                }}
              >
                <ServerCog />
              </ToolbarAction>
              <ToolbarAction
                label={
                  selectedCancellableRuns.length
                    ? `停止 ${selectedCancellableRuns.length} 个可取消任务`
                    : '所选任务中没有可停止任务'
                }
                disabled={
                  selectedCancellableRuns.length === 0 || selectionActionPending
                }
                pending={bulkCancel.isPending}
                onClick={() => setBulkCancelOpen(true)}
              >
                <Square />
              </ToolbarAction>
              <ToolbarAction
                label={
                  selectedRestorableRuns.length
                    ? `同步 ${selectedRestorableRuns.length} 个任务的账号原设置`
                    : '所选任务无需同步账号原设置'
                }
                disabled={
                  selectedRestorableRuns.length === 0 || selectionActionPending
                }
                pending={bulkRestore.isPending}
                onClick={() => setBulkRestoreOpen(true)}
              >
                <Undo2 />
              </ToolbarAction>
              <ToolbarAction
                label={
                  selectedDeletableRuns.length
                    ? `删除 ${selectedDeletableRuns.length} 个可删除任务`
                    : '所选任务尚未结束或账号设置待恢复'
                }
                destructive
                disabled={
                  selectedDeletableRuns.length === 0 || selectionActionPending
                }
                pending={bulkDelete.isPending}
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 />
              </ToolbarAction>
            </SelectionToolbar>
          </ActionToolbar>
        }
      />
      {pinnedAccountId != null ? (
        <PinnedAccountBar
          accountId={pinnedAccountId}
          detail={pinnedAccountDetail}
          onClear={clearPinnedAccount}
          onOpenDetail={() => setAccountDetailId(pinnedAccountId)}
        />
      ) : null}
      <TablePanel
        toolbar={
          <div className='space-y-2' aria-busy={showTableLoading}>
            <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
              <Tabs
                value={resultPreview ? 'preview' : 'list'}
                className='shrink-0 gap-0'
                onValueChange={(value) => {
                  if (value === 'list') {
                    setResultPreview(null)
                    return
                  }
                  openRunPreview(detailId || currentPageRuns[0]?.id || '')
                }}
              >
                <TabsList className='h-8'>
                  <TabsTrigger value='list'>列表</TabsTrigger>
                  <TabsTrigger value='preview'>
                    <Images className='size-3.5' />
                    预览
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <div className='relative min-w-0 flex-1'>
                <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                <Input
                  value={pinnedAccountId != null ? '' : search}
                  onChange={(event) => {
                    updateRunsView({ search: event.target.value, page: 1 })
                  }}
                  disabled={pinnedAccountId != null}
                  placeholder={
                    pinnedAccountId != null
                      ? '已按该账号过滤任务中心'
                      : '搜索账号名称、邮箱或账号 ID'
                  }
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
                        <div className='text-sm font-semibold'>任务筛选</div>
                        <div className='mt-0.5 text-xs text-muted-foreground'>
                          按状态和创建时间缩小任务范围
                        </div>
                      </div>
                      {activeFilterCount > 0 && (
                        <Button
                          variant='ghost'
                          size='sm'
                          className='h-8'
                          onClick={() => {
                            beginTableInteraction()
                            updateRunsView({
                              status: 'all',
                              createdFrom: '',
                              createdTo: '',
                              page: 1,
                            })
                          }}
                        >
                          清除全部
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className='space-y-4 p-4'>
                    <div className='space-y-2'>
                      <div className='text-[11px] font-semibold tracking-wide text-muted-foreground uppercase'>
                        任务状态
                      </div>
                      <Select
                        value={status}
                        onValueChange={(value) => {
                          beginTableInteraction()
                          updateRunsView({ status: value, page: 1 })
                        }}
                      >
                        <SelectTrigger>
                          <Filter className='size-4 text-muted-foreground' />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='all'>全部状态</SelectItem>
                          {Object.entries(runStatusMeta).map(
                            ([value, meta]) => (
                              <SelectItem key={value} value={value}>
                                {meta.label}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className='space-y-2'>
                      <div className='text-[11px] font-semibold tracking-wide text-muted-foreground uppercase'>
                        创建时间
                      </div>
                      <div className='flex flex-wrap gap-2'>
                        <Button
                          type='button'
                          size='sm'
                          variant={todayActive ? 'secondary' : 'outline'}
                          className='h-8'
                          onClick={() =>
                            applyTimeRange(todayRange.from, todayRange.to)
                          }
                        >
                          <CalendarDays />
                          今天
                        </Button>
                        {[1, 3, 6].map((hours) => (
                          <Button
                            key={hours}
                            type='button'
                            size='sm'
                            variant='outline'
                            className='h-8'
                            onClick={() => {
                              const range = recentHoursRange(hours)
                              applyTimeRange(range.from, range.to)
                            }}
                          >
                            最近 {hours} 小时
                          </Button>
                        ))}
                      </div>
                      <div className='grid gap-2 sm:grid-cols-2'>
                        <label className='grid gap-1.5'>
                          <span className='text-xs text-muted-foreground'>
                            开始
                          </span>
                          <Input
                            type='datetime-local'
                            value={createdFrom}
                            max={createdTo || undefined}
                            onChange={(event) => {
                              beginTableInteraction()
                              updateRunsView({
                                createdFrom: event.target.value,
                                page: 1,
                              })
                            }}
                            className='h-9 text-xs'
                            aria-label='任务创建开始时间'
                          />
                        </label>
                        <label className='grid gap-1.5'>
                          <span className='text-xs text-muted-foreground'>
                            结束
                          </span>
                          <Input
                            type='datetime-local'
                            value={createdTo}
                            min={createdFrom || undefined}
                            onChange={(event) => {
                              beginTableInteraction()
                              updateRunsView({
                                createdTo: event.target.value,
                                page: 1,
                              })
                            }}
                            className='h-9 text-xs'
                            aria-label='任务创建结束时间'
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            {(activeFilterCount > 0 ||
              (pinnedAccountId == null && search.trim()) ||
              pinnedAccountId != null) && (
              <div className='flex flex-wrap items-center gap-1.5'>
                <span className='mr-1 text-xs text-muted-foreground'>
                  当前条件
                </span>
                {pinnedAccountId != null && (
                  <FilterChip
                    label={`账号：${pinnedAccountLabel}`}
                    onClear={clearPinnedAccount}
                  />
                )}
                {pinnedAccountId == null && search.trim() && (
                  <FilterChip
                    label={`搜索：${search.trim()}`}
                    onClear={() => updateRunsView({ search: '', page: 1 })}
                  />
                )}
                {status !== 'all' && (
                  <FilterChip
                    label={`状态：${runStatusMeta[status]?.label ?? status}`}
                    onClear={() => {
                      beginTableInteraction()
                      updateRunsView({ status: 'all', page: 1 })
                    }}
                  />
                )}
                {timeFilterActive && (
                  <FilterChip
                    label={`时间：${timeFilterLabel}`}
                    onClear={() => applyTimeRange('', '')}
                  />
                )}
              </div>
            )}
          {runsView.active && (
            <PersistedViewNotice
              restored={runsView.restored}
              summary={runsViewSummary}
              onClear={clearRunsView}
            />
          )}
          {invalidTimeRange && (
            <p className='text-xs text-destructive'>
              开始时间需要早于或等于结束时间。
            </p>
          )}
          </div>
        }
        footer={
          query.data ? (
            <ServerPagination
              page={page}
              pageSize={pageSize}
              total={query.data.total}
              disabled={showTableLoading}
              loading={showTableLoading}
              itemLabel='任务'
              onPageChange={(value) => {
                beginTableInteraction()
                updateRunsView({ page: value })
              }}
              onPageSizeChange={(value) => {
                beginTableInteraction()
                updateRunsView({ pageSize: value, page: 1 })
              }}
            />
          ) : null
        }
      >
          {query.isLoading && !query.data ? (
            <LoadingState />
          ) : (
            <>
              <div className='relative min-h-48' aria-busy={showTableLoading}>
                {currentPageRuns.length ? (
                  <RunsTable
                    runs={currentPageRuns}
                    egressNodeNames={egressNodeNames}
                    selection={selection}
                    selectAllChecked={selectAllChecked}
                    currentPageActionableCount={currentPageActionable.length}
                    selectionActionPending={selectionActionPending}
                    actionPending={mutate.isPending || selectionActionPending}
                    onToggleCurrentPage={toggleCurrentPageSelection}
                    onToggleRun={toggleRunSelection}
                    onDetail={openDetail}
                    onAccountDetail={setAccountDetailId}
                    onAction={handleRunAction}
                  />
                ) : (
                  <EmptyState
                    title={
                      deferredSearch ||
                      status !== 'all' ||
                      createdFrom ||
                      createdTo
                        ? '未找到匹配任务'
                        : '暂无探针任务'
                    }
                    description={
                      deferredSearch ||
                      status !== 'all' ||
                      createdFrom ||
                      createdTo
                        ? '请调整账号搜索词、任务状态或时间范围。'
                        : '从账号页面手动选择账号，或配置一个 Cron 计划。'
                    }
                  />
                )}
                {showTableLoading && (
                  <ServerTableLoadingOverlay
                    page={page}
                    itemLabel='任务'
                    message='正在更新任务筛选结果…'
                  />
                )}
              </div>
            </>
          )}
      </TablePanel>
      <AccountProbeDetailDialog
        accountId={accountDetailId}
        open={accountDetailId != null}
        onOpenChange={(open) => {
          if (!open) setAccountDetailId(null)
        }}
        egressNodeNames={egressNodeNames}
      />
      <ResultPreviewGallery
        open={resultPreview != null}
        onOpenChange={(open) => {
          if (!open) setResultPreview(null)
        }}
        items={previewItems}
        index={resultPreview?.index ?? 0}
        onIndexChange={(index) =>
          setResultPreview((current) =>
            current ? { ...current, index } : current
          )
        }
        page={resultPreview?.page ?? page}
        pageCount={previewPageCount}
        total={previewTotal}
        pageLoading={previewPageLoading}
        onPageChange={(nextPage, land) =>
          setResultPreview((current) =>
            current
              ? { ...current, page: nextPage, land, index: 0, sampleId: undefined }
              : current
          )
        }
        onOpenQuarantine={() => {
          void navigate({ to: '/quarantine' } as never)
        }}
      />
      <ProbeDialog
        open={probeSelection != null}
        onOpenChange={(open) => {
          if (!open) setProbeSelection(null)
        }}
        accountIds={probeSelection?.accountIds ?? []}
        sourceTaskCount={probeSelection?.taskCount ?? 0}
        profiles={profiles.data ?? []}
        profilesLoading={profiles.isFetching && !profiles.data}
        profilesError={profiles.isError ? getErrorMessage(profiles.error) : ''}
        onRefreshProfiles={() => void profiles.refetch()}
        egress={egress.data?.items ?? []}
        egressLoading={egress.isFetching}
        egressError={egress.isError ? getErrorMessage(egress.error) : ''}
        onRefreshEgress={() => void egress.refetch()}
        onCreated={() => {
          clearSelection()
          setProbeSelection(null)
          void client.invalidateQueries({ queryKey: ['runs'] })
          void client.invalidateQueries({ queryKey: ['dashboard'] })
        }}
      />
      <Dialog
        open={egressBindingOpen}
        onOpenChange={(open) => {
          if (egressBindingMutation.isPending) return
          setEgressBindingOpen(open)
          if (!open) setEgressBindingTarget(undefined)
        }}
      >
        <DialogContent className='sm:max-w-xl'>
          <DialogHeader>
            <DialogTitle>批量设置账号出口</DialogTitle>
            <DialogDescription>
              为已选任务中的 {selectedAccountIds.length}{' '}
              个去重账号设置固定出口；完成后直接打开建任务窗口。
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <Select
              value={egressBindingTarget}
              onValueChange={setEgressBindingTarget}
              disabled={egressBindingMutation.isPending || egress.isFetching}
            >
              <SelectTrigger className='w-full'>
                <SelectValue
                  placeholder={
                    egress.isFetching ? '正在读取出口…' : '选择出口操作'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {bindableEgress.map((node) => (
                  <SelectItem key={node.id} value={`node:${node.id}`}>
                    {node.name} · {node.assignedAccountCount ?? 0}
                    {node.accountCapacity
                      ? ` / ${node.accountCapacity}`
                      : ' / 不限容量'}
                    {node.probeStatus && node.probeStatus !== 'healthy'
                      ? ` · ${node.probeStatus}`
                      : ''}
                  </SelectItem>
                ))}
                <SelectItem value='unbound'>解除出口绑定</SelectItem>
              </SelectContent>
            </Select>
            {!egress.isFetching && !bindableEgress.length && (
              <p className='text-sm text-amber-600 dark:text-amber-400'>
                当前没有已启用且配置了代理的 grok_build 出口；仍可选择解除绑定。
              </p>
            )}
            <div className='rounded-md border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground'>
              正在执行探针或等待账号设置恢复的账号会跳过；成功修改的账号会自动带入建任务窗口，直接选择方案和轮数即可加入队列。
            </div>
            <ModelBindWindowHint variant='egress' />
          </div>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={egressBindingMutation.isPending}
              onClick={() => setEgressBindingOpen(false)}
            >
              取消
            </Button>
            <Button
              type='button'
              disabled={!egressBindingTarget || egressBindingMutation.isPending}
              onClick={() => {
                const nodeId = egressBindingTarget?.startsWith('node:')
                  ? Number(egressBindingTarget.slice(5))
                  : null
                egressBindingMutation.mutate({
                  accountIds: selectedAccountIds,
                  egressNodeId: nodeId,
                })
              }}
            >
              {egressBindingMutation.isPending ? (
                <Loader2 className='animate-spin' />
              ) : (
                <ServerCog />
              )}
              确认设置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={bulkCancelOpen}
        onOpenChange={(open) => {
          if (!bulkCancel.isPending) setBulkCancelOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              停止 {selectedCancellableRuns.length} 个探针任务？
            </AlertDialogTitle>
            <AlertDialogDescription className='space-y-2'>
              <span className='block'>
                排队任务会立即取消；执行中的任务会中止当前请求，并在恢复账号原设置后结束。
              </span>
              <span className='block'>
                任务、已产生的样本和历史记录仍会保留，进入终态后可继续使用批量删除。
              </span>
              {selectedItems.length > selectedCancellableRuns.length && (
                <span className='block'>
                  另外 {selectedItems.length - selectedCancellableRuns.length}{' '}
                  个已结束或已在停止的任务保持不变。
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkCancel.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={
                bulkCancel.isPending || selectedCancellableRuns.length === 0
              }
              onClick={() =>
                bulkCancel.mutate(
                  selectedCancellableRuns.map((item) => item.id)
                )
              }
            >
              <Square />
              停止任务
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => {
          if (!bulkDelete.isPending) setBulkDeleteOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              删除 {selectedDeletableRuns.length} 个探针任务？
            </AlertDialogTitle>
            <AlertDialogDescription className='space-y-2'>
              <span className='block'>
                任务详情和该任务产生的探针样本会一并删除，账号页的对应历史、出口统计和
                TPS 统计也会减少。
              </span>
              <span className='block'>
                grok2api
                中的账号及其当前设置不会被删除；账号设置尚未恢复的任务不可删除。
              </span>
              {selectedItems.length > selectedDeletableRuns.length && (
                <span className='block'>
                  另外 {selectedItems.length - selectedDeletableRuns.length}{' '}
                  个未结束或账号设置待恢复的任务保持不变。
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDelete.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className='bg-destructive text-white hover:bg-destructive/90'
              disabled={
                bulkDelete.isPending || selectedDeletableRuns.length === 0
              }
              onClick={() =>
                bulkDelete.mutate(selectedDeletableRuns.map((item) => item.id))
              }
            >
              <Trash2 />
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={bulkRestoreOpen}
        onOpenChange={(open) => {
          if (!bulkRestore.isPending) setBulkRestoreOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              同步 {selectedRestorableRuns.length} 个任务的账号原设置？
            </AlertDialogTitle>
            <AlertDialogDescription className='space-y-2'>
              <span className='block'>
                将按任务记录，把这些账号在 grok2api
                中的模型、代理等设置恢复为探针执行前的原始值。
              </span>
              <span className='block'>
                仅对账号设置待恢复（恢复失败或诊断激活未回滚）的任务生效，同步成功后即可删除对应任务。
              </span>
              {selectedItems.length > selectedRestorableRuns.length && (
                <span className='block'>
                  另外 {selectedItems.length - selectedRestorableRuns.length}{' '}
                  个无需同步的任务保持不变。
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkRestore.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={
                bulkRestore.isPending || selectedRestorableRuns.length === 0
              }
              onClick={() =>
                bulkRestore.mutate(
                  selectedRestorableRuns.map((item) => item.id)
                )
              }
            >
              <Undo2 />
              同步原设置
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={detailId != null}
        onOpenChange={(open) => {
          if (!open) closeDetail()
        }}
      >
        <DialogContent
          size='wide'
          className='max-h-[calc(100dvh-2rem)] overflow-hidden data-[state=closed]:animate-none data-[state=closed]:duration-0'
        >
          <DialogHeader className='shrink-0'>
            <DialogTitle>探针任务详情</DialogTitle>
            <DialogDescription className='flex items-center gap-1 font-mono'>
              <span className='min-w-0 break-all'>{detailId}</span>
              {detailId ? (
                <CopyButton value={detailId} className='size-6' />
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <div
            ref={detailScrollRef}
            className='min-h-0 flex-1 overflow-y-auto overscroll-contain pe-1'
            onScroll={(event) => {
              detailScrollTopRef.current = event.currentTarget.scrollTop
            }}
          >
            {detail.isLoading ? (
              <LoadingState />
            ) : (
              detail.data && (
                <RunDetail
                  data={detail.data}
                  egressNodeNames={egressNodeNames}
                  onAction={(action) =>
                    mutate.mutate({ action, id: detail.data.run.id })
                  }
                />
              )
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  )
}

type RunsTableProps = {
  runs: ProbeRun[]
  egressNodeNames: EgressNodeNameMap
  selection: Map<string, RunSelectionItem>
  selectAllChecked: boolean | 'indeterminate'
  currentPageActionableCount: number
  selectionActionPending: boolean
  actionPending: boolean
  onToggleCurrentPage: (checked: boolean) => void
  onToggleRun: (run: ProbeRun, checked: boolean) => void
  onDetail: (id: string) => void
  onAccountDetail: (id: number) => void
  onAction: (
    action: 'cancel' | 'retry' | 'delete' | 'restore',
    id: string
  ) => void
}

const RunsTable = memo(function RunsTable({
  runs,
  egressNodeNames,
  selection,
  selectAllChecked,
  currentPageActionableCount,
  selectionActionPending,
  actionPending,
  onToggleCurrentPage,
  onToggleRun,
  onDetail,
  onAccountDetail,
  onAction,
}: RunsTableProps) {
  return (
    <Table rememberRowKey='monitor-runs'>
      <TableHeader>
        <TableRow>
          <TableHead className='w-10'>
            <Checkbox
              checked={selectAllChecked}
              onCheckedChange={(value) => onToggleCurrentPage(value === true)}
              disabled={
                currentPageActionableCount === 0 || selectionActionPending
              }
              aria-label='选择当前页全部任务'
            />
          </TableHead>
          <TableHead>账号</TableHead>
          <TableHead>来源</TableHead>
          <TableHead>模式</TableHead>
          <TableHead>任务状态</TableHead>
          <TableHead>探针统计</TableHead>
          <TableHead>进度 / 预计耗时</TableHead>
          <TableHead>当前步骤</TableHead>
          <TableHead>创建时间</TableHead>
          <TableHead className='text-right'>操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            egressNodeNames={egressNodeNames}
            selected={selection.has(run.id)}
            selectable={runSelectionAction(run) != null}
            onSelectedChange={(checked) => onToggleRun(run, checked)}
            onDetail={() => onDetail(run.id)}
            onAccountDetail={() => {
              const id = Number(run.account_id)
              if (id > 0) onAccountDetail(id)
            }}
            onAction={(action) => onAction(action, run.id)}
            pending={actionPending}
          />
        ))}
      </TableBody>
    </Table>
  )
})

type RunRowProps = {
  run: ProbeRun
  egressNodeNames: EgressNodeNameMap
  selected: boolean
  selectable: boolean
  onSelectedChange: (checked: boolean) => void
  onDetail: () => void
  onAccountDetail: () => void
  onAction: (action: 'cancel' | 'retry' | 'delete' | 'restore') => void
  pending: boolean
}

const RunRow = memo(function RunRow({
  run,
  egressNodeNames,
  selected,
  selectable,
  onSelectedChange,
  onDetail,
  onAccountDetail,
  onAction,
  pending,
}: RunRowProps) {
  const progress = run.total_steps
    ? Math.round((run.completed_steps / run.total_steps) * 100)
    : 0
  const restoreBlocked = accountRestoreNeedsAttention(run)
  const accountLabel =
    run.account_name || run.account_email || `账号 ${run.account_id}`
  const secondaryAccountLabel = formatAccountSecondaryLabel({
    id: run.account_id,
    email: run.account_email,
    createdAt: run.account_created_at,
    accountLabel,
  })
  return (
    <TableRow rowId={run.id}>
      <TableCell>
        <Checkbox
          checked={selected}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          disabled={pending || (!selectable && !selected)}
          aria-label={`选择任务 ${run.id}`}
        />
      </TableCell>
      <TableCell>
        <div className='flex items-start gap-1'>
          <div className='min-w-0'>
            <button
              type='button'
              onClick={onAccountDetail}
              className='block max-w-full truncate text-left text-sm font-medium hover:text-primary hover:underline'
              title={accountLabel}
            >
              {accountLabel}
            </button>
            <div
              className='max-w-80 text-xs text-muted-foreground'
              title={secondaryAccountLabel}
            >
              {secondaryAccountLabel}
            </div>
          </div>
          <CopyButton
            value={run.account_email?.trim() || String(run.account_id)}
            className='size-6'
          />
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={run.trigger === 'cron' ? 'info' : 'secondary'}>
          {run.trigger === 'cron'
            ? 'Cron'
            : run.trigger === 'register'
              ? '注册联动'
              : run.trigger === 'retry'
                ? '重试'
                : '手动'}
        </Badge>
      </TableCell>
      <TableCell>
        <ExecutionModeBadge mode={run.execution_mode} />
      </TableCell>
      <TableCell>
        <div className='flex items-center gap-2'>
          <RunStatusIndicator value={run.status} />
          <QueueWaitIndicator reason={run.queue_blocked_reason} />
          <WorkerAssignmentIndicator workerId={run.worker_id} />
          <AccountRestoreIndicator run={run} />
        </div>
        {run.error && (
          <div
            className='mt-1 max-w-52 truncate text-xs text-destructive'
            title={run.error}
          >
            {run.error}
          </div>
        )}
      </TableCell>
      <TableCell>
        <RunProbeStats run={run} />
      </TableCell>
      <TableCell className='min-w-40'>
        <div className='flex justify-between text-xs text-muted-foreground'>
          <span>
            {run.completed_steps}/{run.total_steps}
          </span>
          <span>{progress}%</span>
        </div>
        <ProgressBar value={progress} className='mt-1.5' />
        <RunDurationEstimate run={run} className='mt-1.5' />
      </TableCell>
      <TableCell>
        <div className='text-sm'>
          {run.current_round ? `第 ${run.current_round} 轮` : '—'}
        </div>
        <div className='flex items-center gap-1 text-xs text-muted-foreground'>
          <TargetKeyLabel
            value={run.current_target_key}
            egressNodeNames={egressNodeNames}
          />
          <RunEgressIndicator run={run} egressNodeNames={egressNodeNames} />
        </div>
      </TableCell>
      <TableCell>{formatDate(run.created_at)}</TableCell>
      <TableCell>
        <div className='flex justify-end gap-1'>
          <RunActionIcon label='查看详情' onClick={onDetail}>
            <Eye />
          </RunActionIcon>
          {!terminal.has(run.status) ? (
            <RunActionIcon
              label='取消任务'
              disabled={pending}
              onClick={() => onAction('cancel')}
            >
              <Square />
            </RunActionIcon>
          ) : restoreBlocked ? (
            <RunActionIcon
              label='同步账号原设置'
              variant='outline'
              className='text-destructive'
              disabled={pending}
              onClick={() => onAction('restore')}
            >
              <Undo2 />
            </RunActionIcon>
          ) : (
            <>
              <RunActionIcon
                label='重新加入队列'
                disabled={pending}
                onClick={() => onAction('retry')}
              >
                <RotateCcw />
              </RunActionIcon>
              <RunActionIcon
                label='删除任务'
                className='text-destructive'
                disabled={pending}
                onClick={() => onAction('delete')}
              >
                <Trash2 />
              </RunActionIcon>
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}, areRunRowPropsEqual)

function areRunRowPropsEqual(previous: RunRowProps, next: RunRowProps) {
  return (
    previous.run === next.run &&
    previous.egressNodeNames === next.egressNodeNames &&
    previous.selected === next.selected &&
    previous.selectable === next.selectable &&
    previous.pending === next.pending
  )
}

function RunStatusIndicator({
  value,
  showLabel = false,
}: {
  value?: string | null
  showLabel?: boolean
}) {
  const meta = runStatusMeta[value || ''] || {
    label: '未知任务状态',
    icon: CircleAlert,
    tone: 'text-muted-foreground',
  }
  const Icon = meta.icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium',
            showLabel ? 'max-w-full' : 'size-7 justify-center px-0',
            meta.tone
          )}
          tabIndex={0}
          aria-label={meta.label}
        >
          <Icon
            className={cn(
              'size-4 shrink-0',
              value === 'running' && 'animate-spin'
            )}
          />
          {showLabel && <span className='truncate'>{meta.label}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent>{meta.label}（任务状态）</TooltipContent>
    </Tooltip>
  )
}

function QueueWaitIndicator({ reason }: { reason?: string }) {
  if (!reason) return null
  const labels: Record<string, string> = {
    same_account_running:
      '同一账号已有任务执行中；为避免出口绑定和账号原设置互相覆盖，本任务保持排队。',
    account_restore_blocked:
      '该账号原设置尚在恢复或需要人工同步，本任务暂缓领取。',
    worker_capacity: '任务可执行，正在等待空闲 Worker。',
  }
  const label = labels[reason] || '任务正在等待 Worker 领取。'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-md border bg-background',
            reason === 'worker_capacity'
              ? 'text-muted-foreground'
              : 'text-amber-600 dark:text-amber-400'
          )}
          tabIndex={0}
          aria-label={label}
        >
          <Clock3 className='size-4' />
        </span>
      </TooltipTrigger>
      <TooltipContent className='max-w-96'>{label}</TooltipContent>
    </Tooltip>
  )
}

function WorkerAssignmentIndicator({ workerId }: { workerId?: string | null }) {
  if (!workerId) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className='inline-flex size-7 items-center justify-center rounded-md border bg-background text-sky-600'
          tabIndex={0}
          aria-label={`执行 Worker：${workerId}`}
        >
          <Activity className='size-4' />
        </span>
      </TooltipTrigger>
      <TooltipContent>执行 Worker：{workerId}</TooltipContent>
    </Tooltip>
  )
}

function RunProbeStats({ run }: { run: ProbeRun }) {
  const stats = getRunProbeStats(run)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className='flex items-center gap-2 text-xs tabular-nums'>
          <span
            className={cn(
              'inline-flex items-center gap-1',
              stats.anomalies > 0
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground'
            )}
          >
            <TriangleAlert className='size-3.5' />
            {stats.anomalies}
          </span>
          {stats.warnings > 0 && (
            <span className='inline-flex items-center gap-1 text-destructive'>
              <CircleAlert className='size-3.5' />
              {stats.warnings}
            </span>
          )}
          <span className='inline-flex items-center gap-1 text-muted-foreground'>
            <Activity className='size-3.5' />
            {stats.samples}
          </span>
          {stats.maxTps != null && (
            <span className='inline-flex items-center gap-1 text-muted-foreground'>
              <Gauge className='size-3.5' />
              <DualTpsValue
                tps={stats.maxTps}
                upstreamTps={stats.maxUpstreamTps}
                compact
              />
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent className='max-w-96'>
        本任务探针统计：{stats.anomalies} 个降智信号
        {stats.warnings > 0 ? `，${stats.warnings} 个样本不足` : ''} /{' '}
        {stats.samples} 个样本
        {stats.maxTps != null
          ? `。TPS 显示本任务最高值 ${formatDualTps(stats.maxTps, stats.maxUpstreamTps)}，平均 ${formatDualTps(stats.avgTps, stats.avgUpstreamTps)}${
              tpsOverridden(stats.maxTps, stats.maxUpstreamTps)
                ? '；紫色为按生成窗口重算，灰色为上游被压低的原值'
                : ''
            }`
          : ''}
        。样本不足会在任务中心标记异常提示，不能视为探针通过
        {run.trigger === 'register' ? '，注册联动也不会恢复优先级' : ''}
        。这些数字只代表本任务，不等同账号最终监控判定。
      </TooltipContent>
    </Tooltip>
  )
}

function RunDurationEstimate({
  run,
  className,
}: {
  run: ProbeRun
  className?: string
}) {
  if (run.status !== 'queued' && run.status !== 'running') return null
  const estimate = run.duration_estimate
  if (!estimate?.sample_count || estimate.estimated_total_ms <= 0) {
    return (
      <span className={cn('block text-xs text-muted-foreground', className)}>
        暂无历史样本
      </span>
    )
  }
  const label =
    run.status === 'queued'
      ? `预计 ${formatDuration(estimate.estimated_total_ms)}`
      : estimate.estimated_remaining_ms > 0
        ? `约剩 ${formatDuration(estimate.estimated_remaining_ms)}`
        : '正在收尾'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'flex w-fit items-center gap-1 text-xs text-sky-600 dark:text-sky-400',
            className
          )}
          tabIndex={0}
        >
          <Clock3 className='size-3.5 shrink-0' />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className='max-w-96'>
        基于同一探针方案和执行模式的 {estimate.sample_count}{' '}
        个有效样本，平均每个样本 {formatDuration(estimate.average_sample_ms)}
        ，预计总执行时间 {formatDuration(estimate.estimated_total_ms)}
        。排队、步骤间隔、重试等待和任务收尾可能产生额外耗时。
      </TooltipContent>
    </Tooltip>
  )
}

function getRunProbeStats(run: ProbeRun) {
  const summary =
    run.summary && typeof run.summary === 'object' ? run.summary : {}
  const classifications =
    summary.classifications && typeof summary.classifications === 'object'
      ? (summary.classifications as Record<string, unknown>)
      : {}
  const classificationAnomalies = Object.entries(classifications).reduce(
    (total, [name, value]) =>
      total +
      (degradationClassifications.has(name) ? toFiniteNumber(value) || 0 : 0),
    0
  )
  const classificationWarnings = Object.entries(classifications).reduce(
    (total, [name, value]) =>
      total +
      (warningClassifications.has(name) ? toFiniteNumber(value) || 0 : 0),
    0
  )
  return {
    samples:
      toFiniteNumber(summary.sample_count) ??
      toFiniteNumber(summary.completed) ??
      run.completed_steps,
    anomalies: toFiniteNumber(summary.anomaly_count) ?? classificationAnomalies,
    warnings: toFiniteNumber(summary.warning_count) ?? classificationWarnings,
    maxTps: toFiniteNumber(summary.max_tps),
    avgTps: toFiniteNumber(summary.avg_tps),
    maxUpstreamTps: toFiniteNumber(summary.max_upstream_tps),
    avgUpstreamTps: toFiniteNumber(summary.avg_upstream_tps),
  }
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0 秒'
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalMinutes < 60) {
    return seconds
      ? `${totalMinutes} 分钟 ${seconds} 秒`
      : `${totalMinutes} 分钟`
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function RunDetail({
  data,
  egressNodeNames,
  onAction,
}: {
  data: { run: ProbeRun; profile: ProbeProfile; samples: ProbeSample[] }
  egressNodeNames: EgressNodeNameMap
  onAction: (action: 'cancel' | 'retry' | 'delete' | 'restore') => void
}) {
  const run = data.run
  const profile = data.profile
  const restoreBlocked = accountRestoreNeedsAttention(run)
  const probeStats = getRunProbeStats(run)
  return (
    <div className='space-y-5'>
      <div className='grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(7,minmax(0,1fr))]'>
        <Metric
          label='账号'
          value={
            <div className='flex items-start gap-1'>
              <div className='min-w-0'>
                <div className='break-all'>
                  {run.account_name || run.account_id}
                </div>
                <div className='mt-1 text-xs font-normal text-muted-foreground'>
                  {formatAccountSecondaryLabel({
                    id: run.account_id,
                    email: run.account_email,
                    createdAt: run.account_created_at,
                    accountLabel:
                      run.account_name ||
                      run.account_email ||
                      `账号 ${run.account_id}`,
                  })}
                </div>
              </div>
              <CopyButton
                value={run.account_email?.trim() || String(run.account_id)}
                className='size-6'
              />
            </div>
          }
          valueClassName='break-all'
        />
        <Metric
          label='模式'
          value={<ExecutionModeBadge mode={run.execution_mode} />}
        />
        <Metric
          label='任务状态'
          value={<RunStatusIndicator value={run.status} showLabel />}
        />
        <Metric
          label='Worker'
          value={run.worker_id || (run.status === 'queued' ? '等待领取' : '—')}
          valueClassName='font-mono text-xs'
        />
        <Metric
          label='任务 ID'
          value={
            <CopyableText value={run.id} className='max-w-full'>
              <span className='break-all'>{run.id}</span>
            </CopyableText>
          }
          valueClassName='font-mono text-xs'
        />
        <Metric
          label='进度'
          value={`${run.completed_steps} / ${run.total_steps}`}
        />
        <Metric label='错误' value={run.error_count} />
        <Metric
          label={
            run.status === 'queued' || run.status === 'running'
              ? '预计耗时'
              : '耗时'
          }
          value={
            run.started_at && run.completed_at ? (
              formatDuration(
                Math.max(
                  0,
                  new Date(run.completed_at).getTime() -
                    new Date(run.started_at).getTime()
                )
              )
            ) : run.status === 'queued' || run.status === 'running' ? (
              <RunDurationEstimate run={run} />
            ) : (
              '—'
            )
          }
        />
      </div>
      <AccountRestoreCard
        run={run}
        egressNodeNames={egressNodeNames}
        onRestore={() => onAction('restore')}
      />
      {run.error ? (
        <ModelBindWindowError message={run.error} />
      ) : null}
      <div className='rounded-lg border bg-muted/20 p-4'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='min-w-0'>
            <div className='text-sm font-medium'>{profile.name}</div>
            <div className='mt-1 text-xs text-muted-foreground'>
              {profile.model} · 自动校验标记 {profile.expected_text || '未设置'}
            </div>
          </div>
          {profile.expected_output && (
            <FormattedContentPreviewButton
              content={profile.expected_output}
              expectedImageUrl={profile.expected_image_url}
              label='预览预期结果'
              title={`${profile.name} · 预期结果`}
            />
          )}
        </div>
        <div className='mt-3 text-sm whitespace-pre-wrap'>{profile.prompt}</div>
        {profile.expected_image_url && (
          <a
            href={profile.expected_image_url}
            target='_blank'
            rel='noreferrer'
            className='mt-2 inline-block text-xs text-primary hover:underline'
          >
            查看预期效果图
          </a>
        )}
      </div>
      {probeStats.warnings > 0 && (
        <div className='rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive'>
          本任务有 {probeStats.warnings}{' '}
          个样本不足，输出长度不够，不能视为有效探针结果。
          {run.trigger === 'register'
            ? '注册联动账号将保持降低后的优先级。'
            : ''}
        </div>
      )}
      <div className='space-y-3'>
        {data.samples.map((sample) => (
          <SampleCard
            key={sample.id}
            sample={sample}
            expectedImageUrl={profile.expected_image_url}
            executionMode={run.execution_mode}
            egressNodeNames={egressNodeNames}
          />
        ))}
        {!data.samples.length && (
          <EmptyState
            title='尚无样本'
            description='任务排队中，或当前步骤仍在等待上游流式响应。'
          />
        )}
      </div>
      <div className='flex justify-end gap-2'>
        {terminal.has(run.status) && !restoreBlocked ? (
          <>
            <RunActionIcon
              label='重新加入队列'
              variant='outline'
              onClick={() => onAction('retry')}
            >
              <RotateCcw />
            </RunActionIcon>
            <RunActionIcon
              label='删除任务'
              variant='destructive'
              onClick={() => onAction('delete')}
            >
              <Trash2 />
            </RunActionIcon>
          </>
        ) : !terminal.has(run.status) ? (
          <RunActionIcon
            label='取消任务'
            variant='outline'
            onClick={() => onAction('cancel')}
          >
            <Square />
          </RunActionIcon>
        ) : null}
      </div>
    </div>
  )
}

function AccountRestoreCard({
  run,
  egressNodeNames,
  onRestore,
}: {
  run: ProbeRun
  egressNodeNames: EgressNodeNameMap
  onRestore: () => void
}) {
  if (!run.account_settings_snapshot_at) return null
  const status = run.account_restore_status || 'pending'
  if (status === 'not_recorded') return null
  const restored = isAccountRestored(status)
  return (
    <div className='rounded-lg border bg-muted/15 p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex items-center gap-2'>
            <span className='text-sm font-semibold'>账号原设置</span>
            <AccountRestoreIndicator run={run} />
          </div>
          <div className='mt-3 flex flex-wrap items-center gap-2'>
            <EnabledBadge enabled={run.original_account_enabled} />
            <RestoreFact
              icon={ArrowUp}
              value={run.original_account_priority ?? '—'}
              tooltip={`原优先级：${run.original_account_priority ?? '未记录'}`}
            />
            <RestoreFact
              icon={Gauge}
              value={run.original_account_max_concurrent ?? '—'}
              tooltip={`原最大并发：${run.original_account_max_concurrent ?? '未记录'}`}
            />
            <EgressBindingIndicator
              nodeId={run.original_egress_node_id}
              nodeName={getEgressNodeName(
                egressNodeNames,
                run.original_egress_node_id
              )}
              assignmentMode={run.original_egress_assignment_mode}
            />
            <RestoreFact
              icon={Activity}
              value={`${run.diagnostic_priority ?? '—'} / ${run.diagnostic_max_concurrent ?? '—'}`}
              tooltip='诊断短时设置：优先级 / 最大并发'
            />
            <RestoreFact
              icon={History}
              value={run.account_restore_attempts ?? 0}
              tooltip={`恢复尝试次数${run.account_restored_at ? `；最近完成于 ${formatDate(run.account_restored_at)}` : ''}`}
            />
          </div>
        </div>
        <RunActionIcon
          label={restored ? '重新同步原设置' : '同步原设置'}
          variant={status === 'restore_failed' ? 'default' : 'outline'}
          disabled={!terminal.has(run.status) || status === 'restoring'}
          onClick={onRestore}
        >
          <Undo2 />
        </RunActionIcon>
      </div>
    </div>
  )
}

function isAccountRestored(status: string) {
  return ['automatic_restored', 'startup_restored', 'manual_restored'].includes(
    status
  )
}

function accountRestoreNeedsAttention(run: ProbeRun) {
  return (
    run.account_restore_status === 'restore_failed' ||
    run.diagnostic_activation_active === true
  )
}

function isRunCancellable(run: ProbeRun) {
  return cancellableRunStatuses.has(run.status)
}

function runSelectionAction(run: ProbeRun): RunSelectionAction | null {
  if (isRunCancellable(run)) return 'cancel'
  if (terminal.has(run.status)) {
    return accountRestoreNeedsAttention(run) ? 'restore' : 'delete'
  }
  return null
}

function runSelectionItem(run: ProbeRun): RunSelectionItem | null {
  const action = runSelectionAction(run)
  if (!action) return null
  return { id: run.id, accountId: Number(run.account_id) || 0, action }
}

function TargetKeyLabel({
  value,
  egressNodeNames,
}: {
  value?: string | null
  egressNodeNames: EgressNodeNameMap
}) {
  if (!value) return null
  if (value === 'current') return '账号当前出口'
  if (value === 'direct') return '上游调度（诊断）'
  if (!value.startsWith('egress:')) return value
  const nodeId = value.slice(7)
  return (
    <EgressNodeReference
      nodeId={nodeId}
      nodeName={getEgressNodeName(egressNodeNames, nodeId)}
      prefix='Node '
    />
  )
}

function RunEgressIndicator({
  run,
  egressNodeNames,
}: {
  run: ProbeRun
  egressNodeNames: EgressNodeNameMap
}) {
  const configuredTargets = run.proxy_targets.map((target) =>
    formatRunTarget(target.kind, target.id, egressNodeNames)
  )
  const currentTarget = run.current_target_key
    ? formatRunTargetKey(run.current_target_key, egressNodeNames)
    : '尚未进入探针步骤'
  const accountBinding = run.account_settings_snapshot_at
    ? run.original_egress_node_id
      ? formatEgressNodeText(
          egressNodeNames,
          run.original_egress_node_id,
          'Node '
        )
      : '未绑定固定出口'
    : '任务尚未领取，暂无绑定快照'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className='inline-flex size-6 shrink-0 cursor-help items-center justify-center rounded-md border bg-background text-muted-foreground'
          tabIndex={0}
          aria-label='查看当前任务出口'
        >
          <ServerCog className='size-3.5' />
        </span>
      </TooltipTrigger>
      <TooltipContent className='max-w-96 space-y-1'>
        <div className='font-medium'>当前任务出口</div>
        <div>当前步骤：{currentTarget}</div>
        <div>账号绑定：{accountBinding}</div>
        <div>任务目标：{configuredTargets.join('、') || '未配置'}</div>
      </TooltipContent>
    </Tooltip>
  )
}

function formatRunTarget(
  kind: string,
  nodeId: number | null,
  egressNodeNames: EgressNodeNameMap
) {
  if (kind === 'current') return '账号当前出口'
  if (kind === 'direct') return '上游调度（诊断）'
  if (kind === 'egress' && nodeId != null) {
    return formatEgressNodeText(egressNodeNames, nodeId, 'Node ')
  }
  return kind || '未知目标'
}

function formatRunTargetKey(
  targetKey: string,
  egressNodeNames: EgressNodeNameMap
) {
  if (targetKey === 'current') return '账号当前出口'
  if (targetKey === 'direct') return '上游调度（诊断）'
  if (targetKey.startsWith('egress:')) {
    return formatEgressNodeText(egressNodeNames, targetKey.slice(7), 'Node ')
  }
  return targetKey
}

function toIsoDateTime(value: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function localDayRange(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const prefix = `${year}-${month}-${day}`
  return { from: `${prefix}T00:00`, to: `${prefix}T23:59` }
}

function toDateTimeLocal(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000
  return new Date(value.getTime() - offset).toISOString().slice(0, 16)
}

function recentHoursRange(hours: number) {
  const end = new Date()
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000)
  return { from: toDateTimeLocal(start), to: toDateTimeLocal(end) }
}

function formatDateTimeInput(value: string) {
  return value.replace('T', ' ')
}

function RestoreFact({
  icon: Icon,
  value,
  tooltip,
}: {
  icon: typeof ArrowUp
  value: ReactNode
  tooltip: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className='inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs tabular-nums'
          tabIndex={0}
        >
          <Icon className='size-3.5 text-muted-foreground' />
          {value}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function RunActionIcon({
  label,
  children,
  onClick,
  disabled = false,
  variant = 'ghost',
  className,
}: {
  label: string
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: React.ComponentProps<typeof Button>['variant']
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type='button'
          size='icon'
          variant={variant}
          className={className}
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function SampleCard({
  sample,
  expectedImageUrl,
  executionMode,
  egressNodeNames,
}: {
  sample: ProbeSample
  expectedImageUrl?: string
  executionMode: ExecutionMode
  egressNodeNames: EgressNodeNameMap
}) {
  const responseText = sample.response_text || '（空响应）'
  const isLongResponse = responseText.length > 4_000
  const hasHtmlPreview = useMemo(
    () => extractHtmlPreviews(responseText).length > 0,
    [responseText]
  )
  const responseCollapsible = isLongResponse || hasHtmlPreview
  const [responseDisplay, setResponseDisplay] = useState<
    'auto' | 'expanded' | 'collapsed'
  >('auto')
  const responseScrollRef = useRef<HTMLDivElement | null>(null)
  const responseScrollTopRef = useRef(0)
  const responseExpanded =
    responseDisplay === 'expanded' ||
    (responseDisplay === 'auto' && !responseCollapsible)
  useLayoutEffect(() => {
    const element = responseScrollRef.current
    if (!element || !responseExpanded) return
    element.scrollTop = Math.min(
      responseScrollTopRef.current,
      Math.max(0, element.scrollHeight - element.clientHeight)
    )
  }, [responseExpanded, responseText])
  const responsePreview = responseText.slice(0, 240).replace(/\s+/g, ' ').trim()
  const targetEgressMismatch =
    ['current', 'egress'].includes(sample.target_kind) &&
    sample.egress_node_id != null &&
    sample.verified_egress_node_id != null &&
    Number(sample.egress_node_id) !== Number(sample.verified_egress_node_id)
  return (
    <div className='rounded-xl border bg-card'>
      <div className='flex flex-wrap items-center gap-2 border-b px-4 py-3'>
        <span className='text-sm font-semibold'>
          第 {sample.round_number} 轮 ·{' '}
          {sample.target_kind === 'current' ? (
            sample.verified_egress_node_id ? (
              <>
                账号当前出口 ·{' '}
                <EgressNodeReference
                  nodeId={sample.verified_egress_node_id}
                  nodeName={getEgressNodeName(
                    egressNodeNames,
                    sample.verified_egress_node_id
                  )}
                />
              </>
            ) : (
              '账号当前出口 · 未核验'
            )
          ) : sample.target_kind === 'direct' ? (
            sample.verified_egress_node_id ? (
              <>
                上游调度诊断 ·{' '}
                <EgressNodeReference
                  nodeId={sample.verified_egress_node_id}
                  nodeName={getEgressNodeName(
                    egressNodeNames,
                    sample.verified_egress_node_id
                  )}
                />
              </>
            ) : (
              '上游调度诊断 · 本地出口'
            )
          ) : (
            sample.egress_name
          )}
        </span>
        <StatusBadge value={sample.classification} />
        {sample.error_code && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className='inline-flex size-6 items-center justify-center rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400'
                tabIndex={0}
                aria-label='上游暂时不可调度'
              >
                <Clock3 className='size-3.5' />
              </span>
            </TooltipTrigger>
            <TooltipContent className='max-w-96'>
              上游暂时不可调度：{sample.error_code}
              {sample.retry_count ? `，已重试 ${sample.retry_count} 次` : ''}
              {sample.retry_after_seconds
                ? `，建议等待 ${formatNumber(sample.retry_after_seconds)} 秒`
                : ''}
            </TooltipContent>
          </Tooltip>
        )}
        {targetEgressMismatch && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className='inline-flex size-6 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400'
                tabIndex={0}
                aria-label='目标出口与实际出口不同'
              >
                <TriangleAlert className='size-3.5' />
              </span>
            </TooltipTrigger>
            <TooltipContent className='max-w-80'>
              目标出口{' '}
              {formatEgressNodeText(egressNodeNames, sample.egress_node_id)}
              ，实际出口{' '}
              {formatEgressNodeText(
                egressNodeNames,
                sample.verified_egress_node_id
              )}
              ；流式结果有效，已继续计算 TPS 与分类。
            </TooltipContent>
          </Tooltip>
        )}
        <span className='ms-auto text-xs text-muted-foreground'>
          {formatDate(sample.created_at)}
        </span>
        {responseCollapsible && (
          <RunActionIcon
            label={responseExpanded ? '收起响应' : '展开响应'}
            onClick={() =>
              setResponseDisplay(responseExpanded ? 'collapsed' : 'expanded')
            }
          >
            {responseExpanded ? <ChevronUp /> : <ChevronDown />}
          </RunActionIcon>
        )}
      </div>
      <div className='grid gap-3 border-b bg-muted/15 p-4 sm:grid-cols-3 lg:grid-cols-6'>
        <Metric
          label='TPS'
          value={
            <SampleTpsDetail
              tps={sample.tps}
              upstreamTps={sample.upstream_tps}
              outputTokens={sample.output_tokens}
              generationMs={sample.generation_ms}
            />
          }
        />
        <Metric label='首 Token' value={`${sample.first_token_ms} ms`} />
        <Metric label='总耗时' value={`${sample.duration_ms} ms`} />
        <Metric label='生成窗口' value={`${sample.generation_ms} ms`} />
        <Metric label='输出 Token' value={sample.output_tokens} />
        <Metric
          label='预期匹配'
          value={
            sample.expected_matched == null
              ? '—'
              : sample.expected_matched
                ? '是'
                : '否'
          }
        />
      </div>
      <div className='space-y-3 p-4'>
        {sample.error ? (
          <div className='space-y-2'>
            <div className='space-y-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive'>
              <div className='break-words whitespace-pre-wrap'>
                {sample.error}
              </div>
              {sample.error_code && (
                <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
                  <Badge variant='outline'>{sample.error_code}</Badge>
                  {sample.status_code > 0 && (
                    <span>HTTP {sample.status_code}</span>
                  )}
                  {sample.retry_count ? (
                    <span>重试 {sample.retry_count} 次</span>
                  ) : null}
                </div>
              )}
            </div>
            {isModelBindWindowIssue(sample.error, sample.error_code) ? (
              <ModelBindWindowHint variant='error' />
            ) : null}
          </div>
        ) : null}
        {executionMode === 'quality_test' && !sample.response_text ? (
              <div className='rounded-lg border border-sky-500/20 bg-sky-500/5 p-4'>
                <div className='text-sm font-medium'>上游仅返回哈希和指标</div>
                <p className='mt-1 text-xs leading-5 text-muted-foreground'>
                  快速出口质量探针不会返回可渲染正文；账号与出口由 grok2api
                  审计记录交叉核验。
                </p>
                <div className='mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4'>
                  <Evidence label='响应哈希' value={sample.response_sha256} />
                  <Evidence label='Request ID' value={sample.request_id} />
                  <Evidence
                    label='核验账号'
                    value={sample.verified_account_id}
                  />
                  <Evidence
                    label='核验出口'
                    value={
                      sample.verified_egress_node_id ? (
                        <EgressNodeReference
                          nodeId={sample.verified_egress_node_id}
                          nodeName={getEgressNodeName(
                            egressNodeNames,
                            sample.verified_egress_node_id
                          )}
                        />
                      ) : (
                        '—'
                      )
                    }
                  />
                </div>
              </div>
            ) : (
              <>
                <ReasoningPanel
                  content={sample.reasoning_text || ''}
                  tokenCount={sample.reasoning_tokens}
                />
                {responseExpanded ? (
                  <div
                    ref={responseScrollRef}
                    className='max-h-[32rem] min-w-0 overflow-auto overscroll-contain rounded-lg'
                    onScroll={(event) => {
                      responseScrollTopRef.current =
                        event.currentTarget.scrollTop
                    }}
                  >
                    {hasHtmlPreview ? (
                      <SourceCodeView
                        content={responseText}
                        className='min-h-full rounded-lg'
                      />
                    ) : (
                      <MarkdownView
                        content={responseText}
                        codeBlockClassName='max-h-none overflow-visible overscroll-auto'
                      />
                    )}
                  </div>
                ) : (
                  <button
                    type='button'
                    className='flex w-full items-center gap-3 rounded-lg border border-dashed bg-muted/20 p-3 text-start transition-colors hover:bg-muted/40'
                    onClick={() => setResponseDisplay('expanded')}
                  >
                    <ChevronDown className='size-4 shrink-0 text-muted-foreground' />
                    <span className='min-w-0 flex-1'>
                      <span className='block text-sm font-medium'>
                        {hasHtmlPreview ? 'HTML 响应已折叠' : '长响应已折叠'}
                      </span>
                      <span className='mt-1 line-clamp-2 block font-mono text-xs text-muted-foreground'>
                        {responsePreview || '点击展开完整响应'}
                      </span>
                    </span>
                    <Badge variant='outline' className='shrink-0 tabular-nums'>
                      {formatNumber(responseText.length, 0)} 字符
                    </Badge>
                  </button>
                )}
                <div className='mt-3 flex items-center gap-2'>
                  <HtmlPreviewButton
                    content={responseText}
                    expectedImageUrl={expectedImageUrl}
                  />
                  {responseCollapsible && responseExpanded && (
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => setResponseDisplay('collapsed')}
                    >
                      <ChevronUp />
                      收起响应
                    </Button>
                  )}
                </div>
              </>
        )}
      </div>
    </div>
  )
}

function ExecutionModeBadge({ mode }: { mode?: ExecutionMode }) {
  return (
    <Badge variant={mode === 'quality_test' ? 'info' : 'outline'}>
      {mode === 'quality_test' ? '快速质量' : '完整对话'}
    </Badge>
  )
}

function Evidence({ label, value }: { label: string; value: ReactNode }) {
  const title =
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : undefined
  return (
    <div className='min-w-0 rounded-md border bg-background px-2.5 py-2'>
      <div className='text-muted-foreground'>{label}</div>
      <div className='mt-1 truncate font-mono' title={title}>
        {value ?? '—'}
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  valueClassName,
}: {
  label: string
  value: React.ReactNode
  valueClassName?: string
}) {
  return (
    <div className='min-w-0'>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div
        className={cn(
          'mt-1 min-w-0 text-sm font-semibold tabular-nums',
          valueClassName
        )}
      >
        {value}
      </div>
    </div>
  )
}
