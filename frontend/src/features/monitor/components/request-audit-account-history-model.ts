import {
  type RequestAuditClientKeyOption,
  type RequestAuditHistoryAccount,
  type RequestAuditHistoryBucket,
  type RequestAuditHistoryBucketDominant,
  type RequestAuditHistoryPattern,
  type RequestAuditHistorySpan,
  type RequestAuditHistorySummary,
  type RequestAuditRiskLevel,
} from '@/lib/api'
import { formatNumber } from '@/lib/utils'

export const HISTORY_TIMEZONE = 'Asia/Shanghai'

export type HistoryAccountSort =
  | 'still_abnormal'
  | 'recurrent'
  | 'longest'
  | 'slow_recovery'
  | 'always_normal'
  | 'recent'

export type HistoryAccountPatternFilter =
  | RequestAuditHistoryPattern
  | 'recovered'
  | 'failing'

export type HistoryRiskFilter = 'all' | 'risky' | 'normal' | 'watch' | 'high'

export type HistoryPatternBadgeVariant =
  | 'secondary'
  | 'destructive'
  | 'success'
  | 'warning'
  | 'info'
  | 'outline'

export const DEFAULT_HISTORY_ACCOUNT_SORT: HistoryAccountSort = 'still_abnormal'

export const HISTORY_PATTERN_LABELS: Record<
  RequestAuditHistoryPattern,
  string
> = {
  sparse: '样本不足',
  always_normal: '全程正常',
  occasional: '偶发异常',
  recurrent: '反复异常',
  never_normal: '从未正常',
  still_abnormal: '当前仍异常',
}

export const HISTORY_PATTERN_DESCRIPTIONS: Record<
  RequestAuditHistoryPattern,
  string
> = {
  sparse: '请求样本太少，还看不清走势',
  always_normal: '窗口内没有观察或高风险请求',
  occasional: '多数时间正常，只出现过少量异常',
  recurrent: '多次出现异常段，可能周期性反复',
  never_normal: '窗口内没有正常请求',
  still_abnormal: '最近一段仍停在观察或高风险',
}

export const HISTORY_PATTERN_BADGE_VARIANTS: Record<
  RequestAuditHistoryPattern,
  HistoryPatternBadgeVariant
> = {
  sparse: 'outline',
  always_normal: 'success',
  occasional: 'warning',
  recurrent: 'destructive',
  never_normal: 'destructive',
  still_abnormal: 'destructive',
}

export const HISTORY_EXTRA_CHIP_LABELS = {
  regular: '规律性',
  failing: '请求失败多',
  recovered: '已恢复',
} as const

export const HISTORY_EXTRA_CHIP_DESCRIPTIONS = {
  regular: '异常段间隔较稳定',
  failing: 'HTTP 成功少、失败多，不是风险颜色',
  recovered: '曾经异常，当前已回到正常',
} as const

export const HISTORY_EXTRA_CHIP_VARIANTS: Record<
  keyof typeof HISTORY_EXTRA_CHIP_LABELS,
  HistoryPatternBadgeVariant
> = {
  regular: 'info',
  failing: 'secondary',
  recovered: 'success',
}

export const HISTORY_BUCKET_DOMINANT_LABELS: Record<
  RequestAuditHistoryBucketDominant,
  string
> = {
  empty: '空档',
  normal: '正常',
  watch: '观察',
  high: '高风险',
}

export const HISTORY_BUCKET_DOMINANT_CLASSES: Record<
  RequestAuditHistoryBucketDominant,
  string
> = {
  empty: 'bg-muted/30',
  normal: 'bg-emerald-500',
  watch: 'bg-amber-500',
  high: 'bg-rose-500',
}

export const HISTORY_SPAN_CLASSES: Record<RequestAuditRiskLevel, string> = {
  normal: 'bg-emerald-500',
  watch: 'bg-amber-500',
  high: 'bg-rose-500',
}

export const HISTORY_SWIMLANE_LEGEND: Array<{
  key: RequestAuditHistoryBucketDominant
  label: string
  swatchClassName: string
}> = [
  {
    key: 'empty',
    label: HISTORY_BUCKET_DOMINANT_LABELS.empty,
    swatchClassName: 'bg-muted-foreground/20 ring-1 ring-border',
  },
  {
    key: 'normal',
    label: HISTORY_BUCKET_DOMINANT_LABELS.normal,
    swatchClassName: HISTORY_BUCKET_DOMINANT_CLASSES.normal,
  },
  {
    key: 'watch',
    label: HISTORY_BUCKET_DOMINANT_LABELS.watch,
    swatchClassName: HISTORY_BUCKET_DOMINANT_CLASSES.watch,
  },
  {
    key: 'high',
    label: HISTORY_BUCKET_DOMINANT_LABELS.high,
    swatchClassName: HISTORY_BUCKET_DOMINANT_CLASSES.high,
  },
]

export const HISTORY_RISK_LEVEL_LABELS: Record<RequestAuditRiskLevel, string> =
  {
    normal: '正常',
    watch: '观察',
    high: '高风险',
  }

export const HISTORY_RISK_LEVEL_BADGE_VARIANTS: Record<
  RequestAuditRiskLevel,
  'success' | 'warning' | 'destructive'
> = {
  normal: 'success',
  watch: 'warning',
  high: 'destructive',
}

export const HISTORY_SORT_OPTIONS: Array<{
  value: HistoryAccountSort
  label: string
}> = [
  { value: 'still_abnormal', label: '仍异常' },
  { value: 'recurrent', label: '反复' },
  { value: 'longest', label: '最长异常' },
  { value: 'slow_recovery', label: '恢复慢' },
  { value: 'always_normal', label: '全程正常' },
  { value: 'recent', label: '最近' },
]

const ALWAYS_NORMAL_SORTS: HistoryAccountSort[] = ['recent']
const ABNORMAL_SORTS: HistoryAccountSort[] = [
  'still_abnormal',
  'recurrent',
  'longest',
  'slow_recovery',
  'recent',
]
const RECOVERED_SORTS: HistoryAccountSort[] = [
  'slow_recovery',
  'longest',
  'recurrent',
  'recent',
]

export function historySortOptionsForFilter(
  pattern?: HistoryAccountPatternFilter | null
) {
  if (pattern === 'always_normal') {
    return HISTORY_SORT_OPTIONS.filter((item) =>
      ALWAYS_NORMAL_SORTS.includes(item.value)
    )
  }
  if (
    pattern === 'never_normal' ||
    pattern === 'still_abnormal' ||
    pattern === 'occasional' ||
    pattern === 'recurrent'
  ) {
    return HISTORY_SORT_OPTIONS.filter((item) =>
      ABNORMAL_SORTS.includes(item.value)
    )
  }
  if (pattern === 'recovered') {
    return HISTORY_SORT_OPTIONS.filter((item) =>
      RECOVERED_SORTS.includes(item.value)
    )
  }
  if (pattern === 'sparse') {
    return HISTORY_SORT_OPTIONS.filter((item) => item.value === 'recent')
  }
  return HISTORY_SORT_OPTIONS
}

export function resolveHistorySort(
  sort: HistoryAccountSort,
  pattern?: HistoryAccountPatternFilter | null
): HistoryAccountSort {
  const options = historySortOptionsForFilter(pattern)
  if (options.some((item) => item.value === sort)) return sort
  return options[0]?.value ?? DEFAULT_HISTORY_ACCOUNT_SORT
}

export const HISTORY_RISK_FILTER_OPTIONS: Array<{
  value: HistoryRiskFilter
  label: string
}> = [
  { value: 'all', label: '全部' },
  { value: 'risky', label: '异常' },
  { value: 'normal', label: '正常' },
  { value: 'watch', label: '观察' },
  { value: 'high', label: '高风险' },
]

export const HISTORY_SUMMARY_CARDS: Array<{
  key: HistoryAccountPatternFilter
  label: string
  countKey: keyof Pick<
    RequestAuditHistorySummary,
    | 'alwaysNormal'
    | 'occasional'
    | 'recurrent'
    | 'neverNormal'
    | 'stillAbnormal'
    | 'recovered'
    | 'sparse'
    | 'failing'
  >
  swatch: string
  quiet?: boolean
}> = [
  {
    key: 'always_normal',
    label: '全程正常',
    countKey: 'alwaysNormal',
    swatch: 'bg-emerald-500',
  },
  {
    key: 'occasional',
    label: '偶发异常',
    countKey: 'occasional',
    swatch: 'bg-amber-500',
  },
  {
    key: 'recurrent',
    label: '反复异常',
    countKey: 'recurrent',
    swatch: 'bg-orange-500',
  },
  {
    key: 'never_normal',
    label: '从未正常',
    countKey: 'neverNormal',
    swatch: 'bg-rose-500',
  },
  {
    key: 'still_abnormal',
    label: '当前仍异常',
    countKey: 'stillAbnormal',
    swatch: 'bg-rose-600',
  },
  {
    key: 'recovered',
    label: '已恢复',
    countKey: 'recovered',
    swatch: 'bg-sky-500',
  },
  {
    key: 'sparse',
    label: '样本不足',
    countKey: 'sparse',
    swatch: 'bg-muted-foreground/45',
    quiet: true,
  },
  {
    key: 'failing',
    label: '请求失败多',
    countKey: 'failing',
    swatch: 'bg-muted-foreground/45',
    quiet: true,
  },
]

const PATTERN_STILL_ABNORMAL_RANK: Record<RequestAuditHistoryPattern, number> =
  {
    still_abnormal: 0,
    never_normal: 1,
    recurrent: 2,
    occasional: 3,
    sparse: 4,
    always_normal: 5,
  }

const PATTERN_RECURRENT_RANK: Record<RequestAuditHistoryPattern, number> = {
  recurrent: 0,
  still_abnormal: 1,
  never_normal: 2,
  occasional: 3,
  sparse: 4,
  always_normal: 5,
}

const CURRENT_STATE_RANK: Record<RequestAuditRiskLevel, number> = {
  high: 0,
  watch: 1,
  normal: 2,
}

export function historyAccountKey(account: RequestAuditHistoryAccount) {
  if (account.accountId != null && account.accountId > 0) {
    return String(account.accountId)
  }
  return `unknown:${account.accountName.trim() || 'unlabeled'}`
}

export function historyAccountHasName(account: RequestAuditHistoryAccount) {
  return Boolean(account.accountName.trim())
}

export function historyAccountDisplayName(account: RequestAuditHistoryAccount) {
  const name = account.accountName.trim()
  if (name) return name
  if (account.accountId != null) return `#${account.accountId}`
  return '未标记账号'
}

export function historyClientKeyLabel(item: RequestAuditClientKeyOption) {
  if (item.id === 'unlabeled') return item.name.trim() || '未记录 Key'
  return item.name.trim() || `#${item.id}`
}

export function accountMatchesHistoryFilter(
  account: RequestAuditHistoryAccount,
  pattern?: HistoryAccountPatternFilter | null
) {
  if (!pattern) return true
  if (pattern === 'recovered') return account.recovered
  if (pattern === 'failing') return account.failing
  if (pattern === 'still_abnormal') {
    return account.stillAbnormal || account.pattern === 'still_abnormal'
  }
  if (pattern === 'always_normal') {
    return account.alwaysNormal || account.pattern === 'always_normal'
  }
  if (pattern === 'never_normal') {
    return account.neverNormal || account.pattern === 'never_normal'
  }
  return account.pattern === pattern
}

export function filterHistoryAccounts(
  accounts: RequestAuditHistoryAccount[],
  options: {
    pattern?: HistoryAccountPatternFilter | null
    query?: string
  } = {}
) {
  const query = options.query?.trim().toLowerCase() ?? ''
  return accounts.filter((account) => {
    if (!accountMatchesHistoryFilter(account, options.pattern)) return false
    if (!query) return true
    return accountMatchesQuery(account, query)
  })
}

export function summarizeHistoryAccounts(
  accounts: RequestAuditHistoryAccount[]
): RequestAuditHistorySummary {
  const patternCounts: Record<RequestAuditHistoryPattern, number> = {
    sparse: 0,
    always_normal: 0,
    occasional: 0,
    recurrent: 0,
    never_normal: 0,
    still_abnormal: 0,
  }
  let requests = 0
  let regular = 0
  let stillAbnormal = 0
  let recovered = 0
  let failing = 0
  for (const account of accounts) {
    patternCounts[account.pattern] += 1
    requests += account.requests
    if (account.regular) regular += 1
    if (account.stillAbnormal) stillAbnormal += 1
    if (account.recovered) recovered += 1
    if (account.failing) failing += 1
  }
  return {
    accounts: accounts.length,
    requests,
    sparse: patternCounts.sparse,
    alwaysNormal: patternCounts.always_normal,
    occasional: patternCounts.occasional,
    recurrent: patternCounts.recurrent,
    regular,
    neverNormal: patternCounts.never_normal,
    stillAbnormal,
    recovered,
    failing,
  }
}

export function sortHistoryAccounts(
  accounts: RequestAuditHistoryAccount[],
  sort: HistoryAccountSort
) {
  return accounts
    .slice()
    .sort((left, right) => compareHistoryAccounts(left, right, sort))
}

export function formatHistoryMinutes(minutes: number | null | undefined) {
  if (minutes == null || Number.isNaN(minutes)) return '—'
  const absolute = Math.max(0, Math.round(minutes))
  if (absolute < 60) return `${absolute} 分钟`
  const hours = Math.floor(absolute / 60)
  const restMinutes = absolute % 60
  if (absolute < 24 * 60) {
    return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`
  }
  const days = Math.floor(absolute / (24 * 60))
  const restHours = Math.floor((absolute % (24 * 60)) / 60)
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`
}

export function formatHistoryMinutesCompact(
  minutes: number | null | undefined
) {
  if (minutes == null || Number.isNaN(minutes)) return '—'
  const absolute = Math.max(0, Math.round(minutes))
  if (absolute < 60) return `${absolute}m`
  const hours = Math.floor(absolute / 60)
  const restMinutes = absolute % 60
  if (absolute < 24 * 60) {
    return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`
  }
  const days = Math.floor(absolute / (24 * 60))
  const restHours = Math.floor((absolute % (24 * 60)) / 60)
  return restHours ? `${days}d${restHours}h` : `${days}d`
}

export function historyRowMaxRequests(account: RequestAuditHistoryAccount) {
  return account.buckets.reduce(
    (maximum, bucket) => Math.max(maximum, bucket.requests),
    0
  )
}

export function historyBucketOpacity(
  bucket: Pick<RequestAuditHistoryBucket, 'dominant' | 'requests'>,
  rowMaxRequests: number
) {
  if (bucket.dominant === 'empty' || bucket.requests <= 0) return 1
  if (rowMaxRequests <= 0) return 0.7
  const ratio = Math.min(1, bucket.requests / rowMaxRequests)
  return 0.42 + ratio * 0.58
}

export function formatHistoryTick(value: string, useClock: boolean) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const parts = shanghaiParts(date)
  return useClock
    ? `${parts.hour}:${parts.minute}`
    : `${parts.month}-${parts.day}`
}

export function formatHistoryTimeRange(start: string, end: string) {
  const startDate = new Date(start)
  const endDate = new Date(end)
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return `${start}–${end}`
  }
  const startParts = shanghaiParts(startDate)
  const endParts = shanghaiParts(endDate)
  const startDay = `${startParts.month}-${startParts.day}`
  const endDay = `${endParts.month}-${endParts.day}`
  const startTime = `${startParts.hour}:${startParts.minute}`
  const endTime = `${endParts.hour}:${endParts.minute}`
  if (startDay === endDay) return `${startDay} ${startTime}–${endTime}`
  return `${startDay} ${startTime}–${endDay} ${endTime}`
}

export function historySpanUsesClock(start: string, end: string) {
  const startDate = new Date(start)
  const endDate = new Date(end)
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return true
  }
  return endDate.getTime() - startDate.getTime() < 48 * 60 * 60 * 1000
}

export type HistoryAxisTick = {
  key: string
  value: string
  label: string
  align: 'start' | 'center' | 'end'
  percent: number
}

export function historyTimePercent(value: string, start: string, end: string) {
  const point = new Date(value).getTime()
  const from = new Date(start).getTime()
  const to = new Date(end).getTime()
  if (
    Number.isNaN(point) ||
    Number.isNaN(from) ||
    Number.isNaN(to) ||
    to <= from
  ) {
    return 0
  }
  return Math.min(100, Math.max(0, ((point - from) / (to - from)) * 100))
}

export function historyEpisodePlacement(
  episode: { start: string; end: string },
  start: string,
  end: string,
  minPercent: number
) {
  const left = historyTimePercent(episode.start, start, end)
  const right = historyTimePercent(episode.end, start, end)
  const width = Math.max(minPercent, right - left)
  return {
    left: Math.min(left, Math.max(0, 100 - width)),
    width: Math.min(width, 100),
  }
}

export function historyBucketIndexAt(
  buckets: RequestAuditHistoryBucket[],
  ratio: number
) {
  if (buckets.length === 0) return -1
  return Math.min(
    buckets.length - 1,
    Math.max(0, Math.floor(ratio * buckets.length))
  )
}

export function historyEpisodeAt<T extends { start: string; end: string }>(
  episodes: T[],
  bucket: Pick<RequestAuditHistoryBucket, 'start' | 'end'>
) {
  const from = new Date(bucket.start).getTime()
  const to = new Date(bucket.end).getTime()
  if (Number.isNaN(from) || Number.isNaN(to)) return null
  return (
    episodes.find((episode) => {
      const start = new Date(episode.start).getTime()
      const end = new Date(episode.end).getTime()
      if (Number.isNaN(start) || Number.isNaN(end)) return false
      return start <= to && end >= from
    }) ?? null
  )
}

export function historyAxisTicks(
  buckets: RequestAuditHistoryBucket[]
): HistoryAxisTick[] {
  if (buckets.length === 0) return []
  const first = buckets[0]
  const last = buckets[buckets.length - 1]
  const useClock = historySpanUsesClock(first.start, last.end)
  const desired =
    buckets.length <= 4 ? buckets.length : buckets.length <= 12 ? 4 : 5
  const indices: number[] = []
  if (desired === 1) {
    indices.push(0)
  } else if (desired >= buckets.length) {
    for (let index = 0; index < buckets.length; index += 1) {
      indices.push(index)
    }
  } else {
    for (let step = 0; step < desired; step += 1) {
      indices.push(Math.round((step * (buckets.length - 1)) / (desired - 1)))
    }
  }
  const ticks: HistoryAxisTick[] = []
  const seen = new Set<string>()
  indices.forEach((index, order) => {
    const isLast = order === indices.length - 1
    const value = isLast ? last.end : buckets[index].start
    const label = formatHistoryTick(value, useClock)
    const key = `${value}-${index}`
    if (seen.has(label) && ticks.length > 0 && !isLast) return
    seen.add(label)
    ticks.push({
      key,
      value,
      label,
      align: order === 0 ? 'start' : isLast ? 'end' : 'center',
      percent: isLast ? 100 : (index / buckets.length) * 100,
    })
  })
  return ticks
}

export type HistorySwimlaneSpanPaint = {
  key: string
  left: number
  width: number
  level: RequestAuditRiskLevel
  title: string
}

export type HistorySwimlanePaint = {
  spans: HistorySwimlaneSpanPaint[]
  title: string
}

export function paintHistorySwimlane(
  account: Pick<
    RequestAuditHistoryAccount,
    | 'buckets'
    | 'spans'
    | 'normalRequests'
    | 'watchRequests'
    | 'highRiskRequests'
  >
): HistorySwimlanePaint {
  const range = historyWindowRange(account.buckets)
  const source = historySpansForPaint(account)
  const minPercent =
    account.buckets.length > 0
      ? Math.max(1.5, 70 / account.buckets.length)
      : 2
  const spans: HistorySwimlaneSpanPaint[] = []
  if (range != null) {
    source.forEach((span, index) => {
      const startPercent = historyTimePercent(span.start, range.start, range.end)
      const endPercent = historyTimePercent(span.end, range.start, range.end)
      const naturalWidth = Math.max(0, endPercent - startPercent)
      const width = Math.max(naturalWidth, minPercent)
      let left =
        naturalWidth >= minPercent ? startPercent : startPercent - width / 2
      const previous = spans[spans.length - 1]
      if (previous && left < previous.left + previous.width) {
        left = previous.left + previous.width
      }
      left = Math.min(Math.max(0, left), Math.max(0, 100 - width))
      spans.push({
        key: `${span.start}-${span.end}-${span.level}-${index}`,
        left,
        width: Math.min(width, 100 - left),
        level: span.level,
        title: historySpanTitle(span),
      })
    })
  }
  return {
    spans,
    title: historySwimlaneTitle(account),
  }
}

export function historySwimlaneTitle(
  account: Pick<
    RequestAuditHistoryAccount,
    'normalRequests' | 'watchRequests' | 'highRiskRequests' | 'buckets'
  >
) {
  const parts = (
    [
      ['normal', account.normalRequests ?? 0],
      ['watch', account.watchRequests ?? 0],
      ['high', account.highRiskRequests ?? 0],
    ] as Array<[RequestAuditRiskLevel, number]>
  )
    .filter(([, count]) => count > 0)
    .map(
      ([level, count]) =>
        `${HISTORY_RISK_LEVEL_LABELS[level]} ${formatNumber(count, 0)} 次`
    )
  if (parts.length) return parts.join(' · ')
  if (account.buckets.length === 0) return '当前窗口没有时间格'
  return '当前窗口没有请求'
}

export function historyWindowRange(buckets: RequestAuditHistoryBucket[]) {
  if (buckets.length === 0) return null
  return {
    start: buckets[0].start,
    end: buckets[buckets.length - 1].end,
  }
}

function historySpansForPaint(
  account: Pick<RequestAuditHistoryAccount, 'buckets' | 'spans'>
): RequestAuditHistorySpan[] {
  if (account.spans?.length) return account.spans
  return account.buckets
    .filter((bucket) => bucket.dominant !== 'empty' && bucket.requests > 0)
    .map((bucket) => ({
      start: bucket.start,
      end: bucket.end,
      level:
        bucket.dominant === 'high'
          ? 'high'
          : bucket.dominant === 'watch'
            ? 'watch'
            : 'normal',
      requests: bucket.requests,
      successfulRequests: bucket.successfulRequests,
    }))
}

function historySpanTitle(span: RequestAuditHistorySpan) {
  const range = formatHistoryTimeRange(span.start, span.end)
  return `${HISTORY_RISK_LEVEL_LABELS[span.level]} · ${range} · ${formatNumber(span.requests, 0)} 次`
}

export function historyBucketTitle(bucket: RequestAuditHistoryBucket) {
  const range = formatHistoryTimeRange(bucket.start, bucket.end)
  if (bucket.dominant === 'empty' || bucket.requests <= 0) {
    return `${range}\n空档（没有请求）`
  }
  return [
    range,
    `成功 ${formatNumber(bucket.successfulRequests, 0)} / 失败 ${formatNumber(bucket.failedRequests, 0)}`,
    `正常 ${formatNumber(bucket.normalRequests, 0)} / 观察 ${formatNumber(bucket.watchRequests, 0)} / 高风险 ${formatNumber(bucket.highRiskRequests, 0)}`,
  ].join('\n')
}

function accountMatchesQuery(
  account: RequestAuditHistoryAccount,
  query: string
) {
  if (account.accountName.toLowerCase().includes(query)) return true
  if (account.accountId == null) return false
  const idText = String(account.accountId)
  return (
    idText === query ||
    `#${idText}` === query ||
    idText.includes(query) ||
    `#${idText}`.includes(query)
  )
}

function compareHistoryAccounts(
  left: RequestAuditHistoryAccount,
  right: RequestAuditHistoryAccount,
  sort: HistoryAccountSort
) {
  if (sort === 'still_abnormal') {
    const stillDiff = Number(right.stillAbnormal) - Number(left.stillAbnormal)
    if (stillDiff) return stillDiff
    const patternDiff =
      PATTERN_STILL_ABNORMAL_RANK[left.pattern] -
      PATTERN_STILL_ABNORMAL_RANK[right.pattern]
    if (patternDiff) return patternDiff
    const stateDiff =
      CURRENT_STATE_RANK[left.currentState] -
      CURRENT_STATE_RANK[right.currentState]
    if (stateDiff) return stateDiff
    const longestDiff =
      right.longestAbnormalMinutes - left.longestAbnormalMinutes
    if (longestDiff) return longestDiff
    const seenDiff = compareIsoDesc(left.lastAbnormalAt, right.lastAbnormalAt)
    if (seenDiff) return seenDiff
  }

  if (sort === 'recurrent') {
    const regularDiff = Number(right.regular) - Number(left.regular)
    const patternDiff =
      PATTERN_RECURRENT_RANK[left.pattern] -
      PATTERN_RECURRENT_RANK[right.pattern]
    if (patternDiff) return patternDiff
    if (regularDiff) return regularDiff
    const episodeDiff = right.abnormalEpisodes - left.abnormalEpisodes
    if (episodeDiff) return episodeDiff
    const longestDiff =
      right.longestAbnormalMinutes - left.longestAbnormalMinutes
    if (longestDiff) return longestDiff
  }

  if (sort === 'longest') {
    const longestDiff =
      right.longestAbnormalMinutes - left.longestAbnormalMinutes
    if (longestDiff) return longestDiff
    const totalDiff = right.totalAbnormalMinutes - left.totalAbnormalMinutes
    if (totalDiff) return totalDiff
    const stillDiff = Number(right.stillAbnormal) - Number(left.stillAbnormal)
    if (stillDiff) return stillDiff
  }

  if (sort === 'slow_recovery') {
    const recoveryDiff = recoveryScore(right) - recoveryScore(left)
    if (recoveryDiff) return recoveryDiff
    const longestDiff =
      right.longestAbnormalMinutes - left.longestAbnormalMinutes
    if (longestDiff) return longestDiff
  }

  if (sort === 'always_normal') {
    const rankDiff = alwaysNormalRank(left) - alwaysNormalRank(right)
    if (rankDiff) return rankDiff
    const successDiff = right.successRate - left.successRate
    if (successDiff) return successDiff
  }

  if (sort === 'recent') {
    const seenDiff = compareIsoDesc(left.lastSeenAt, right.lastSeenAt)
    if (seenDiff) return seenDiff
  }

  const requestDiff = right.requests - left.requests
  if (requestDiff) return requestDiff
  const lastSeenDiff = compareIsoDesc(left.lastSeenAt, right.lastSeenAt)
  if (lastSeenDiff) return lastSeenDiff
  const nameDiff = historyAccountDisplayName(left).localeCompare(
    historyAccountDisplayName(right),
    'zh'
  )
  if (nameDiff) return nameDiff
  return (left.accountId ?? 0) - (right.accountId ?? 0)
}

function alwaysNormalRank(account: RequestAuditHistoryAccount) {
  if (account.alwaysNormal || account.pattern === 'always_normal') return 0
  if (account.recovered) return 1
  if (account.pattern === 'sparse') return 2
  if (account.pattern === 'occasional') return 3
  if (account.pattern === 'recurrent') return 4
  if (account.stillAbnormal || account.pattern === 'still_abnormal') return 5
  return 6
}

function recoveryScore(account: RequestAuditHistoryAccount) {
  if (account.stillAbnormal) return Number.POSITIVE_INFINITY
  return account.medianRecoveryMinutes ?? account.lastRecoveryMinutes ?? -1
}

function compareIsoDesc(left: string | null, right: string | null) {
  const leftValue = left?.trim() || ''
  const rightValue = right?.trim() || ''
  if (leftValue === rightValue) return 0
  if (!leftValue) return 1
  if (!rightValue) return -1
  return rightValue.localeCompare(leftValue)
}

function shanghaiParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HISTORY_TIMEZONE,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return {
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
  }
}
