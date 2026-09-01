import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  ExternalLink,
  LayoutGrid,
  LayoutList,
  Loader2,
  ShieldBan,
  UsersRound,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatAccountCreatedAt } from '@/lib/account-label'
import {
  api,
  type ProbeRun,
  type ProbeRunPreviewSample,
  type ProbeSample,
  type UpstreamAccount,
} from '@/lib/api'
import { buildHtmlDocument, extractHtmlPreviews } from '@/lib/formatted-content'
import {
  HTML_THUMB_FRAME_HEIGHT,
  HTML_THUMB_FRAME_WIDTH,
  useHtmlThumbSlot,
} from '@/lib/html-preview-frame'
import {
  ACCOUNT_PREVIEW_SAMPLE_LIMIT,
  RUN_PREVIEW_GC_TIME,
  slimAccountPreview,
  slimRunPreview,
} from '@/lib/preview-payload'
import { StatusBadge } from '@/lib/status'
import { cn, formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { usePersistedViewState } from '@/hooks/use-persisted-view-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { EnabledBadge } from '@/components/enabled-badge'
import { ContentPreviewCanvas } from '@/components/formatted-content'
import { InfoTooltip } from '@/components/info-tooltip'
import { MonitorStatusBadge } from '@/components/monitor-status-badge'
import { buildEgressNodeNameMap } from '@/features/monitor/components/egress-node-names'
import { ProbeRunDetailDialog } from '@/features/monitor/components/probe-run-detail-dialog'
import { DualTpsValue } from '@/features/monitor/components/tps-display'

const AccountProbeDetailDialog = lazy(() =>
  import('@/features/monitor/components/account-probe-detail-dialog').then(
    (module) => ({ default: module.AccountProbeDetailDialog })
  )
)

const PREVIEW_ISOLATE_NOTE = 'HTML 预览人工判定降智'
const THUMB_FRAME_WIDTH = HTML_THUMB_FRAME_WIDTH
const THUMB_FRAME_HEIGHT = HTML_THUMB_FRAME_HEIGHT
const THUMB_GRID_CLASSNAME =
  'grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5'
const PREVIEW_VIEW_STORAGE_KEY = 'grokiq.monitor.result-preview.v1'
const defaultPreviewView: {
  view: 'split' | 'grid'
  groupMode: 'task' | 'account'
  roundLayout: 'aggregate' | 'expand'
} = {
  view: 'split',
  groupMode: 'task',
  roundLayout: 'aggregate',
}

export type ResultPreviewItem = {
  id: string
  runId: string
  accountId: number
  accountName: string
  accountEmail?: string
  accountCreatedAt?: string | null
  createdAt?: string | null
  sampleId?: string
  profileId?: string
  profileName?: string
  expectedOutput?: string
  expectedImageUrl?: string
  content?: string
  sample?: ProbeSample
  rounds?: number
  completedSteps?: number
  heading?: string
  source?: 'run' | 'account'
  roundNumber?: number
}

export function previewItemsFromRuns(
  runs: ProbeRun[],
  profileNames: Record<string, string> = {}
): ResultPreviewItem[] {
  return runs
    .filter((run) => run.completed_steps > 0)
    .map((run) => ({
      id: run.id,
      runId: run.id,
      accountId: run.account_id,
      accountName:
        run.account_name || run.account_email || `账号 ${run.account_id}`,
      accountEmail: run.account_email,
      accountCreatedAt: run.account_created_at,
      createdAt: run.created_at,
      profileId: run.profile_id,
      profileName: profileNames[run.profile_id],
      rounds: run.rounds,
      completedSteps: run.completed_steps,
    }))
}

export function previewItemsFromSamples(
  samples: ProbeSample[],
  account: {
    id: number | string
    name?: string
    email?: string
    createdAt?: string | null
  }
): ResultPreviewItem[] {
  const accountId = Number(account.id)
  const accountName = account.name || account.email || `账号 ${account.id}`
  return samples
    .filter((sample) => (sample.response_text || '').trim())
    .map((sample) => ({
      id: sample.id,
      runId: sample.run_id,
      accountId: sample.account_id || accountId,
      accountName,
      accountEmail: account.email,
      accountCreatedAt: account.createdAt,
      createdAt: sample.created_at,
      sampleId: sample.id,
      content: sample.response_text,
      sample,
    }))
}

export function previewItemsFromAccounts(
  accounts: UpstreamAccount[]
): ResultPreviewItem[] {
  return accounts
    .filter((account) => (account.assessment.sample_count ?? 0) > 0)
    .map((account) => {
      const accountId = Number(account.id)
      return {
        id: String(accountId),
        runId: '',
        accountId,
        accountName: account.name || account.email || `账号 ${accountId}`,
        accountEmail: account.email,
        accountCreatedAt: account.createdAt,
        createdAt: account.assessment.latest_sample_at,
        rounds: account.assessment.sample_count,
        completedSteps: Math.min(
          account.assessment.sample_count ?? 0,
          ACCOUNT_PREVIEW_SAMPLE_LIMIT
        ),
        source: 'account' as const,
      }
    })
}

function samplesForPreview(samples: ProbeSample[]) {
  return samples.filter((sample) => (sample.response_text || '').trim())
}

function expandPreviewItems(
  items: ResultPreviewItem[],
  samples: ProbeRunPreviewSample[] | undefined,
  variant: 'task' | 'account'
) {
  const byRun = new Map<string, ProbeRunPreviewSample[]>()
  if (samples) {
    for (const sample of samples) {
      const list = byRun.get(sample.run_id) ?? []
      list.push(sample)
      byRun.set(sample.run_id, list)
    }
  }
  const leaves: ResultPreviewItem[] = []
  for (const item of items) {
    const rounds = samples
      ? (byRun.get(item.runId) ?? [])
      : placeholderPreviewRounds(item)
    if (!rounds.length) {
      leaves.push(item)
      continue
    }
    for (const sample of rounds) {
      const sameRoundCount = rounds.filter(
        (candidate) => candidate.round_number === sample.round_number
      ).length
      const roundLabel =
        sameRoundCount > 1 && sample.egress_name
          ? `第 ${sample.round_number || 1} 轮 · ${sample.egress_name}`
          : `第 ${sample.round_number || 1} 轮`
      const sampleLabel =
        item.source === 'account'
          ? `样本 ${sample.round_number || 1}`
          : roundLabel
      const heading =
        variant === 'task'
          ? rounds.length > 1
            ? `${item.accountName} · ${sampleLabel}`
            : item.accountName
          : item.profileName
            ? rounds.length > 1
              ? `${item.profileName} · ${roundLabel}`
              : item.profileName
            : sampleLabel
      leaves.push({
        ...item,
        id: `${item.id}:${sample.id}`,
        sampleId: sample.id.startsWith('pending:') ? undefined : sample.id,
        roundNumber: sample.round_number || undefined,
        createdAt: sample.created_at || item.createdAt,
        heading,
        completedSteps: 1,
      })
    }
  }
  return leaves
}

function placeholderPreviewRounds(
  item: ResultPreviewItem
): ProbeRunPreviewSample[] {
  const count = Math.max(1, item.completedSteps || 1)
  return Array.from({ length: count }, (_, offset) => ({
    id: `pending:${offset + 1}`,
    run_id: item.runId,
    round_number: offset + 1,
    egress_name: '',
    classification: '',
    created_at: item.createdAt || '',
  }))
}

export function pickPreviewSample(
  samples: ProbeSample[],
  preferredId?: string
): ProbeSample | null {
  if (preferredId) {
    const matched = samples.find((sample) => sample.id === preferredId)
    if (matched) return matched
  }
  const withText = samplesForPreview(samples)
  const newestFirst = [...withText].sort((left, right) => {
    const delta = Date.parse(right.created_at) - Date.parse(left.created_at)
    if (Number.isFinite(delta) && delta !== 0) return delta
    return right.id.localeCompare(left.id)
  })
  const withHtml = newestFirst.find(
    (sample) => extractHtmlPreviews(sample.response_text).length > 0
  )
  return withHtml || newestFirst[0] || samples[0] || null
}

function isAccountPreviewItem(item?: ResultPreviewItem | null) {
  return item?.source === 'account'
}

function parentPreviewIndex(
  items: ResultPreviewItem[],
  leaf: ResultPreviewItem
) {
  if (isAccountPreviewItem(leaf)) {
    return items.findIndex((entry) => entry.accountId === leaf.accountId)
  }
  return items.findIndex((entry) => entry.runId === leaf.runId)
}

function orderedPreviewSamples(samples: ProbeSample[]) {
  return [...samplesForPreview(samples)].sort((left, right) => {
    const delta = Date.parse(right.created_at) - Date.parse(left.created_at)
    if (Number.isFinite(delta) && delta !== 0) return delta
    return right.id.localeCompare(left.id)
  })
}

function resolvePreviewSample(
  samples: ProbeSample[],
  item?: ResultPreviewItem | null,
  overrideId?: string
) {
  if (item?.sample) return item.sample
  const preferredId = overrideId || item?.sampleId
  if (preferredId) {
    const matched = samples.find((sample) => sample.id === preferredId)
    if (matched) return matched
  }
  if (isAccountPreviewItem(item) && item?.roundNumber && item.roundNumber > 0) {
    return (
      orderedPreviewSamples(samples)[item.roundNumber - 1] ||
      pickPreviewSample(samples)
    )
  }
  return pickPreviewSample(samples, preferredId)
}

export function ResultPreviewGallery({
  open,
  onOpenChange,
  items,
  index,
  onIndexChange,
  onOpenQuarantine,
  page = 1,
  pageCount = 1,
  total,
  pageLoading = false,
  onPageChange,
  perspective = 'task',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: ResultPreviewItem[]
  index: number
  onIndexChange: (index: number) => void
  onOpenQuarantine?: () => void
  page?: number
  pageCount?: number
  total?: number
  pageLoading?: boolean
  onPageChange?: (page: number, land: 'start' | 'end') => void
  perspective?: 'task' | 'account'
}) {
  const client = useQueryClient()
  const listRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const pagerRef = useRef<HTMLDivElement>(null)
  const skipPageCommitRef = useRef(false)
  const [isolateOpen, setIsolateOpen] = useState(false)
  const [compareExpected, setCompareExpected] = useState(false)
  const previewPrefs = usePersistedViewState(
    PREVIEW_VIEW_STORAGE_KEY,
    defaultPreviewView
  )
  const [sessionView, setSessionView] = useState<'split' | 'grid'>()
  const view =
    sessionView ?? (previewPrefs.value.view === 'grid' ? 'grid' : 'split')
  const groupMode =
    previewPrefs.value.groupMode === 'account' ? 'account' : 'task'
  const roundLayout =
    previewPrefs.value.roundLayout === 'expand' ? 'expand' : 'aggregate'
  const setView = (next: 'split' | 'grid') => {
    setSessionView(undefined)
    previewPrefs.setValue((current) => ({ ...current, view: next }))
  }
  const setGroupMode = (next: 'task' | 'account') => {
    previewPrefs.setValue((current) => ({ ...current, groupMode: next }))
  }
  const setRoundLayout = (next: 'aggregate' | 'expand') => {
    previewPrefs.setValue((current) => ({ ...current, roundLayout: next }))
  }
  const [sampleOverrideId, setSampleOverrideId] = useState<string>()
  const [gridCols, setGridCols] = useState(4)
  const [accountDetailId, setAccountDetailId] = useState<number | null>(null)
  const [runDetailId, setRunDetailId] = useState<string>()
  const [pageDraft, setPageDraft] = useState(String(Math.max(1, page)))
  const [pageDraftSource, setPageDraftSource] = useState(Math.max(1, page))
  const pendingSampleId = useRef<string | undefined>(undefined)
  const pendingRoundNumber = useRef<number | undefined>(undefined)
  const [sampleOverrideRound, setSampleOverrideRound] = useState<number>()
  const currentPage = Math.max(1, page)
  const currentPageCount = Math.max(1, pageCount)
  const safeIndex = items.length
    ? Math.min(Math.max(index, 0), items.length - 1)
    : 0
  const item = items[safeIndex]
  const [cachedLayoutItems, setCachedLayoutItems] = useState(items)
  if (items.length > 0) {
    if (
      cachedLayoutItems.length !== items.length ||
      cachedLayoutItems.some((entry, offset) => entry.id !== items[offset]?.id)
    ) {
      setCachedLayoutItems(items)
    }
  } else if (!pageLoading && cachedLayoutItems.length > 0) {
    setCachedLayoutItems(items)
  }
  const layoutItems =
    items.length > 0 || !pageLoading ? items : cachedLayoutItems
  const sampleLeaves = layoutItems.some((entry) => Boolean(entry.sample))
  const groups = useMemo(() => groupPreviewItems(layoutItems), [layoutItems])
  const accountPerspective = perspective === 'account'
  const itemNoun = accountPerspective ? '账号' : '任务'
  const showGroupToggle =
    !accountPerspective && !sampleLeaves && groups.length > 1
  const effectiveGroup = accountPerspective
    ? 'account'
    : sampleLeaves || !showGroupToggle
      ? 'task'
      : groupMode
  const expandRounds = !sampleLeaves && roundLayout === 'expand'
  const previewRunIds = useMemo(
    () =>
      Array.from(
        new Set(layoutItems.map((entry) => entry.runId).filter(Boolean))
      ),
    [layoutItems]
  )
  const previewSamplesQuery = useQuery({
    queryKey: ['run-preview-samples', previewRunIds],
    queryFn: () => api.runPreviewSamples(previewRunIds),
    enabled:
      open &&
      !accountPerspective &&
      view === 'grid' &&
      expandRounds &&
      previewRunIds.length > 0,
    staleTime: 30_000,
    gcTime: RUN_PREVIEW_GC_TIME,
    refetchOnWindowFocus: false,
  })
  const expandItems = useMemo(
    () =>
      expandRounds
        ? expandPreviewItems(
            layoutItems,
            previewSamplesQuery.data?.items,
            effectiveGroup
          )
        : layoutItems,
    [effectiveGroup, expandRounds, layoutItems, previewSamplesQuery.data?.items]
  )
  const activeSampleId = sampleOverrideId || item?.sampleId
  const expandLeafIndex = expandRounds
    ? Math.max(
        0,
        expandItems.findIndex((leaf) =>
          activeSampleId && leaf.sampleId
            ? leaf.sampleId === activeSampleId
            : leaf.runId === item?.runId
        )
      )
    : safeIndex
  const canPrevItem =
    (view === 'grid' && expandRounds ? expandLeafIndex > 0 : safeIndex > 0) ||
    currentPage > 1
  const canNextItem =
    (view === 'grid' && expandRounds
      ? expandLeafIndex < Math.max(expandItems.length - 1, 0)
      : safeIndex < Math.max(items.length - 1, 0)) ||
    currentPage < currentPageCount
  const selectPreviewItem = (
    nextIndex: number,
    sampleId?: string,
    roundNumber?: number
  ) => {
    if (sampleId) pendingSampleId.current = sampleId
    if (roundNumber) pendingRoundNumber.current = roundNumber
    onIndexChange(nextIndex)
    if (sampleId) setSampleOverrideId(sampleId)
    if (roundNumber) setSampleOverrideRound(roundNumber)
  }
  const openPreviewItem = (
    nextIndex: number,
    sampleId?: string,
    roundNumber?: number
  ) => {
    selectPreviewItem(nextIndex, sampleId, roundNumber)
    setSessionView('split')
  }
  const selectExpandLeaf = (leafIndex: number) => {
    const leaf = expandItems[leafIndex]
    if (!leaf) return
    const taskIndex = parentPreviewIndex(items, leaf)
    if (taskIndex < 0) return
    selectPreviewItem(taskIndex, leaf.sampleId, leaf.roundNumber)
  }
  const moveExpandLeaf = (delta: number) => {
    const next = expandLeafIndex + delta
    if (next < 0) {
      if (currentPage > 1) onPageChange?.(currentPage - 1, 'end')
      return
    }
    if (next >= expandItems.length) {
      if (currentPage < currentPageCount)
        onPageChange?.(currentPage + 1, 'start')
      return
    }
    selectExpandLeaf(next)
  }
  const goPrevItem = () => {
    if (view === 'grid' && expandRounds) {
      moveExpandLeaf(-1)
      return
    }
    if (safeIndex > 0) {
      onIndexChange(safeIndex - 1)
      return
    }
    if (currentPage > 1) onPageChange?.(currentPage - 1, 'end')
  }
  const goNextItem = () => {
    if (view === 'grid' && expandRounds) {
      moveExpandLeaf(1)
      return
    }
    if (items.length && safeIndex < items.length - 1) {
      onIndexChange(safeIndex + 1)
      return
    }
    if (currentPage < currentPageCount) onPageChange?.(currentPage + 1, 'start')
  }
  const commitPreviewPage = () => {
    if (!onPageChange) {
      setPageDraft(String(currentPage))
      return
    }
    const parsed = Number.parseInt(pageDraft, 10)
    if (!Number.isFinite(parsed)) {
      setPageDraft(String(currentPage))
      return
    }
    const nextPage = Math.min(currentPageCount, Math.max(1, parsed))
    setPageDraft(String(nextPage))
    if (nextPage !== currentPage) onPageChange(nextPage, 'start')
  }
  const skipPreviewPageCommit = (relatedTarget?: EventTarget | null) => {
    if (skipPageCommitRef.current) {
      skipPageCommitRef.current = false
      return true
    }
    return (
      relatedTarget instanceof Node &&
      Boolean(pagerRef.current?.contains(relatedTarget))
    )
  }
  const neighborRunIds = useMemo(() => {
    if (!item || view !== 'split' || isAccountPreviewItem(item)) return []
    const ids: string[] = []
    const previous = items[safeIndex - 1]
    const next = items[safeIndex + 1]
    if (previous?.runId && previous.runId !== item.runId) {
      ids.push(previous.runId)
    }
    if (next?.runId && next.runId !== item.runId) {
      ids.push(next.runId)
    }
    return Array.from(new Set(ids.filter(Boolean)))
  }, [item, items, safeIndex, view])
  const neighborAccountIds = useMemo(() => {
    if (!item || view !== 'split' || !isAccountPreviewItem(item)) return []
    const ids: number[] = []
    const previous = items[safeIndex - 1]
    const next = items[safeIndex + 1]
    if (previous?.accountId && previous.accountId !== item.accountId) {
      ids.push(previous.accountId)
    }
    if (next?.accountId && next.accountId !== item.accountId) {
      ids.push(next.accountId)
    }
    return Array.from(new Set(ids))
  }, [item, items, safeIndex, view])

  useQueries({
    queries: neighborRunIds.map((runId) => ({
      queryKey: ['run-preview', runId],
      queryFn: async () => slimRunPreview(await api.run(runId)),
      enabled:
        open &&
        Boolean(runId) &&
        !items.some(
          (entry) =>
            entry.runId === runId && Boolean(entry.content || entry.sample)
        ),
      staleTime: 30_000,
      gcTime: RUN_PREVIEW_GC_TIME,
      refetchOnWindowFocus: false,
    })),
  })
  useQueries({
    queries: neighborAccountIds.map((accountId) => ({
      queryKey: ['account-preview', accountId],
      queryFn: async () =>
        slimAccountPreview(
          await api.account(accountId, ACCOUNT_PREVIEW_SAMPLE_LIMIT)
        ),
      enabled: open && Boolean(accountId),
      staleTime: 30_000,
      gcTime: RUN_PREVIEW_GC_TIME,
      refetchOnWindowFocus: false,
    })),
  })

  const isAccountItem = isAccountPreviewItem(item)
  const needsPreviewFetch = Boolean(
    item &&
      !item.content &&
      !item.sample &&
      (isAccountItem ? item.accountId : item.runId)
  )
  const runQuery = useQuery({
    queryKey: ['run-preview', item?.runId],
    queryFn: async () => slimRunPreview(await api.run(item!.runId)),
    enabled: open && view === 'split' && Boolean(item?.runId) && !isAccountItem,
    staleTime: 30_000,
    gcTime: RUN_PREVIEW_GC_TIME,
    refetchOnWindowFocus: false,
  })
  const accountPreviewQuery = useQuery({
    queryKey: ['account-preview', item?.accountId],
    queryFn: async () =>
      slimAccountPreview(
        await api.account(item!.accountId, ACCOUNT_PREVIEW_SAMPLE_LIMIT)
      ),
    enabled:
      open && view === 'split' && isAccountItem && Boolean(item?.accountId),
    staleTime: 30_000,
    gcTime: RUN_PREVIEW_GC_TIME,
    refetchOnWindowFocus: false,
  })
  const accountQuery = useQuery({
    queryKey: ['account', item?.accountId],
    queryFn: () => api.account(item!.accountId, 1),
    enabled: open && Boolean(item?.accountId) && !isAccountItem,
  })
  const egressQuery = useQuery({
    queryKey: ['egress'],
    queryFn: () => api.egress({ pageSize: 500 }),
    enabled: open,
    staleTime: 60_000,
  })
  const account =
    accountPreviewQuery.data?.account ?? accountQuery.data?.account
  const egressNodeNames = useMemo(
    () => buildEgressNodeNameMap(egressQuery.data?.items),
    [egressQuery.data?.items]
  )
  const nestedDetailOpen = accountDetailId != null || Boolean(runDetailId)
  const runSamples = item?.sample
    ? []
    : isAccountItem
      ? orderedPreviewSamples(accountPreviewQuery.data?.samples ?? [])
      : (runQuery.data?.samples ?? [])
  const sample = resolvePreviewSample(
    runSamples,
    item
      ? {
          ...item,
          roundNumber: sampleOverrideRound || item.roundNumber,
        }
      : item,
    sampleOverrideId
  )
  const content = item?.content || sample?.response_text || ''
  const expectedOutput =
    item?.expectedOutput || runQuery.data?.profile?.expected_output || ''
  const expectedImageUrl =
    item?.expectedImageUrl || runQuery.data?.profile?.expected_image_url || ''
  const profileName = item?.profileName || runQuery.data?.profile?.name || ''
  const canCompare = Boolean(expectedOutput || expectedImageUrl)
  const alreadyIsolated = isIsolatedAccount(account)
  const isolateMutation = useMutation({
    mutationFn: (accountId: number) =>
      api.accountAction(accountId, {
        action: 'isolate',
        note: PREVIEW_ISOLATE_NOTE,
        propagate: true,
      }),
    onSuccess: () => {
      setIsolateOpen(false)
      toast.success('已移入隔离区')
      if (item?.accountId) {
        void client.invalidateQueries({ queryKey: ['account', item.accountId] })
        void client.invalidateQueries({ queryKey: ['accounts'] })
        void client.invalidateQueries({ queryKey: ['runs'] })
        void client.invalidateQueries({ queryKey: ['dashboard'] })
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  useEffect(() => {
    if (open) return
    client.removeQueries({ queryKey: ['run-preview'] })
    client.removeQueries({ queryKey: ['run-preview-samples'] })
    client.removeQueries({ queryKey: ['account-preview'] })
  }, [client, open])

  useEffect(() => {
    // Reset per-item chrome after the selected preview card changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCompareExpected(false)
    setIsolateOpen(false)
    const nextId = pendingSampleId.current ?? item?.sampleId
    const nextRound = pendingRoundNumber.current ?? item?.roundNumber
    pendingSampleId.current = undefined
    pendingRoundNumber.current = undefined
    setSampleOverrideId(nextId)
    setSampleOverrideRound(nextRound)
  }, [item?.id, item?.sampleId, item?.roundNumber])

  if (!open) {
    if (sessionView !== undefined) setSessionView(undefined)
    if (accountDetailId != null) setAccountDetailId(null)
    if (runDetailId) setRunDetailId(undefined)
  }

  if (pageDraftSource !== currentPage) {
    setPageDraftSource(currentPage)
    setPageDraft(String(currentPage))
  }

  useEffect(() => {
    if (!open || view !== 'split') return
    const container = listRef.current
    const active = container?.querySelector<HTMLElement>(
      `[data-preview-index="${safeIndex}"]`
    )
    if (container && active) scrollChildIntoContainer(container, active)
  }, [open, safeIndex, view, effectiveGroup])

  useEffect(() => {
    if (!open || view !== 'grid') return
    const container = gridRef.current
    const active = container?.querySelector<HTMLElement>(
      `[data-preview-index="${safeIndex}"]`
    )
    if (container && active) scrollChildIntoContainer(container, active)
  }, [open, safeIndex, view, effectiveGroup, roundLayout])

  useEffect(() => {
    const node = gridRef.current
    if (!node || view !== 'grid') return
    const measure = () => {
      const width = node.clientWidth
      setGridCols(width >= 1536 ? 5 : width >= 1280 ? 4 : width >= 768 ? 3 : 2)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [view, items.length, effectiveGroup, roundLayout])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }
      if (isolateOpen) return
      if (event.key === 'Enter' && view === 'grid') {
        event.preventDefault()
        setSessionView('split')
        return
      }
      if (event.key === '[' || event.key === ']') {
        if (runSamples.length < 2) return
        event.preventDefault()
        const currentId = sample?.id
        const current = Math.max(
          0,
          runSamples.findIndex((entry) => entry.id === currentId)
        )
        const next =
          event.key === ']'
            ? Math.min(runSamples.length - 1, current + 1)
            : Math.max(0, current - 1)
        setSampleOverrideId(runSamples[next]?.id)
        return
      }
      const step =
        view === 'grid' &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')
          ? gridCols
          : 1
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (view === 'grid' && expandRounds) {
          moveExpandLeaf(-step)
        } else if (safeIndex > 0) {
          onIndexChange(Math.max(0, safeIndex - step))
        } else if (currentPage > 1) {
          onPageChange?.(currentPage - 1, 'end')
        }
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault()
        if (view === 'grid' && expandRounds) {
          moveExpandLeaf(step)
        } else if (items.length && safeIndex < items.length - 1) {
          onIndexChange(Math.min(items.length - 1, safeIndex + step))
        } else if (currentPage < currentPageCount) {
          onPageChange?.(currentPage + 1, 'start')
        }
      } else if (event.key === 'i' || event.key === 'I') {
        event.preventDefault()
        if (item && !alreadyIsolated) setIsolateOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    alreadyIsolated,
    currentPage,
    currentPageCount,
    expandRounds,
    gridCols,
    isolateOpen,
    item,
    items.length,
    moveExpandLeaf,
    onIndexChange,
    onPageChange,
    open,
    runSamples,
    safeIndex,
    sample?.id,
    view,
  ])

  const pageLabel =
    currentPageCount > 1 ? `第 ${currentPage} / ${currentPageCount} 页` : ''
  const totalLabel = total != null ? `共 ${total} 条` : ''
  const accountCounter =
    effectiveGroup === 'account'
      ? `账号 ${Math.max(1, groups.findIndex((group) => group.accountId === item?.accountId) + 1)} / ${groups.length}`
      : ''
  const counterLabel = [
    sampleLeaves
      ? `样本 ${items.length ? safeIndex + 1 : 0} / ${items.length}`
      : expandRounds
        ? [
            accountCounter,
            `轮次 ${expandItems.length ? expandLeafIndex + 1 : 0} / ${expandItems.length}`,
          ]
            .filter(Boolean)
            .join(' · ')
        : effectiveGroup === 'account'
          ? accountPerspective
            ? accountCounter
            : `${accountCounter} · 任务 ${items.length ? safeIndex + 1 : 0} / ${items.length}`
          : `${itemNoun} ${items.length ? safeIndex + 1 : 0} / ${items.length}`,
    pageLabel,
    totalLabel,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && nestedDetailOpen) return
          onOpenChange(next)
        }}
      >
        <DialogContent
          showCloseButton={false}
          className='top-0 left-0 h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden overflow-x-hidden rounded-none border-0 bg-background p-0 shadow-none sm:max-w-none sm:p-0'
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement).focus({ preventScroll: true })
          }}
          onEscapeKeyDown={(event) => {
            if (
              event.target instanceof HTMLElement &&
              event.target.matches('[data-dialog-autofocus="skip"]')
            ) {
              event.preventDefault()
            }
          }}
        >
          <div className='flex h-full min-h-0 min-w-0 flex-col overflow-hidden'>
            <header className='flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2'>
              <div className='flex shrink-0 items-center gap-1'>
                <Tabs
                  value={view}
                  className='shrink-0 gap-0'
                  onValueChange={(value) =>
                    setView(value === 'grid' ? 'grid' : 'split')
                  }
                >
                  <TabsList className='h-8'>
                    <TabsTrigger value='split'>
                      <LayoutList className='size-3.5' />
                      阅读
                    </TabsTrigger>
                    <TabsTrigger value='grid'>
                      <LayoutGrid className='size-3.5' />
                      缩略图
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <InfoTooltip
                  label='预览操作'
                  content='单击选中卡片，双击进入阅读模式查看详情。'
                />
              </div>
              {showGroupToggle ? (
                <Tabs
                  value={effectiveGroup}
                  className='shrink-0 gap-0'
                  onValueChange={(value) =>
                    setGroupMode(value === 'account' ? 'account' : 'task')
                  }
                >
                  <TabsList className='h-8'>
                    <TabsTrigger value='task'>任务</TabsTrigger>
                    <TabsTrigger value='account'>账号</TabsTrigger>
                  </TabsList>
                </Tabs>
              ) : null}
              {view === 'grid' && !sampleLeaves ? (
                <Tabs
                  value={roundLayout}
                  className='shrink-0 gap-0'
                  onValueChange={(value) =>
                    setRoundLayout(value === 'expand' ? 'expand' : 'aggregate')
                  }
                >
                  <TabsList className='h-8'>
                    <TabsTrigger value='aggregate'>聚合轮次</TabsTrigger>
                    <TabsTrigger value='expand'>平铺展开</TabsTrigger>
                  </TabsList>
                </Tabs>
              ) : null}
              <Button
                type='button'
                size='icon'
                variant='ghost'
                disabled={!canPrevItem || pageLoading}
                onClick={goPrevItem}
                aria-label='上一项'
              >
                <ChevronLeft />
              </Button>
              <Button
                type='button'
                size='icon'
                variant='ghost'
                disabled={!canNextItem || pageLoading}
                onClick={goNextItem}
                aria-label='下一项'
              >
                <ChevronRight />
              </Button>
              <div className='min-w-0 flex-1'>
                <div className='truncate font-medium'>
                  {item?.accountName || '结果预览'}
                </div>
                <div className='truncate text-xs text-muted-foreground'>
                  {item
                    ? `${counterLabel}${profileName ? ` · ${profileName}` : ''}`
                    : pageLoading
                      ? '正在加载这一页…'
                      : currentPageCount > 1
                        ? `这一页没有可预览${itemNoun} · ${pageLabel}`
                        : `当前筛选没有可预览${itemNoun}`}
                </div>
              </div>
              {onPageChange && currentPageCount > 1 ? (
                <div
                  ref={pagerRef}
                  className='flex shrink-0 items-center gap-1'
                  onPointerDown={(event) => {
                    const target = event.target
                    if (
                      !(target instanceof HTMLElement) ||
                      target.closest('input')
                    ) {
                      return
                    }
                    if (pagerRef.current?.contains(document.activeElement)) {
                      skipPageCommitRef.current = true
                    }
                  }}
                >
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    className='h-8'
                    disabled={currentPage <= 1 || pageLoading}
                    onClick={() => onPageChange(currentPage - 1, 'end')}
                  >
                    上一页
                  </Button>
                  <label className='flex items-center gap-1 text-xs text-muted-foreground'>
                    <span className='sr-only'>跳转到页码</span>
                    <Input
                      type='text'
                      inputMode='numeric'
                      pattern='[0-9]*'
                      value={pageDraft}
                      disabled={pageLoading}
                      autoFocus={false}
                      data-dialog-autofocus='skip'
                      aria-label='页码'
                      className='h-8 w-14 px-2 text-center text-xs tabular-nums'
                      onChange={(event) =>
                        setPageDraft(event.target.value.replace(/[^\d]/g, ''))
                      }
                      onBlur={(event) => {
                        if (skipPreviewPageCommit(event.relatedTarget)) return
                        commitPreviewPage()
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          skipPageCommitRef.current = true
                          commitPreviewPage()
                          event.currentTarget.blur()
                          return
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          event.stopPropagation()
                          skipPageCommitRef.current = true
                          setPageDraft(String(currentPage))
                          event.currentTarget.blur()
                        }
                      }}
                    />
                    <span className='tabular-nums'>/ {currentPageCount}</span>
                  </label>
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    className='h-8'
                    disabled={currentPage >= currentPageCount || pageLoading}
                    onClick={() => onPageChange(currentPage + 1, 'start')}
                  >
                    下一页
                  </Button>
                </div>
              ) : null}
              {canCompare && view === 'split' ? (
                <Button
                  type='button'
                  size='sm'
                  variant={compareExpected ? 'secondary' : 'outline'}
                  onClick={() => setCompareExpected((current) => !current)}
                >
                  <Columns2 />
                  对照预期
                </Button>
              ) : null}
              {accountPerspective ? null : alreadyIsolated ? (
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={() => {
                    onOpenChange(false)
                    onOpenQuarantine?.()
                  }}
                >
                  <ShieldBan />
                  查看隔离区
                </Button>
              ) : (
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={!item}
                  onClick={() => setIsolateOpen(true)}
                >
                  <ShieldBan />
                  移入隔离区
                </Button>
              )}
              <Button
                type='button'
                size='icon'
                variant='ghost'
                onClick={() => onOpenChange(false)}
                aria-label='关闭预览'
              >
                <X />
              </Button>
            </header>
            {pageLoading && !item ? (
              <div className='flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground'>
                <Loader2 className='size-4 animate-spin' />
                正在加载这一页
              </div>
            ) : item ? (
              view === 'grid' ? (
                <div
                  ref={gridRef}
                  className='min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain'
                >
                  {effectiveGroup === 'account' ? (
                    <div className='flex flex-col px-4 pb-4'>
                      {groups.map((group) => {
                        const leaves = expandRounds
                          ? expandItems.filter(
                              (leaf) => leaf.accountId === group.accountId
                            )
                          : group.items
                        return (
                          <section key={group.accountId}>
                            <div className='sticky top-0 isolate z-30 -mx-4 border-b border-border/70 bg-background/90 px-4 py-2 backdrop-blur-md'>
                              <div className='truncate text-sm font-medium'>
                                {group.accountName}
                              </div>
                              <div className='truncate text-xs font-normal text-muted-foreground'>
                                {groupAccountSubtitle(
                                  group.items,
                                  leaves.length,
                                  accountPerspective
                                )}
                              </div>
                            </div>
                            <div
                              className={`${THUMB_GRID_CLASSNAME} pt-3 pb-6`}
                            >
                              {leaves.map((entry) => {
                                const index = parentPreviewIndex(items, entry)
                                const selected =
                                  entry.id ===
                                  (expandRounds
                                    ? expandItems[expandLeafIndex]?.id
                                    : item.id)
                                return (
                                  <PreviewThumbCard
                                    key={entry.id}
                                    item={entry}
                                    index={index}
                                    active={selected}
                                    sampleLeaves={Boolean(entry.sampleId)}
                                    heading={entry.heading}
                                    onSelect={() =>
                                      selectPreviewItem(
                                        index,
                                        entry.sampleId,
                                        entry.roundNumber
                                      )
                                    }
                                    onOpen={() =>
                                      openPreviewItem(
                                        index,
                                        entry.sampleId,
                                        entry.roundNumber
                                      )
                                    }
                                  />
                                )
                              })}
                            </div>
                          </section>
                        )
                      })}
                    </div>
                  ) : (
                    <div className='p-4'>
                      <VirtualizedThumbGrid
                        items={expandRounds ? expandItems : items}
                        columns={gridCols}
                        activeId={
                          expandRounds
                            ? expandItems[expandLeafIndex]?.id || item.id
                            : item.id
                        }
                        sampleLeaves={sampleLeaves}
                        scrollRef={gridRef}
                        onSelect={(index) => {
                          if (!expandRounds) {
                            onIndexChange(index)
                            return
                          }
                          selectExpandLeaf(index)
                        }}
                        onOpen={(index) => {
                          if (!expandRounds) {
                            openPreviewItem(index)
                            return
                          }
                          const leaf = expandItems[index]
                          if (!leaf) return
                          const taskIndex = parentPreviewIndex(items, leaf)
                          if (taskIndex >= 0) {
                            openPreviewItem(
                              taskIndex,
                              leaf.sampleId,
                              leaf.roundNumber
                            )
                          }
                        }}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:flex-row'>
                  <aside className='flex max-h-56 w-full shrink-0 flex-col overflow-hidden border-b bg-muted/10 lg:max-h-none lg:w-[22rem] lg:border-e lg:border-b-0'>
                    <div className='flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2'>
                      <span className='text-sm font-medium'>
                        {sampleLeaves
                          ? '样本'
                          : effectiveGroup === 'account'
                            ? '账号'
                            : itemNoun}
                      </span>
                      <Badge variant='secondary'>
                        {sampleLeaves || effectiveGroup === 'task'
                          ? items.length
                          : groups.length}
                      </Badge>
                    </div>
                    <div
                      ref={listRef}
                      className='min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-2'
                    >
                      {effectiveGroup === 'account' ? (
                        <div className='space-y-2'>
                          {groups.map((group) => {
                            const selected = group.accountId === item.accountId
                            return (
                              <div
                                key={group.accountId}
                                className={cn(
                                  'rounded-xl border',
                                  selected
                                    ? 'border-primary/45 bg-primary/5'
                                    : 'bg-background'
                                )}
                              >
                                <button
                                  type='button'
                                  data-preview-index={items.findIndex(
                                    (entry) => entry.id === group.items[0].id
                                  )}
                                  className='w-full px-3 py-2.5 text-left'
                                  onClick={() =>
                                    onIndexChange(
                                      items.findIndex(
                                        (entry) =>
                                          entry.id === group.items[0].id
                                      )
                                    )
                                  }
                                >
                                  <div className='truncate text-sm font-medium'>
                                    {group.accountName}
                                  </div>
                                  <div className='mt-1 truncate text-[11px] text-muted-foreground'>
                                    {groupAccountSubtitle(
                                      group.items,
                                      groupRoundCount(group.items),
                                      accountPerspective
                                    )}
                                  </div>
                                </button>
                                {selected && accountPerspective ? (
                                  runSamples.length > 1 ? (
                                    <div className='flex flex-wrap gap-1 border-t px-3 py-2'>
                                      {runSamples.map((entrySample, offset) => {
                                        const selectedSample =
                                          entrySample.id === sample?.id
                                        return (
                                          <Button
                                            key={entrySample.id}
                                            type='button'
                                            size='sm'
                                            variant={
                                              selectedSample
                                                ? 'secondary'
                                                : 'outline'
                                            }
                                            className='h-7 px-2 text-xs'
                                            onClick={() => {
                                              setSampleOverrideId(
                                                entrySample.id
                                              )
                                              setSampleOverrideRound(offset + 1)
                                            }}
                                          >
                                            样本 {offset + 1}
                                          </Button>
                                        )
                                      })}
                                    </div>
                                  ) : null
                                ) : selected ? (
                                  <div className='space-y-1 border-t px-2 py-2'>
                                    {group.items.map((entry) => {
                                      const itemIndex = items.findIndex(
                                        (candidate) => candidate.id === entry.id
                                      )
                                      const active = itemIndex === safeIndex
                                      const roundCount = Math.max(
                                        1,
                                        entry.completedSteps || 1
                                      )
                                      return (
                                        <div key={entry.id}>
                                          <button
                                            type='button'
                                            data-preview-index={itemIndex}
                                            className={cn(
                                              'w-full rounded-lg px-2 py-1.5 text-left',
                                              active
                                                ? 'bg-background shadow-sm'
                                                : 'hover:bg-background/70'
                                            )}
                                            onClick={() =>
                                              onIndexChange(itemIndex)
                                            }
                                          >
                                            <div className='flex items-start justify-between gap-2'>
                                              <div className='min-w-0'>
                                                <div className='truncate text-xs font-medium'>
                                                  {entry.profileName ||
                                                    (entry.createdAt
                                                      ? `任务 ${formatDate(entry.createdAt)}`
                                                      : `任务 ${entry.runId.slice(0, 8)}`)}
                                                </div>
                                                <div className='truncate text-[11px] text-muted-foreground'>
                                                  {entry.createdAt
                                                    ? `任务 ${formatDate(entry.createdAt)}`
                                                    : `ID ${entry.accountId}`}
                                                  {roundCount > 1
                                                    ? ` · ${roundCount} 轮`
                                                    : ''}
                                                </div>
                                              </div>
                                            </div>
                                          </button>
                                          {active && runSamples.length > 1 ? (
                                            <div className='mt-1 flex flex-wrap gap-1 px-1 pb-1'>
                                              {runSamples.map((entrySample) => {
                                                const selectedSample =
                                                  entrySample.id === sample?.id
                                                return (
                                                  <Button
                                                    key={entrySample.id}
                                                    type='button'
                                                    size='sm'
                                                    variant={
                                                      selectedSample
                                                        ? 'secondary'
                                                        : 'outline'
                                                    }
                                                    className='h-7 px-2 text-xs'
                                                    onClick={() =>
                                                      setSampleOverrideId(
                                                        entrySample.id
                                                      )
                                                    }
                                                  >
                                                    第{' '}
                                                    {entrySample.round_number ||
                                                      1}{' '}
                                                    轮
                                                  </Button>
                                                )
                                              })}
                                            </div>
                                          ) : null}
                                        </div>
                                      )
                                    })}
                                  </div>
                                ) : null}
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div className='space-y-2'>
                          {items.map((entry, itemIndex) => {
                            const active = itemIndex === safeIndex
                            return (
                              <div key={entry.id}>
                                <button
                                  type='button'
                                  data-preview-index={itemIndex}
                                  className={cn(
                                    'w-full rounded-xl border px-3 py-2.5 text-left transition-colors',
                                    active
                                      ? 'border-primary/45 bg-primary/5'
                                      : 'bg-background hover:border-border hover:bg-muted/40'
                                  )}
                                  onClick={() => onIndexChange(itemIndex)}
                                >
                                  <div className='flex items-start justify-between gap-2'>
                                    <div className='min-w-0'>
                                      <div className='truncate text-sm font-medium'>
                                        {sampleLeaves
                                          ? `第 ${entry.sample?.round_number || 1} 轮`
                                          : entry.accountName}
                                      </div>
                                      <div className='mt-1 truncate text-[11px] text-muted-foreground'>
                                        {sampleLeaves
                                          ? sampleMeta(entry)
                                          : accountMeta(entry)}
                                      </div>
                                    </div>
                                    {sampleLeaves && entry.sample ? (
                                      <StatusBadge
                                        value={entry.sample.classification}
                                      />
                                    ) : entry.profileName ? (
                                      <Badge
                                        variant='outline'
                                        className='max-w-24 truncate'
                                      >
                                        {entry.profileName}
                                      </Badge>
                                    ) : null}
                                  </div>
                                </button>
                                {active && runSamples.length > 1 ? (
                                  <div className='mt-1 flex flex-wrap gap-1 px-1'>
                                    {runSamples.map((entrySample, offset) => {
                                      const selectedSample =
                                        entrySample.id === sample?.id
                                      return (
                                        <Button
                                          key={entrySample.id}
                                          type='button'
                                          size='sm'
                                          variant={
                                            selectedSample
                                              ? 'secondary'
                                              : 'outline'
                                          }
                                          className='h-7 px-2 text-xs'
                                          onClick={() => {
                                            setSampleOverrideId(entrySample.id)
                                            setSampleOverrideRound(offset + 1)
                                          }}
                                        >
                                          {accountPerspective
                                            ? `样本 ${offset + 1}`
                                            : `第 ${entrySample.round_number || 1} 轮`}
                                        </Button>
                                      )
                                    })}
                                  </div>
                                ) : null}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </aside>
                  <div className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
                    <InspectBar
                      item={item}
                      account={account}
                      sample={sample}
                      loading={
                        isAccountItem
                          ? accountPreviewQuery.isLoading
                          : accountQuery.isLoading
                      }
                      profileName={profileName}
                      onOpenAccount={() => setAccountDetailId(item.accountId)}
                      onOpenRun={
                        accountPerspective || !item.runId
                          ? undefined
                          : () => setRunDetailId(item.runId)
                      }
                    />
                    <div className='min-h-0 min-w-0 flex-1 overflow-hidden'>
                      {needsPreviewFetch &&
                      (isAccountItem
                        ? accountPreviewQuery.isLoading
                        : runQuery.isLoading) ? (
                        <div className='flex h-full items-center justify-center gap-2 text-sm text-muted-foreground'>
                          <Loader2 className='size-4 animate-spin' />
                          正在读取样本
                        </div>
                      ) : needsPreviewFetch &&
                        (isAccountItem
                          ? accountPreviewQuery.isError
                          : runQuery.isError) ? (
                        <div className='flex h-full items-center justify-center p-6 text-sm text-destructive'>
                          {getErrorMessage(
                            isAccountItem
                              ? accountPreviewQuery.error
                              : runQuery.error
                          )}
                        </div>
                      ) : (
                        <ContentPreviewCanvas
                          key={`${item.id}:${sample?.id ?? 'empty'}`}
                          content={content}
                          expectedImageUrl={expectedImageUrl}
                          expectedContent={expectedOutput}
                          compareExpected={compareExpected}
                          className='h-full min-w-0'
                        />
                      )}
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div className='flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground'>
                {currentPageCount > 1
                  ? `这一页没有可预览${itemNoun}，可以翻到上一页或下一页`
                  : `当前筛选没有可预览的${itemNoun}`}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Suspense fallback={null}>
        <AccountProbeDetailDialog
          accountId={accountDetailId}
          open={accountDetailId != null}
          stacked
          egressNodeNames={egressNodeNames}
          onOpenChange={(next) => {
            if (!next) setAccountDetailId(null)
          }}
          onNavigateAway={() => onOpenChange(false)}
        />
      </Suspense>
      <ProbeRunDetailDialog
        runId={runDetailId}
        open={Boolean(runDetailId)}
        stacked
        egressNodeNames={egressNodeNames}
        onOpenChange={(next) => {
          if (!next) setRunDetailId(undefined)
        }}
      />
      <ConfirmDialog
        open={isolateOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isolateMutation.isPending) setIsolateOpen(false)
        }}
        title='将账号移入隔离区？'
        desc={
          <div className='space-y-2'>
            <p>
              当前预览看起来像降智时，可以把账号长期隔离并停用上游，不会删除账号。
            </p>
            <p className='font-medium text-foreground'>
              隔离区不会自动到期恢复。备注会写成「{PREVIEW_ISOLATE_NOTE}」。
            </p>
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          isolateMutation.isPending ? (
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
        isLoading={isolateMutation.isPending}
        disabled={!item}
        handleConfirm={() => {
          if (item) isolateMutation.mutate(item.accountId)
        }}
      />
    </>
  )
}

function InspectBar({
  item,
  account,
  sample,
  loading,
  profileName,
  onOpenAccount,
  onOpenRun,
}: {
  item: ResultPreviewItem
  account?: UpstreamAccount
  sample: ProbeSample | null
  loading: boolean
  profileName?: string
  onOpenAccount?: () => void
  onOpenRun?: () => void
}) {
  return (
    <div className='flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2'>
      {loading ? (
        <Badge variant='outline'>读取账号中</Badge>
      ) : (
        <>
          <MonitorStatusBadge status={account?.assessment.monitor_status} />
          {account?.missingUpstream ? (
            <Badge variant='outline'>上游缺失</Badge>
          ) : (
            <EnabledBadge enabled={account?.enabled} prefix='上游' />
          )}
          {isIsolatedAccount(account) ? (
            <Badge variant='secondary'>已隔离</Badge>
          ) : null}
        </>
      )}
      {sample ? <StatusBadge value={sample.classification} /> : null}
      {profileName ? (
        <Badge variant='outline' className='max-w-40 truncate'>
          {profileName}
        </Badge>
      ) : null}
      {sample ? (
        <>
          <span className='text-xs text-muted-foreground'>
            TPS{' '}
            <DualTpsValue
              tps={sample.tps}
              upstreamTps={sample.upstream_tps}
              compact
            />
          </span>
          <span className='text-xs text-muted-foreground'>
            首 Token {formatNumber(sample.first_token_ms, 0)} ms
          </span>
          <span className='text-xs text-muted-foreground'>
            耗时 {formatNumber(sample.duration_ms, 0)} ms
          </span>
        </>
      ) : null}
      <CopyButton
        value={item.accountEmail?.trim() || String(item.accountId)}
        className='size-6'
      />
      <div className='ms-auto flex flex-wrap gap-2'>
        {onOpenAccount ? (
          <Button
            type='button'
            size='sm'
            variant='outline'
            onClick={onOpenAccount}
          >
            <UsersRound />
            探针详情
          </Button>
        ) : null}
        {onOpenRun ? (
          <Button type='button' size='sm' variant='outline' onClick={onOpenRun}>
            <ExternalLink />
            任务详情
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function groupRoundCount(items: ResultPreviewItem[]) {
  return items.reduce(
    (sum, entry) => sum + Math.max(1, entry.completedSteps || 1),
    0
  )
}

function groupAccountSubtitle(
  items: ResultPreviewItem[],
  leavesCount: number,
  accountPerspective: boolean
) {
  const parts = [accountMeta(items[0], { includeTaskTime: false })]
  if (!accountPerspective) {
    parts.push(`${items.length} 个任务`)
  }
  const roundCount = Math.max(leavesCount, groupRoundCount(items))
  const baseline = accountPerspective ? 1 : items.length
  if (roundCount > baseline) {
    parts.push(`${roundCount} 轮`)
  }
  return parts.filter(Boolean).join(' · ')
}

function VirtualizedThumbGrid({
  items,
  columns,
  activeId,
  sampleLeaves,
  scrollRef,
  onSelect,
  onOpen,
}: {
  items: ResultPreviewItem[]
  columns: number
  activeId?: string
  sampleLeaves: boolean
  scrollRef: { current: HTMLDivElement | null }
  onSelect: (index: number) => void
  onOpen: (index: number) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const host = hostRef.current
    const scroller = scrollRef.current
    if (!host) return
    const update = () => {
      setScrollTop(scroller?.scrollTop ?? 0)
      setViewport({
        width: host.clientWidth,
        height: scroller?.clientHeight || host.clientHeight,
      })
    }
    update()
    const raf = requestAnimationFrame(update)
    const onScroll = () => setScrollTop(scroller?.scrollTop ?? 0)
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(host)
    if (scroller && scroller !== host) observer.observe(scroller)
    return () => {
      cancelAnimationFrame(raf)
      scroller?.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [scrollRef, items.length, columns])
  const gap = 12
  const cols = Math.max(1, columns)
  const cellWidth =
    cols > 1 ? (viewport.width - gap * (cols - 1)) / cols : viewport.width
  const thumbHeight = cellWidth * (THUMB_FRAME_HEIGHT / THUMB_FRAME_WIDTH)
  const rowHeight = thumbHeight + 56 + gap
  const rows = Math.ceil(items.length / cols) || 1
  const measured = viewport.width > 0 && cellWidth > 0
  const startRow = measured
    ? Math.max(0, Math.floor(scrollTop / Math.max(rowHeight, 1)))
    : 0
  const endRow = measured
    ? Math.min(
        rows,
        Math.ceil(
          (scrollTop + Math.max(viewport.height, rowHeight)) /
            Math.max(rowHeight, 1)
        )
      )
    : 0
  const startIndex = startRow * cols
  const endIndex = Math.min(items.length, endRow * cols)
  const visibleItems = measured ? items.slice(startIndex, endIndex) : []
  return (
    <div
      ref={hostRef}
      className='relative w-full'
      style={
        measured
          ? { height: Math.max(rowHeight, rows * rowHeight) }
          : {
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gap,
            }
      }
    >
      {visibleItems.map((entry, offset) => {
        const index = measured ? startIndex + offset : offset
        const row = Math.floor(index / cols)
        const col = index % cols
        return (
          <div
            key={entry.id}
            className={measured ? 'absolute overflow-hidden' : 'min-w-0'}
            style={
              measured
                ? {
                    top: row * rowHeight,
                    left: col * (cellWidth + gap),
                    width: cellWidth,
                    height: rowHeight - gap,
                  }
                : undefined
            }
          >
            <PreviewThumbCard
              item={entry}
              index={index}
              active={entry.id === activeId}
              sampleLeaves={sampleLeaves}
              heading={entry.heading}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          </div>
        )
      })}
    </div>
  )
}

function PreviewThumbCard({
  item,
  index,
  active,
  sampleLeaves,
  heading,
  onSelect,
  onOpen,
}: {
  item: ResultPreviewItem
  index: number
  active: boolean
  sampleLeaves: boolean
  heading?: string
  onSelect: (index: number) => void
  onOpen: (index: number) => void
}) {
  const { ref, inView } = useInView<HTMLButtonElement>()
  const hasLocal = Boolean(item.content || item.sample)
  const isAccountItem = isAccountPreviewItem(item)
  const runQuery = useQuery({
    queryKey: ['run-preview', item.runId],
    queryFn: async () => slimRunPreview(await api.run(item.runId)),
    enabled: inView && !hasLocal && Boolean(item.runId) && !isAccountItem,
    staleTime: 30_000,
    gcTime: RUN_PREVIEW_GC_TIME,
    refetchOnWindowFocus: false,
  })
  const accountPreviewQuery = useQuery({
    queryKey: ['account-preview', item.accountId],
    queryFn: async () =>
      slimAccountPreview(
        await api.account(item.accountId, ACCOUNT_PREVIEW_SAMPLE_LIMIT)
      ),
    enabled: inView && !hasLocal && isAccountItem && Boolean(item.accountId),
    staleTime: 30_000,
    gcTime: RUN_PREVIEW_GC_TIME,
    refetchOnWindowFocus: false,
  })
  const sample = resolvePreviewSample(
    isAccountItem
      ? (accountPreviewQuery.data?.samples ?? [])
      : (runQuery.data?.samples ?? []),
    item
  )
  const content = item.content || sample?.response_text || ''
  const html = extractHtmlPreviews(content)[0]
  const loading =
    inView &&
    !hasLocal &&
    (isAccountItem ? accountPreviewQuery.isLoading : runQuery.isLoading) &&
    !content
  return (
    <button
      ref={ref}
      type='button'
      data-preview-index={index}
      className={cn(
        'relative isolate z-0 flex h-full w-full min-w-0 flex-col overflow-hidden rounded-xl border bg-background p-0 text-left transition-colors',
        active
          ? 'border-primary/60 ring-2 ring-primary/20'
          : 'hover:border-primary/30'
      )}
      onClick={() => onSelect(index)}
      onDoubleClick={() => onOpen(index)}
    >
      <div className='relative aspect-[16/10] min-h-0 w-full overflow-hidden border-b bg-muted/20'>
        {(item.completedSteps || 0) > 1 && !item.sample && !item.sampleId ? (
          <span className='absolute top-2 right-2 z-[1] rounded-md bg-background/90 px-1.5 py-0.5 text-[10px] font-medium shadow-sm'>
            {item.completedSteps} 轮
          </span>
        ) : null}
        {loading ? (
          <div className='flex h-full w-full items-center justify-center text-muted-foreground'>
            <Loader2 className='size-4 animate-spin' />
          </div>
        ) : inView && html ? (
          <ScaledHtmlThumb html={html} />
        ) : inView && content.trim() ? (
          <div className='h-full w-full overflow-hidden p-3 text-[11px] leading-5 text-muted-foreground'>
            {content.replace(/\s+/g, ' ').slice(0, 220)}
          </div>
        ) : (
          <div className='flex h-full w-full items-center justify-center text-xs text-muted-foreground'>
            {inView ? '没有可预览正文' : '滚动后加载'}
          </div>
        )}
      </div>
      <div className='h-14 shrink-0 px-2.5 py-2'>
        <div className='truncate text-xs font-medium'>
          {heading ||
            item.heading ||
            (sampleLeaves
              ? `第 ${item.sample?.round_number || 1} 轮`
              : item.accountName)}
        </div>
        <div className='mt-0.5 truncate text-[11px] text-muted-foreground'>
          {sampleLeaves ? sampleMeta(item) : accountMeta(item)}
        </div>
      </div>
    </button>
  )
}

function ScaledHtmlThumb({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const slotReady = useHtmlThumbSlot(true)
  const htmlDocument = useMemo(() => buildHtmlDocument(html), [html])
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const update = () => setWidth(node.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const scale = width > 0 ? width / THUMB_FRAME_WIDTH : 0
  return (
    <div
      ref={ref}
      className='pointer-events-none absolute inset-0 z-0 overflow-hidden bg-white'
    >
      {scale > 0 && slotReady ? (
        <iframe
          title='HTML thumbnail'
          sandbox='allow-scripts'
          srcDoc={htmlDocument}
          tabIndex={-1}
          className='absolute top-0 left-0 origin-top-left border-0 bg-white'
          style={{
            width: THUMB_FRAME_WIDTH,
            height: THUMB_FRAME_HEIGHT,
            transform: `scale(${scale})`,
          }}
        />
      ) : (
        <div className='flex h-full w-full items-center justify-center text-muted-foreground'>
          <Loader2 className='size-4 animate-spin' />
        </div>
      )}
    </div>
  )
}

function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(
      ([entry]) => setInView(Boolean(entry?.isIntersecting)),
      { rootMargin: '80px 0px', threshold: 0.01 }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return { ref, inView }
}

function groupPreviewItems(items: ResultPreviewItem[]) {
  const order: number[] = []
  const map = new Map<number, ResultPreviewItem[]>()
  for (const item of items) {
    if (!map.has(item.accountId)) {
      order.push(item.accountId)
      map.set(item.accountId, [])
    }
    map.get(item.accountId)!.push(item)
  }
  return order.map((accountId) => {
    const grouped = map.get(accountId) ?? []
    return {
      accountId,
      accountName: grouped[0]?.accountName || `账号 ${accountId}`,
      items: grouped,
    }
  })
}

function accountMeta(
  item: ResultPreviewItem,
  options: { includeTaskTime?: boolean } = {}
) {
  const includeTaskTime = options.includeTaskTime ?? true
  const email = item.accountEmail?.trim()
  const parts = [`ID ${item.accountId}`]
  if (email && email.toLowerCase() !== item.accountName.trim().toLowerCase()) {
    parts.push(email)
  }
  if (includeTaskTime && item.createdAt) {
    parts.push(
      `${item.source === 'account' ? '样本' : '任务'} ${formatDate(item.createdAt)}`
    )
  }
  if (item.accountCreatedAt) {
    parts.push(`账号 ${formatAccountCreatedAt(item.accountCreatedAt)}`)
  }
  return parts.join(' · ')
}

function sampleMeta(item: ResultPreviewItem) {
  const parts = []
  if (item.createdAt) parts.push(formatDate(item.createdAt))
  if (item.accountCreatedAt) {
    parts.push(`账号 ${formatAccountCreatedAt(item.accountCreatedAt)}`)
  }
  return parts.join(' · ') || `ID ${item.accountId}`
}

function scrollChildIntoContainer(container: HTMLElement, child: HTMLElement) {
  const extra = 8
  const containerRect = container.getBoundingClientRect()
  const childRect = child.getBoundingClientRect()
  const childTop = childRect.top - containerRect.top + container.scrollTop
  const childBottom = childTop + child.offsetHeight
  if (childTop < container.scrollTop + extra) {
    container.scrollTop = Math.max(0, childTop - extra)
  } else if (
    childBottom >
    container.scrollTop + container.clientHeight - extra
  ) {
    container.scrollTop = childBottom - container.clientHeight + extra
  }
}

function isIsolatedAccount(account?: UpstreamAccount) {
  return (
    account?.assessment.monitor_status === 'quarantined' &&
    !account.assessment.quarantine_until
  )
}
