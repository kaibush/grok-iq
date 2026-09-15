import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  Images,
  Loader2,
  Play,
  PowerOff,
  RefreshCw,
  Search,
  ShieldBan,
  Timer,
  TimerOff,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatAccountSecondaryLabel } from '@/lib/account-label'
import {
  api,
  type CooldownAccount,
  type CooldownReleaseResult,
} from '@/lib/api'
import {
  cn,
  formatDate,
  formatNumber,
  formatRelativeTime,
  getErrorMessage,
} from '@/lib/utils'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { usePaintDeferredValue } from '@/hooks/use-paint-deferred-value'
import { usePersistedViewState } from '@/hooks/use-persisted-view-state'
import { useServerTableLoading } from '@/hooks/use-server-table-loading'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
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
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { EnabledBadge } from '@/components/enabled-badge'
import { EmptyState, LoadingState, Page, PageHeader } from '@/components/page'
import { PersistedViewNotice } from '@/components/persisted-view-notice'
import { SegmentedControl } from '@/components/segmented-control'
import { SelectionToolbar } from '@/components/selection-toolbar'
import {
  ServerPagination,
  ServerTableLoadingOverlay,
} from '@/components/server-pagination'
import { TablePanel } from '@/components/table-panel'
import { AccountInspectActions } from '@/features/monitor/components/account-inspect-actions'
import { AccountRequestLedgerDialog } from '@/features/monitor/components/account-request-ledger-dialog'
import { AccountSamplesDialog } from '@/features/monitor/components/account-samples-dialog'
import { AccountUpstreamDialog } from '@/features/monitor/components/account-upstream-dialog'
import {
  formatRemainingDuration,
  isCooldownExpiringSoon,
  remainingForAccount,
} from '@/features/monitor/components/cooldown-remaining'
import {
  CooldownStatsBoard,
  COOLDOWN_STATS_VIEW_KEY,
  cooldownStatsRangeIso,
  cooldownStatsRangeLabel,
  defaultCooldownStatsView,
} from '@/features/monitor/components/cooldown-stats-board'
import { ProbeDialog } from '@/features/monitor/components/probe-dialog'
import {
  previewItemFromAccount,
  previewItemsFromAccounts,
  ResultPreviewGallery,
} from '@/features/monitor/components/result-preview-gallery'

type CooldownStatusFilter = 'cooling' | 'expired' | 'all' | 'permanent_disabled'
type CooldownSourceFilter = 'local' | 'grok2api'

const COOLDOWN_VIEW_STORAGE_KEY = 'grokiq.monitor.cooldown-view.v2'
const defaultCooldownView = {
  page: 1,
  pageSize: 50,
  search: '',
  status: 'cooling' as CooldownStatusFilter,
  source: 'local' as CooldownSourceFilter,
}

const localStatusOptions: Array<{
  value: CooldownStatusFilter
  label: string
}> = [
  { value: 'cooling', label: '冷却中' },
  { value: 'expired', label: '已结束' },
  { value: 'all', label: '全部' },
]

const grokStatusOptions: Array<{ value: CooldownStatusFilter; label: string }> =
  [
    { value: 'cooling', label: '定时停用' },
    { value: 'permanent_disabled', label: '永久停用' },
    { value: 'expired', label: '已启用' },
    { value: 'all', label: '全部' },
  ]

const localStatusLabels: Record<CooldownStatusFilter, string> = {
  cooling: '冷却中',
  expired: '已结束',
  all: '全部状态',
  permanent_disabled: '永久停用',
}

const grokStatusLabels: Record<CooldownStatusFilter, string> = {
  cooling: '定时停用',
  expired: '已启用',
  all: '全部状态',
  permanent_disabled: '永久停用',
}

const sourceLabels: Record<CooldownSourceFilter, string> = {
  local: '本系统冷却',
  grok2api: '上游同步',
}

function normalizeCooldownSource(
  value: string | undefined
): CooldownSourceFilter {
  return value === 'grok2api' ? 'grok2api' : 'local'
}

function normalizeCooldownStatus(
  value: string | undefined,
  grokSource: boolean
): CooldownStatusFilter {
  if (value === 'cooling' || value === 'expired' || value === 'all')
    return value
  if (grokSource && value === 'permanent_disabled') return value
  return 'cooling'
}

function canReleaseCooldown(account: CooldownAccount) {
  return account.status === 'cooling' && !account.quarantined
}

function grokStateLabel(account: CooldownAccount) {
  switch (account.grokState) {
    case 'timed_disabled':
      return '定时停用'
    case 'permanent_disabled':
      return '永久停用'
    case 'enabled':
      return '已启用'
    case 'deleted':
      return '已删除'
    default:
      return account.status === 'cooling' ? '定时停用' : '已启用'
  }
}

function canSelectCooldownAccount(
  account: CooldownAccount,
  grokSource: boolean
) {
  if (account.missingUpstream) return false
  return grokSource || canReleaseCooldown(account)
}

function accountLabelOf(account: CooldownAccount) {
  return account.name || account.email || `账号 ${account.id}`
}

function uniqueIds(values: Array<number | undefined | null>) {
  return Array.from(
    new Set(
      values.filter(
        (value): value is number =>
          typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      )
    )
  )
}

function releaseToastMessage(
  result: CooldownReleaseResult,
  grokSource: boolean
) {
  const skippedNotCooling = result.skippedNotCoolingAccountIds ?? []
  const skippedQuarantined = result.skippedQuarantinedAccountIds ?? []
  const skippedGeneric = result.skippedAccountIds ?? []
  const failed = result.failedAccountIds ?? []
  const specificSkipped = new Set([...skippedNotCooling, ...skippedQuarantined])
  const otherSkipped = skippedGeneric.filter((id) => !specificSkipped.has(id))
  const actionLabel = grokSource ? '解除' : '提前结束'
  const parts = [
    result.reenabled
      ? `已${actionLabel} ${result.released} 个账号的冷却，重新启用 ${result.reenabled} 个上游`
      : `已${actionLabel} ${result.released} 个账号的冷却`,
  ]
  if (failed.length)
    parts.push(
      `${failed.length} 个${grokSource ? '解除' : '结束'}失败并保留选择`
    )
  if (skippedQuarantined.length) {
    parts.push(`${skippedQuarantined.length} 个已进入隔离区并跳过`)
  }
  if (skippedNotCooling.length) {
    parts.push(`${skippedNotCooling.length} 个不在冷却中并跳过`)
  }
  if (otherSkipped.length) parts.push(`${otherSkipped.length} 个账号已跳过`)
  return {
    warning:
      failed.length > 0 ||
      skippedQuarantined.length > 0 ||
      skippedNotCooling.length > 0 ||
      otherSkipped.length > 0,
    message: parts.join('；'),
    retainedIds: uniqueIds([
      ...skippedGeneric,
      ...skippedNotCooling,
      ...skippedQuarantined,
      ...failed,
    ]),
  }
}

export function CooldownPage() {
  const client = useQueryClient()
  const navigate = useNavigate()
  const statsFetching =
    useIsFetching({ queryKey: ['accounts', 'cooldown-stats'] }) > 0
  const view = usePersistedViewState(
    COOLDOWN_VIEW_STORAGE_KEY,
    defaultCooldownView
  )
  const statsView = usePersistedViewState(
    COOLDOWN_STATS_VIEW_KEY,
    defaultCooldownStatsView
  )
  const { page, pageSize, search } = view.value
  const source = normalizeCooldownSource(view.value.source)
  const grokSource = source === 'grok2api'
  const status = normalizeCooldownStatus(view.value.status, grokSource)
  const updateView = (patch: Partial<typeof defaultCooldownView>) =>
    view.setValue((current) => ({ ...current, ...patch }))
  const statsRange = useMemo(
    () => cooldownStatsRangeIso(statsView.value),
    [statsView.value]
  )
  const statsRangeLabel = cooldownStatsRangeLabel(statsView.value)
  const historyRange =
    grokSource || status === 'cooling'
      ? {}
      : {
          from: statsRange.from || undefined,
          to: statsRange.to || undefined,
        }
  const [deferredSearch] = useDebouncedValue(search.trim())
  const committedQuery = useMemo(
    () => ({
      page,
      pageSize,
      search: deferredSearch,
      status,
      source,
      from: historyRange.from ?? '',
      to: historyRange.to ?? '',
    }),
    [
      deferredSearch,
      historyRange.from,
      historyRange.to,
      page,
      pageSize,
      source,
      status,
    ]
  )
  const tableQuery = usePaintDeferredValue(committedQuery)
  const [selected, setSelected] = useState<number[]>([])
  const [selectedDisabled, setSelectedDisabled] = useState<number[]>([])
  const [selectedReleasable, setSelectedReleasable] = useState<number[]>([])
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseIds, setReleaseIds] = useState<number[]>([])
  const [disableOpen, setDisableOpen] = useState(false)
  const [disableIds, setDisableIds] = useState<number[]>([])
  const [isolateOpen, setIsolateOpen] = useState(false)
  const [isolateIds, setIsolateIds] = useState<number[]>([])
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [upstreamAccount, setUpstreamAccount] =
    useState<CooldownAccount | null>(null)
  const [resultPreview, setResultPreview] = useState<{
    page: number
    index: number
    land?: 'start' | 'end'
    accountId?: number
  } | null>(null)
  const [sampleAccount, setSampleAccount] = useState<CooldownAccount | null>(
    null
  )
  const [ledgerAccount, setLedgerAccount] = useState<CooldownAccount | null>(
    null
  )
  const [probeOpen, setProbeOpen] = useState(false)
  const [probeAccountIds, setProbeAccountIds] = useState<number[]>([])
  const [probeDisabledCount, setProbeDisabledCount] = useState(0)
  const tableQueryPending =
    tableQuery.page !== committedQuery.page ||
    tableQuery.pageSize !== committedQuery.pageSize ||
    tableQuery.search !== committedQuery.search ||
    tableQuery.status !== committedQuery.status ||
    tableQuery.source !== committedQuery.source ||
    tableQuery.from !== committedQuery.from ||
    tableQuery.to !== committedQuery.to
  const query = useQuery({
    queryKey: [
      'accounts',
      'cooldowns',
      tableQuery.page,
      tableQuery.pageSize,
      tableQuery.search,
      tableQuery.status,
      tableQuery.source,
      tableQuery.from,
      tableQuery.to,
    ],
    queryFn: ({ signal }) =>
      api.cooldownAccounts(
        {
          page: tableQuery.page,
          pageSize: tableQuery.pageSize,
          search: tableQuery.search,
          status: tableQuery.status,
          source: tableQuery.source,
          ...(tableQuery.status === 'cooling'
            ? {}
            : {
                from: tableQuery.from || undefined,
                to: tableQuery.to || undefined,
              }),
        },
        signal
      ),
    placeholderData: (previous) => {
      if (!previous?.items.length) return previous
      const expectedSource =
        tableQuery.source === 'grok2api' ? 'grok2api' : 'request_audit'
      return previous.items[0]?.source === expectedSource ? previous : undefined
    },
    refetchInterval: (current) => {
      const items = current.state.data?.items ?? []
      return items.some((item) => item.status === 'cooling') ? 15_000 : false
    },
  })
  const accounts = useMemo(() => query.data?.items ?? [], [query.data?.items])
  const { beginTableInteraction, tableLoading: showTableLoading } =
    useServerTableLoading({
      isFetching: query.isFetching,
      inputPending: tableQueryPending,
    })
  const tableFilterKey = [
    tableQuery.search,
    tableQuery.status,
    tableQuery.source,
    tableQuery.from,
    tableQuery.to,
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
    setSelectedReleasable((current) => (current.length === 0 ? current : []))
  }, [beginTableInteraction, tableFilterKey, tableQueryPending])

  const hasCoolingRows = accounts.some((item) => item.status === 'cooling')
  useEffect(() => {
    if (!hasCoolingRows) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasCoolingRows])

  const expiredCoolingKey = accounts
    .filter((item) => {
      if (item.status !== 'cooling') return false
      const remaining = remainingForAccount(item, nowMs)
      return remaining != null && remaining <= 0
    })
    .map((item) => item.id)
    .join(',')
  const expireRefetchKeyRef = useRef('')
  useEffect(() => {
    if (!expiredCoolingKey) {
      expireRefetchKeyRef.current = ''
      return
    }
    if (expireRefetchKeyRef.current === expiredCoolingKey) return
    expireRefetchKeyRef.current = expiredCoolingKey
    void query.refetch()
    void client.invalidateQueries({ queryKey: ['accounts', 'cooldown-stats'] })
  }, [client, expiredCoolingKey, query.refetch])

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
    enabled: probeOpen,
    staleTime: 60_000,
  })

  const openAccountUpstream = useCallback((account: CooldownAccount) => {
    setUpstreamAccount(account)
  }, [])
  const openAccountSamples = useCallback((account: CooldownAccount) => {
    setSampleAccount(account)
  }, [])
  const openAccountLedger = useCallback((account: CooldownAccount) => {
    setLedgerAccount(account)
  }, [])
  const previewPage = resultPreview?.page ?? tableQuery.page
  const previewAccountsQuery = useQuery({
    queryKey: [
      'accounts',
      'cooldowns',
      'preview',
      previewPage,
      tableQuery.pageSize,
      tableQuery.search,
      tableQuery.status,
      tableQuery.source,
      tableQuery.from,
      tableQuery.to,
    ],
    queryFn: ({ signal }) =>
      api.cooldownAccounts(
        {
          page: previewPage,
          pageSize: tableQuery.pageSize,
          search: tableQuery.search,
          status: tableQuery.status,
          source: tableQuery.source,
          ...(tableQuery.status === 'cooling'
            ? {}
            : {
                from: tableQuery.from || undefined,
                to: tableQuery.to || undefined,
              }),
        },
        signal
      ),
    enabled: resultPreview != null && resultPreview.accountId == null,
  })
  const previewSource =
    resultPreview && resultPreview.page === tableQuery.page && query.data
      ? query.data
      : previewAccountsQuery.data?.page === previewPage
        ? previewAccountsQuery.data
        : undefined
  const scopedAccountId = resultPreview?.accountId
  const previewItems = useMemo(() => {
    const items = previewItemsFromAccounts(previewSource?.items ?? [])
    if (scopedAccountId == null) return items
    const matched = items.filter((item) => item.accountId === scopedAccountId)
    if (matched.length) return matched
    const account = (previewSource?.items ?? []).find(
      (item) => Number(item.id) === scopedAccountId
    )
    return account ? [previewItemFromAccount(account)] : []
  }, [previewSource?.items, scopedAccountId])
  const previewTotal =
    scopedAccountId != null
      ? previewItems.length
      : (previewSource?.total ?? query.data?.total ?? 0)
  const previewPageCount =
    scopedAccountId != null
      ? 1
      : Math.max(1, Math.ceil(previewTotal / Math.max(tableQuery.pageSize, 1)))
  const previewPageLoading =
    resultPreview != null &&
    scopedAccountId == null &&
    previewSource?.page !== resultPreview.page &&
    previewAccountsQuery.isFetching
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
  const openAccountPreview = useCallback(
    (accountId?: number, required = false) => {
      const items = previewItemsFromAccounts(accounts)
      if (!items.length && !(query.data?.total ?? 0)) {
        toast.error('当前筛选没有可预览的账号')
        return
      }
      const matchedIndex =
        accountId == null
          ? 0
          : items.findIndex((item) => item.accountId === accountId)
      if (accountId != null && matchedIndex < 0 && required) {
        setResultPreview({
          page,
          index: 0,
          accountId,
        })
        return
      }
      setResultPreview({
        page,
        index: required ? 0 : Math.max(0, matchedIndex),
        accountId: required ? accountId : undefined,
      })
    },
    [accounts, page, query.data?.total]
  )
  const openProbeDialog = useCallback(
    (account: CooldownAccount) => {
      if (account.missingUpstream) {
        toast.error('该账号缺少上游记录，无法创建探针任务')
        return
      }
      setProbeAccountIds([account.id])
      setProbeDisabledCount(account.enabled ? 0 : 1)
      setProbeOpen(true)
      void refetchEgress()
    },
    [refetchEgress]
  )

  const selectedIdSet = useMemo(() => new Set(selected), [selected])
  const selectedDisabledSet = useMemo(
    () => new Set(selectedDisabled),
    [selectedDisabled]
  )
  const selectedReleasableSet = useMemo(
    () => new Set(selectedReleasable),
    [selectedReleasable]
  )
  const selectableAccounts = accounts.filter((item) =>
    canSelectCooldownAccount(item, grokSource)
  )
  const selectableIds = selectableAccounts.map((item) => item.id)
  const releasableSelected = selected.filter((id) =>
    selectedReleasableSet.has(id)
  )
  const disableableSelected = grokSource
    ? selected.filter((id) => !selectedDisabledSet.has(id))
    : []
  const allChecked =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedIdSet.has(id))
  const hasActiveFilters = status !== 'cooling' || Boolean(search.trim())
  const statusLabels = grokSource ? grokStatusLabels : localStatusLabels
  const viewSummary = [
    sourceLabels[source],
    search.trim() ? `搜索“${search.trim()}”` : '',
    statusLabels[status],
    grokSource || status === 'cooling' ? '' : statsRangeLabel,
    `第 ${page} 页 · 每页 ${pageSize} 条`,
  ]
    .filter(Boolean)
    .join(' · ')

  const clearSelection = () => {
    setSelected([])
    setSelectedDisabled([])
    setSelectedReleasable([])
  }

  const syncSelection = (accountIds: number[]) => {
    const allowed = new Set(accountIds)
    setSelected((current) => current.filter((id) => allowed.has(id)))
    setSelectedDisabled((current) => current.filter((id) => allowed.has(id)))
    setSelectedReleasable((current) => current.filter((id) => allowed.has(id)))
  }

  const releaseMutation = useMutation({
    mutationFn: (accountIds: number[]) =>
      api.releaseCooldowns(accountIds, source),
    onSuccess: (result) => {
      const toastResult = releaseToastMessage(result, grokSource)
      setReleaseOpen(false)
      setReleaseIds([])
      syncSelection(toastResult.retainedIds)
      if (toastResult.warning) toast.warning(toastResult.message)
      else toast.success(toastResult.message)
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['accounts'] })
      void client.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
  const releasePending = releaseMutation.isPending

  const openRelease = (accountIds: number[]) => {
    const ids = uniqueIds(accountIds)
    if (ids.length === 0) return
    setReleaseIds(ids)
    setReleaseOpen(true)
  }

  const disableMutation = useMutation({
    mutationFn: (accountIds: number[]) =>
      api.updateAccountsEnabled(accountIds, false),
    onSuccess: (result) => {
      const skippedAccountIds = result.skippedAccountIds ?? []
      const failedAccountIds = result.failedAccountIds ?? []
      const retainedAccountIds = uniqueIds([
        ...skippedAccountIds,
        ...failedAccountIds,
      ])
      setDisableOpen(false)
      setDisableIds([])
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
  const disablePending = disableMutation.isPending

  const openDisable = (accountIds: number[]) => {
    const ids = uniqueIds(accountIds)
    if (ids.length === 0) return
    setDisableIds(ids)
    setDisableOpen(true)
  }

  const isolateMutation = useMutation({
    mutationFn: (accountIds: number[]) =>
      api.accountBatchAction({
        account_ids: accountIds,
        action: 'isolate',
        note: '冷却区人工移入隔离区',
        propagate: true,
      }),
    onSuccess: (result) => {
      const skippedAccountIds = result.skippedAccountIds ?? []
      const failedAccountIds = result.failedAccountIds ?? []
      const alreadyIsolatedIds = result.alreadyIsolatedAccountIds ?? []
      const retainedAccountIds = uniqueIds([
        ...skippedAccountIds,
        ...failedAccountIds,
      ])
      setIsolateOpen(false)
      setIsolateIds([])
      syncSelection(retainedAccountIds)
      if (
        failedAccountIds.length > 0 ||
        skippedAccountIds.length > 0 ||
        alreadyIsolatedIds.length > 0
      ) {
        const details = [`已移入隔离区 ${result.updated} 个账号`]
        if (failedAccountIds.length) {
          details.push(`${failedAccountIds.length} 个操作失败并保留选择`)
        }
        if (skippedAccountIds.length) {
          details.push(`${skippedAccountIds.length} 个设置受任务保护并跳过`)
        }
        if (alreadyIsolatedIds.length) {
          details.push(`${alreadyIsolatedIds.length} 个原本已在隔离区`)
        }
        toast.warning(details.join('；'))
      } else {
        toast.success(`已移入隔离区 ${result.updated} 个账号`)
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['accounts'] })
      void client.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
  const isolatePending = isolateMutation.isPending
  const selectionActionPending =
    releasePending || disablePending || isolatePending

  const openIsolate = (accountIds: number[]) => {
    const ids = uniqueIds(accountIds)
    if (ids.length === 0) return
    setIsolateIds(ids)
    setIsolateOpen(true)
  }

  const openSelectedProbe = () => {
    const accountIds = uniqueIds(selected)
    if (accountIds.length === 0) {
      toast.error('没有可创建探针的账号')
      return
    }
    setProbeAccountIds(accountIds)
    setProbeDisabledCount(
      accountIds.filter((id) => selectedDisabledSet.has(id)).length
    )
    setProbeOpen(true)
    void refetchEgress()
  }

  const toggleCurrentPageSelection = (checked: boolean) => {
    const pageDisabledIds = selectableAccounts
      .filter((item) => !item.enabled)
      .map((item) => item.id)
    const pageReleasableIds = selectableAccounts
      .filter(canReleaseCooldown)
      .map((item) => item.id)
    setSelected((current) => {
      const next = new Set(current)
      for (const id of selectableIds) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return Array.from(next)
    })
    setSelectedDisabled((current) => {
      const next = new Set(current)
      if (checked) {
        for (const id of pageDisabledIds) next.add(id)
      } else {
        for (const id of selectableIds) next.delete(id)
      }
      return Array.from(next)
    })
    setSelectedReleasable((current) => {
      const next = new Set(current)
      if (checked) {
        for (const id of pageReleasableIds) next.add(id)
      } else {
        for (const id of selectableIds) next.delete(id)
      }
      return Array.from(next)
    })
  }

  const toggleAccountSelection = (id: number, checked: boolean) => {
    const account = accounts.find((item) => item.id === id)
    const disabled = Boolean(account && !account.enabled)
    const releasable = Boolean(account && canReleaseCooldown(account))
    setSelected((current) => {
      if (checked) {
        return current.includes(id) ? current : [...current, id]
      }
      return current.filter((item) => item !== id)
    })
    setSelectedDisabled((current) => {
      if (checked && disabled) {
        return current.includes(id) ? current : [...current, id]
      }
      return current.filter((item) => item !== id)
    })
    setSelectedReleasable((current) => {
      if (checked && releasable) {
        return current.includes(id) ? current : [...current, id]
      }
      return current.filter((item) => item !== id)
    })
  }

  return (
    <Page>
      <PageHeader
        title='冷却区'
        description={
          <div className='space-y-2'>
            <p>
              {grokSource
                ? '上游同步实时读取 grok2api 缺思考记录。定时停用到期后由 grok2api 自动恢复；永久停用需手动启用。解除冷却会立即启用上游账号。停用全部只改上游启用，不会移入隔离区。'
                : '本系统冷却来自请求审计高速 TPS。连续达到次数后会先临时停用账号，到期自动恢复，不会进入隔离区。冷却结束后如果再次连续高速 TPS，才会永久停用并移入隔离区。'}
            </p>
          </div>
        }
        hintContentClassName='max-w-[28rem]'
        descriptionAsHint
        actions={
          <ActionToolbar label='冷却区操作'>
            <ToolbarAction
              label='刷新冷却页'
              pending={query.isFetching || statsFetching}
              onClick={() => {
                void query.refetch()
                void client.invalidateQueries({
                  queryKey: ['accounts', 'cooldown-stats'],
                })
              }}
            >
              <RefreshCw />
            </ToolbarAction>
            <SelectionToolbar
              wrap={false}
              selectedCount={selected.length}
              entityLabel='账号'
              disabled={selectionActionPending}
              onClear={clearSelection}
            >
              <ToolbarAction
                label={`测试已选 ${selected.length} 个账号`}
                disabled={selectionActionPending || selected.length === 0}
                onClick={openSelectedProbe}
              >
                <Play />
              </ToolbarAction>
              <ToolbarAction
                label={
                  grokSource
                    ? releasableSelected.length
                      ? `解除已选 ${releasableSelected.length} 个账号的冷却`
                      : '已选账号不在冷却中，无法解除冷却'
                    : releasableSelected.length
                      ? `提前结束已选 ${releasableSelected.length} 个账号的冷却`
                      : '已选账号不在冷却中，无法提前结束'
                }
                pending={releasePending}
                disabled={
                  selectionActionPending || releasableSelected.length === 0
                }
                onClick={() => openRelease(releasableSelected)}
              >
                <TimerOff />
              </ToolbarAction>
              {grokSource ? (
                <ToolbarAction
                  label={
                    disableableSelected.length
                      ? `停用全部（${disableableSelected.length} 个启用账号）`
                      : '已选账号均处于停用状态或缺少上游'
                  }
                  destructive
                  pending={disablePending}
                  disabled={
                    selectionActionPending || disableableSelected.length === 0
                  }
                  onClick={() => openDisable(disableableSelected)}
                >
                  <PowerOff />
                </ToolbarAction>
              ) : null}
              <ToolbarAction
                label={`将已选 ${selected.length} 个账号移入隔离区`}
                pending={isolatePending}
                disabled={selectionActionPending || selected.length === 0}
                onClick={() => openIsolate(selected)}
              >
                <ShieldBan />
              </ToolbarAction>
            </SelectionToolbar>
          </ActionToolbar>
        }
      />
      <Tabs
        value={source}
        onValueChange={(value) => {
          const next = normalizeCooldownSource(value)
          if (next === source) return
          beginTableInteraction()
          clearSelection()
          setReleaseOpen(false)
          setReleaseIds([])
          setDisableOpen(false)
          setDisableIds([])
          setIsolateOpen(false)
          setIsolateIds([])
          setResultPreview(null)
          updateView({
            source: next,
            page: 1,
            ...(next === 'local' && status === 'permanent_disabled'
              ? { status: 'cooling' }
              : {}),
          })
        }}
        className='gap-3'
      >
        <TabsList className='h-8 w-full justify-start overflow-x-auto sm:w-fit'>
          <TabsTrigger value='local'>本系统冷却</TabsTrigger>
          <TabsTrigger value='grok2api'>上游同步</TabsTrigger>
        </TabsList>
      </Tabs>
      <CooldownStatsBoard
        source={source}
        view={statsView.value}
        onViewChange={(next) => {
          statsView.setValue(next)
          updateView({ page: 1 })
        }}
      />
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
                  openAccountPreview()
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
              <SegmentedControl
                ariaLabel='冷却状态'
                value={status}
                onChange={(next) => updateView({ status: next, page: 1 })}
                options={grokSource ? grokStatusOptions : localStatusOptions}
              />
              <div className='relative min-w-0 flex-1'>
                <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                <Input
                  value={search}
                  onChange={(event) =>
                    updateView({ search: event.target.value, page: 1 })
                  }
                  placeholder={
                    grokSource
                      ? '搜索名称、账号 ID'
                      : '搜索名称、邮箱、账号 ID、请求 ID'
                  }
                  className='h-8 pr-8 pl-8'
                />
                {showTableLoading && (
                  <Loader2 className='absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-primary' />
                )}
              </div>
            </div>
            {!grokSource && status !== 'cooling' ? (
              <p className='text-[11px] text-muted-foreground'>
                已结束记录按看板时间范围筛选：{statsRangeLabel}
              </p>
            ) : null}
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
            icon={Timer}
            title='无法加载冷却账号'
            description={getErrorMessage(query.error)}
          />
        ) : accounts.length ? (
          <div className='relative min-h-40' aria-busy={showTableLoading}>
            <CooldownTable
              grokSource={grokSource}
              accounts={accounts}
              selected={selected}
              allChecked={allChecked}
              selectDisabled={selectableIds.length === 0}
              nowMs={nowMs}
              actionPending={selectionActionPending}
              onToggleCurrentPage={toggleCurrentPageSelection}
              onToggleAccount={toggleAccountSelection}
              onRelease={(account) => openRelease([account.id])}
              onOpenUpstream={openAccountUpstream}
              onPreview={(account) => openAccountPreview(account.id, true)}
              onProbe={openProbeDialog}
              onOpenSamples={openAccountSamples}
              onOpenLedger={openAccountLedger}
            />
            {showTableLoading && (
              <ServerTableLoadingOverlay
                page={page}
                itemLabel='账号'
                message='正在更新冷却筛选结果…'
              />
            )}
          </div>
        ) : (
          <div className='relative min-h-48' aria-busy={showTableLoading}>
            <EmptyState
              icon={Timer}
              title={
                hasActiveFilters
                  ? '没有匹配的冷却记录'
                  : grokSource
                    ? '当前没有定时停用的账号'
                    : '当前没有冷却中的账号'
              }
              description={
                grokSource
                  ? status === 'expired'
                    ? '当前没有已重新启用的缺思考账号。'
                    : status === 'permanent_disabled'
                      ? '当前没有永久停用的缺思考账号。'
                      : status === 'all'
                        ? '当前没有 grok2api 缺思考记录。'
                        : hasActiveFilters
                          ? '没有匹配当前筛选的缺思考记录，请调整条件后重试。'
                          : '实时读取 grok2api 缺思考记录。当前没有定时停用的账号。'
                  : status === 'expired'
                    ? `看板时间范围「${statsRangeLabel}」内没有已结束的冷却记录，请扩大时间范围后重试。`
                    : status === 'all'
                      ? `看板时间范围「${statsRangeLabel}」内没有冷却记录，请扩大时间范围或改回「冷却中」。`
                      : hasActiveFilters
                        ? '没有匹配当前筛选的冷却记录，请调整条件后重试。'
                        : '高速 TPS 连续达标后会先在这里停用几分钟，到期自动恢复。已结束的记录请切换到「已结束」，并确认上方看板时间范围覆盖冷却发生的时间。'
              }
              action={
                hasActiveFilters ? undefined : (
                  <Button
                    variant='outline'
                    onClick={() => updateView({ status: 'expired', page: 1 })}
                  >
                    {grokSource ? '查看已启用' : '查看已结束'}
                  </Button>
                )
              }
            />
            {showTableLoading && (
              <ServerTableLoadingOverlay
                page={page}
                itemLabel='账号'
                message='正在更新冷却筛选结果…'
              />
            )}
          </div>
        )}
      </TablePanel>
      <ConfirmDialog
        open={releaseOpen}
        onOpenChange={(open) => {
          if (!open && !releasePending) {
            setReleaseOpen(false)
            setReleaseIds([])
          }
        }}
        title={
          grokSource
            ? `解除 ${releaseIds.length} 个账号的冷却？`
            : `提前结束 ${releaseIds.length} 个账号的冷却？`
        }
        desc={
          <div className='space-y-2'>
            <p>
              {grokSource
                ? `将通过 grok2api 立即启用所选 ${releaseIds.length} 个账号，解除缺思考停用。已进入隔离区、已启用或已删除的账号会跳过。`
                : `将提前结束 ${releaseIds.length} 个账号的冷却并恢复调度。若冷却期间是本系统停用的上游，会重新启用。已进入隔离区的账号会跳过。`}
            </p>
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          releasePending ? (
            <>
              <Loader2 className='animate-spin' />
              {grokSource ? '解除中…' : '结束中…'}
            </>
          ) : (
            <>
              <TimerOff />
              {grokSource ? '确认解除冷却' : '确认提前结束'}
            </>
          )
        }
        isLoading={releasePending}
        disabled={releaseIds.length === 0}
        handleConfirm={() => {
          if (releaseIds.length === 0) return
          releaseMutation.mutate(releaseIds)
        }}
      />
      <ConfirmDialog
        open={disableOpen}
        onOpenChange={(open) => {
          if (!open && !disablePending) {
            setDisableOpen(false)
            setDisableIds([])
          }
        }}
        title={`停用 ${disableIds.length} 个账号的上游？`}
        desc={
          <div className='space-y-2'>
            <p>
              {`将通过 grok2api 停用当前选择中的 ${disableIds.length} 个启用账号。停用后这些账号不再参与上游正常调度。`}
            </p>
            {selected.length > disableIds.length ? (
              <p className='text-muted-foreground'>
                另外 {selected.length - disableIds.length}{' '}
                个已停用或缺少上游的账号会自动跳过。
              </p>
            ) : null}
            <p className='text-muted-foreground'>
              这只改上游启用状态，不会解除冷却，也不会移入隔离区。
            </p>
            <p className='font-medium text-foreground'>
              这是人工长期停用，不使用系统设置中的“停用时长”，也不会被隔离恢复任务自动启用。
            </p>
            <p className='text-muted-foreground'>
              正在执行探针或等待账号设置恢复的账号会被跳过并保留选择，避免任务结束时的设置恢复覆盖本次停用。
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
        disabled={disableIds.length === 0}
        handleConfirm={() => {
          if (disableIds.length === 0) return
          disableMutation.mutate(disableIds)
        }}
      />
      <ConfirmDialog
        open={isolateOpen}
        onOpenChange={(open) => {
          if (!open && !isolatePending) {
            setIsolateOpen(false)
            setIsolateIds([])
          }
        }}
        title={`将 ${isolateIds.length} 个账号移入隔离区？`}
        desc={
          <div className='space-y-2'>
            <p>
              {`将停用已选 ${isolateIds.length} 个账号的上游，并把它们移入隔离区，不会删除账号。`}
            </p>
            <p className='font-medium text-foreground'>
              隔离区是长期隔离（不自动到期恢复）并停用上游；暂时停用仍走原来的停用时长逻辑。
            </p>
            <p className='text-muted-foreground'>
              正在执行探针或等待账号设置恢复的账号会被跳过并保留选择。
            </p>
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          isolatePending ? (
            <>
              <Loader2 className='animate-spin' />
              移入中…
            </>
          ) : (
            <>
              <ShieldBan />
              确认移入隔离区
            </>
          )
        }
        isLoading={isolatePending}
        disabled={isolateIds.length === 0}
        handleConfirm={() => {
          if (isolateIds.length === 0) return
          isolateMutation.mutate(isolateIds)
        }}
      />
      <AccountUpstreamDialog
        open={upstreamAccount != null}
        accountId={upstreamAccount?.id ?? null}
        account={upstreamAccount}
        onOpenChange={(open) => {
          if (!open) setUpstreamAccount(null)
        }}
      />
      <AccountSamplesDialog
        open={sampleAccount != null}
        accountId={sampleAccount?.id ?? null}
        account={sampleAccount}
        onOpenChange={(open) => {
          if (!open) setSampleAccount(null)
        }}
      />
      <AccountRequestLedgerDialog
        key={ledgerAccount ? ledgerAccount.id : 'closed'}
        open={ledgerAccount != null}
        account={ledgerAccount}
        onOpenChange={(open) => {
          if (!open) setLedgerAccount(null)
        }}
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
        page={scopedAccountId != null ? 1 : (resultPreview?.page ?? page)}
        pageCount={previewPageCount}
        total={previewTotal}
        pageLoading={previewPageLoading}
        onPageChange={
          scopedAccountId == null
            ? (nextPage, land) =>
                setResultPreview((current) =>
                  current
                    ? {
                        ...current,
                        page: nextPage,
                        land,
                        index: 0,
                        accountId: undefined,
                      }
                    : current
                )
            : undefined
        }
        perspective='account'
        onOpenQuarantine={() => {
          void navigate({ to: '/quarantine' } as never)
        }}
      />
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

function CooldownTable({
  grokSource = false,
  accounts,
  selected,
  allChecked,
  selectDisabled,
  nowMs,
  actionPending,
  onToggleCurrentPage,
  onToggleAccount,
  onRelease,
  onOpenUpstream,
  onPreview,
  onProbe,
  onOpenSamples,
  onOpenLedger,
}: {
  grokSource?: boolean
  accounts: CooldownAccount[]
  selected: number[]
  allChecked: boolean
  selectDisabled: boolean
  nowMs: number
  actionPending: boolean
  onToggleCurrentPage: (checked: boolean) => void
  onToggleAccount: (id: number, checked: boolean) => void
  onRelease: (account: CooldownAccount) => void
  onOpenUpstream: (account: CooldownAccount) => void
  onPreview: (account: CooldownAccount) => void
  onProbe: (account: CooldownAccount) => void
  onOpenSamples: (account: CooldownAccount) => void
  onOpenLedger: (account: CooldownAccount) => void
}) {
  const selectedIdSet = useMemo(() => new Set(selected), [selected])
  return (
    <Table
      rememberRowKey='monitor-cooldown'
      className='[&_td]:py-1.5 [&_th]:h-8'
    >
      <TableHeader>
        <TableRow>
          <TableHead className='w-10'>
            <Checkbox
              checked={allChecked}
              disabled={selectDisabled}
              onCheckedChange={(value) => onToggleCurrentPage(value === true)}
              aria-label={
                grokSource ? '选择当前页账号' : '选择当前页可提前结束的冷却账号'
              }
            />
          </TableHead>
          <TableHead>账号</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>原因</TableHead>
          {grokSource ? (
            <TableHead>次数</TableHead>
          ) : (
            <>
              <TableHead>连续次数</TableHead>
              <TableHead>峰值 TPS</TableHead>
            </>
          )}
          <TableHead>开始时间</TableHead>
          <TableHead>结束时间</TableHead>
          <TableHead>剩余</TableHead>
          <TableHead>上游启用</TableHead>
          <TableHead className='text-right'>操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => (
          <CooldownRow
            key={account.id}
            grokSource={grokSource}
            account={account}
            selected={selectedIdSet.has(account.id)}
            nowMs={nowMs}
            actionPending={actionPending}
            onSelectedChange={(checked) => onToggleAccount(account.id, checked)}
            onRelease={() => onRelease(account)}
            onOpenUpstream={() => onOpenUpstream(account)}
            onPreview={() => onPreview(account)}
            onProbe={() => onProbe(account)}
            onOpenSamples={() => onOpenSamples(account)}
            onOpenLedger={() => onOpenLedger(account)}
          />
        ))}
      </TableBody>
    </Table>
  )
}

function CooldownRow({
  grokSource = false,
  account,
  selected,
  nowMs,
  actionPending,
  onSelectedChange,
  onRelease,
  onOpenUpstream,
  onPreview,
  onProbe,
  onOpenSamples,
  onOpenLedger,
}: {
  grokSource?: boolean
  account: CooldownAccount
  selected: boolean
  nowMs: number
  actionPending: boolean
  onSelectedChange: (checked: boolean) => void
  onRelease: () => void
  onOpenUpstream: () => void
  onPreview: () => void
  onProbe: () => void
  onOpenSamples: () => void
  onOpenLedger: () => void
}) {
  const accountLabel = accountLabelOf(account)
  const secondaryAccountLabel = formatAccountSecondaryLabel({
    id: account.id,
    email: account.email,
    accountLabel,
  })
  const remaining = remainingForAccount(account, nowMs)
  const expiringSoon =
    account.status === 'cooling' && isCooldownExpiringSoon(remaining)
  const canRelease = canReleaseCooldown(account)
  const canSelect = canSelectCooldownAccount(account, grokSource)
  const reason = account.reason?.trim() || account.label?.trim() || '—'
  const peakTps = account.maxTps ?? account.auditTps
  const endedAt = account.cooldownUntil || account.expiredAt
  return (
    <TableRow rowId={account.id}>
      <TableCell>
        <Checkbox
          checked={selected}
          disabled={!canSelect}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={`选择账号 ${accountLabel}`}
        />
      </TableCell>
      <TableCell>
        <div className='flex items-start gap-1'>
          <div className='min-w-0'>
            <div className='flex flex-wrap items-center gap-1.5'>
              <div className='font-medium'>{accountLabel}</div>
              {account.quarantined ? (
                <Badge variant='destructive' className='h-5 px-1.5 text-[10px]'>
                  已进入隔离区
                </Badge>
              ) : null}
              {expiringSoon ? (
                <Badge variant='warning' className='h-5 px-1.5 text-[10px]'>
                  即将结束
                </Badge>
              ) : null}
              {grokSource && account.restorePending ? (
                <Badge variant='warning' className='h-5 px-1.5 text-[10px]'>
                  即将恢复
                </Badge>
              ) : null}
              {!grokSource &&
              !account.quarantined &&
              account.status === 'expired' &&
              account.nextAction === 'isolate' ? (
                <Badge variant='outline' className='h-5 px-1.5 text-[10px]'>
                  下次将停用
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
            value={account.email?.trim() || String(account.id)}
            className='size-6'
          />
        </div>
      </TableCell>
      <TableCell>
        <Badge
          variant={
            account.grokState === 'deleted'
              ? 'outline'
              : account.status === 'cooling'
                ? 'warning'
                : 'secondary'
          }
          className='h-5 px-1.5 text-[11px]'
        >
          {grokSource
            ? grokStateLabel(account)
            : account.status === 'cooling'
              ? '冷却中'
              : '已结束'}
        </Badge>
      </TableCell>
      <TableCell>
        <div className='max-w-64 text-sm' title={reason}>
          {reason}
        </div>
      </TableCell>
      {grokSource ? (
        <TableCell className='tabular-nums'>
          {formatNumber(account.cooldownCount ?? 0, 0)}
        </TableCell>
      ) : (
        <>
          <TableCell className='tabular-nums'>
            {account.tpsStreak != null || account.tpsMinCount != null
              ? `${formatNumber(account.tpsStreak ?? 0, 0)} / ${formatNumber(account.tpsMinCount ?? 0, 0)}`
              : '—'}
          </TableCell>
          <TableCell className='tabular-nums'>
            {peakTps == null ? '—' : formatNumber(peakTps)}
          </TableCell>
        </>
      )}
      <TableCell>
        <TimeCell value={account.cooledAt} />
      </TableCell>
      <TableCell>
        <TimeCell value={endedAt} />
      </TableCell>
      <TableCell>
        {account.grokState === 'permanent_disabled' ? (
          <span className='text-muted-foreground'>永久</span>
        ) : account.status === 'expired' ? (
          <span className='text-muted-foreground'>
            {grokSource ? '已启用' : '已结束'}
          </span>
        ) : (
          <span
            className={cn(
              'tabular-nums',
              expiringSoon && 'text-amber-700 dark:text-amber-300'
            )}
          >
            {formatRemainingDuration(remaining)}
          </span>
        )}
      </TableCell>
      <TableCell>
        {account.missingUpstream ? (
          <Badge variant='outline'>上游缺失</Badge>
        ) : (
          <EnabledBadge enabled={account.enabled} prefix='上游' />
        )}
      </TableCell>
      <TableCell className='w-40 text-right'>
        <AccountInspectActions
          accountLabel={accountLabel}
          missingUpstream={Boolean(account.missingUpstream)}
          extra={
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size='icon'
                  variant='ghost'
                  disabled={!canRelease || actionPending}
                  onClick={onRelease}
                  aria-label={
                    grokSource
                      ? `解除 ${accountLabel} 的冷却`
                      : `提前结束 ${accountLabel} 的冷却`
                  }
                >
                  <TimerOff />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {account.quarantined
                  ? grokSource
                    ? '已进入隔离区，无法解除冷却'
                    : '已进入隔离区，无法提前结束冷却'
                  : account.status === 'expired'
                    ? '冷却已结束'
                    : grokSource
                      ? '解除冷却'
                      : '提前结束冷却'}
              </TooltipContent>
            </Tooltip>
          }
          onOpenUpstream={onOpenUpstream}
          onPreview={onPreview}
          onProbe={onProbe}
          onOpenSamples={onOpenSamples}
          onOpenLedger={onOpenLedger}
        />
      </TableCell>
    </TableRow>
  )
}

function TimeCell({ value }: { value?: string | null }) {
  if (!value) {
    return <span className='text-muted-foreground'>—</span>
  }
  return (
    <div className='min-w-32'>
      <div className='whitespace-nowrap tabular-nums'>{formatDate(value)}</div>
      <div className='text-xs text-muted-foreground'>
        {formatRelativeTime(value)}
      </div>
    </div>
  )
}
