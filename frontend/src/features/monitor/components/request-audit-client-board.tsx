import { memo, useDeferredValue, useMemo } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { type RequestAuditClientKeyOption } from '@/lib/api'
import { cn, formatNumber, formatRelativeTime } from '@/lib/utils'
import { usePersistedViewState } from '@/hooks/use-persisted-view-state'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { InfoTooltip } from '@/components/info-tooltip'
import { SegmentedControl } from '@/components/segmented-control'
import {
  NORMAL_RATE_HINT,
  formatRatePercent,
  normalRateClass,
  requestQualityParts,
} from '@/features/monitor/components/request-audit-quality'

type BusyLevel = 'busy' | 'warm' | 'normal' | 'quiet'

const BUSY_LABEL: Record<BusyLevel, string> = {
  busy: '忙碌',
  warm: '较忙',
  normal: '一般',
  quiet: '空闲',
}

function clientBusyLevel(
  count: number,
  total: number,
  maxCount: number,
  keyCount: number
): BusyLevel {
  if (count <= 0) return 'quiet'
  if (total <= 0 || maxCount <= 0) return 'normal'
  if (keyCount <= 1) return 'busy'
  const share = count / total
  const vsMax = count / maxCount
  const vsAvg = count / (total / keyCount)
  if (vsMax >= 0.8 || share >= 0.4 || vsAvg >= 2) return 'busy'
  if (vsMax >= 0.4 || share >= 0.18 || vsAvg >= 1.25) return 'warm'
  return 'normal'
}

function clientQuality(item: RequestAuditClientKeyOption) {
  return requestQualityParts(
    item.requestCount ?? 0,
    item.watchRequests ?? 0,
    item.highRiskRequests ?? 0
  )
}

type ClientSort = 'requests' | 'recent'

const CLIENT_SORT_STORAGE_KEY = 'grokiq.monitor.request-audit-client-sort.v1'
const CLIENT_SORT_OPTIONS: Array<{ value: ClientSort; label: string }> = [
  { value: 'requests', label: '请求量' },
  { value: 'recent', label: '活跃时间' },
]

function lastSeenValue(item: RequestAuditClientKeyOption) {
  return item.lastSeenAt?.trim() || ''
}

function compareClientItems(
  left: RequestAuditClientKeyOption,
  right: RequestAuditClientKeyOption,
  sort: ClientSort
) {
  if (sort === 'recent') {
    const leftSeen = lastSeenValue(left)
    const rightSeen = lastSeenValue(right)
    if (leftSeen !== rightSeen) {
      if (!leftSeen) return 1
      if (!rightSeen) return -1
      return rightSeen.localeCompare(leftSeen)
    }
  }
  const countDiff = (right.requestCount ?? 0) - (left.requestCount ?? 0)
  if (countDiff) return countDiff
  if (left.id === 'unlabeled') return 1
  if (right.id === 'unlabeled') return -1
  return (left.name || left.id).localeCompare(right.name || right.id, 'zh')
}

type ClientCardModel = {
  item: RequestAuditClientKeyOption
  label: string
  identity: string
  lastSeenLabel: string
  count: number
  countLabel: string
  qualityLabel: string
  qualityClassName: string
  level: BusyLevel
  busyPercent: number
  barWidth: number
}

const RequestAuditClientCard = memo(function RequestAuditClientCard({
  model,
  active,
  onSelect,
  onPrefetch,
}: {
  model: ClientCardModel
  active: boolean
  onSelect: (id: string) => void
  onPrefetch?: (id: string) => void
}) {
  const targetId = active ? 'all' : model.item.id
  return (
    <button
      type='button'
      role='listitem'
      aria-pressed={active}
      className={cn(
        'rounded-lg border px-3 py-2.5 text-left transition-colors [contain-intrinsic-size:auto_5.25rem] [content-visibility:auto]',
        active
          ? 'border-primary/40 bg-primary/8'
          : 'bg-muted/20 hover:bg-muted/40'
      )}
      onPointerEnter={() => onPrefetch?.(targetId)}
      onFocus={() => onPrefetch?.(targetId)}
      onClick={() => onSelect(targetId)}
    >
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex min-w-0 items-center gap-1.5'>
            <span className='truncate text-sm font-medium'>{model.label}</span>
            <span
              className={cn(
                'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                model.level === 'busy' &&
                  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
                model.level === 'warm' &&
                  'bg-sky-500/12 text-sky-700 dark:text-sky-300',
                model.level === 'normal' && 'bg-muted text-muted-foreground',
                model.level === 'quiet' && 'bg-muted text-muted-foreground'
              )}
            >
              {BUSY_LABEL[model.level]}
            </span>
          </div>
          <div className='mt-0.5 truncate text-[11px] text-muted-foreground'>
            {model.identity}
            {model.lastSeenLabel ? ` · ${model.lastSeenLabel}` : ''}
          </div>
        </div>
        <div className='shrink-0 text-right'>
          <div className='font-mono text-sm font-semibold tabular-nums'>
            {model.countLabel}
          </div>
          <div
            className={cn(
              'mt-0.5 rounded px-1 py-px text-[10px] font-semibold tabular-nums',
              model.qualityClassName
            )}
          >
            {model.qualityLabel}
          </div>
        </div>
      </div>
      <div className='mt-2'>
        <div className='mb-1 flex items-center justify-between text-[10px] text-muted-foreground'>
          <span>相对忙碌</span>
          <span>{model.busyPercent}%</span>
        </div>
        <div
          className='h-1 overflow-hidden rounded-full bg-background/80'
          aria-label={`相对忙碌 ${model.busyPercent}%`}
        >
          <div
            className={cn(
              'h-full rounded-full',
              model.level === 'busy' && 'bg-amber-500',
              model.level === 'warm' && 'bg-sky-500',
              (model.level === 'normal' || model.level === 'quiet') &&
                'bg-foreground/20'
            )}
            style={{ width: `${model.barWidth}%` }}
          />
        </div>
      </div>
    </button>
  )
})

export function RequestAuditClientBoard({
  items,
  selectedId,
  loading = false,
  onSelect,
  onPrefetch,
}: {
  items: RequestAuditClientKeyOption[]
  selectedId: string
  loading?: boolean
  onSelect: (id: string) => void
  onPrefetch?: (id: string) => void
}) {
  const sortView = usePersistedViewState(CLIENT_SORT_STORAGE_KEY, {
    sort: 'requests' as ClientSort,
  })
  const sort = sortView.value.sort === 'recent' ? 'recent' : 'requests'
  const deferredSort = useDeferredValue(sort)
  const sortPending = deferredSort !== sort
  const totalRequests = useMemo(
    () => items.reduce((sum, item) => sum + (item.requestCount ?? 0), 0),
    [items]
  )
  const cardModels = useMemo(() => {
    const maxCount = Math.max(1, ...items.map((item) => item.requestCount ?? 0))
    return items.map((item) => {
      const count = item.requestCount ?? 0
      const quality = clientQuality(item)
      const level = clientBusyLevel(
        count,
        totalRequests,
        maxCount,
        items.length
      )
      return {
        item,
        label:
          item.name || (item.id === 'unlabeled' ? '未记录 Key' : `#${item.id}`),
        identity:
          item.id !== 'unlabeled' && item.name ? `#${item.id}` : '未记录身份',
        lastSeenLabel: item.lastSeenAt
          ? formatRelativeTime(item.lastSeenAt)
          : '',
        count,
        countLabel: formatNumber(count, 0),
        qualityLabel: formatRatePercent(quality.normal, quality.requests),
        qualityClassName: normalRateClass(
          quality.normalShare,
          quality.requests
        ),
        level,
        busyPercent: Math.round((count / maxCount) * 100),
        barWidth: Math.round(Math.max(0.06, count / maxCount) * 100),
      } satisfies ClientCardModel
    })
  }, [items, totalRequests])
  const sortedModels = useMemo(
    () =>
      [...cardModels].sort((left, right) =>
        compareClientItems(left.item, right.item, deferredSort)
      ),
    [cardModels, deferredSort]
  )
  const selected = selectedId !== 'all'
  const selectedItem = selected
    ? items.find((item) => item.id === selectedId)
    : undefined
  const selectedQuality = selectedItem ? clientQuality(selectedItem) : null

  if (!loading && items.length === 0) return null

  return (
    <section className='border-b px-4 py-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-2'>
          <KeyRound className='size-3.5 text-muted-foreground' />
          <span className='text-sm font-medium'>活跃客户端</span>
          <InfoTooltip
            label='活跃客户端'
            content={`当前分析窗口内发过请求的客户端 Key。可按请求量或最近活跃时间排序。忙碌程度按窗口内请求量相对比较：条越长越忙，不是任务进度。点击卡片会按该 Key 过滤流水，并展示该 Key 在同一窗口内的正常率 / 异常率。${NORMAL_RATE_HINT}`}
          />
          {loading ? (
            <Skeleton className='h-5 w-24 rounded-full' />
          ) : (
            <span className='text-[11px] text-muted-foreground'>
              {formatNumber(items.length, 0)} 个 ·{' '}
              {formatNumber(totalRequests, 0)} 次
            </span>
          )}
        </div>
        <div className='flex flex-wrap items-center justify-end gap-2'>
          <SegmentedControl
            ariaLabel='活跃客户端排序'
            value={sort}
            onChange={(value) => sortView.setValue({ sort: value })}
            options={CLIENT_SORT_OPTIONS}
          />
          {selected ? (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7 px-2 text-xs'
              onPointerEnter={() => onPrefetch?.('all')}
              onClick={() => onSelect('all')}
            >
              清除 Key 筛选
            </Button>
          ) : null}
        </div>
      </div>
      {loading ? (
        <div className='mt-3 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2'>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className='h-[5.25rem] rounded-lg' />
          ))}
        </div>
      ) : (
        <div className='relative mt-3' aria-busy={sortPending}>
          <div
            className={cn(
              'grid max-h-56 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2 overflow-y-auto',
              sortPending && 'pointer-events-none opacity-60'
            )}
            role='list'
            aria-label='当前窗口活跃客户端'
          >
            {sortedModels.map((model) => (
              <RequestAuditClientCard
                key={model.item.id}
                model={model}
                active={model.item.id === selectedId}
                onSelect={onSelect}
                onPrefetch={onPrefetch}
              />
            ))}
          </div>
          {sortPending ? (
            <div
              className='absolute inset-0 z-10 flex items-center justify-center rounded-md bg-background/65 backdrop-blur-[1px]'
              role='status'
              aria-live='polite'
            >
              <div className='flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm'>
                <Loader2 className='size-3.5 animate-spin text-primary' />
                {sort === 'recent' ? '正在按活跃时间排序' : '正在按请求量排序'}
              </div>
            </div>
          ) : null}
        </div>
      )}
      {selectedQuality ? (
        <div className='mt-3 rounded-lg border bg-background px-3 py-2.5'>
          <div className='flex items-center justify-between gap-3'>
            <div className='min-w-0'>
              <div className='truncate text-sm font-medium'>
                {selectedItem?.name ||
                  (selectedItem?.id === 'unlabeled'
                    ? '未记录 Key'
                    : `#${selectedItem?.id}`)}
                <span className='ml-1.5 text-[11px] font-normal text-muted-foreground'>
                  当前窗口质量
                </span>
              </div>
              <div className='mt-0.5 text-[11px] text-muted-foreground'>
                {formatNumber(selectedQuality.requests, 0)} 次 · 异常{' '}
                {formatRatePercent(
                  selectedQuality.abnormal,
                  selectedQuality.requests
                )}
                {selectedQuality.abnormal > 0
                  ? ` · 观察 ${formatNumber(selectedQuality.watchRequests, 0)} · 高风险 ${formatNumber(selectedQuality.highRiskRequests, 0)}`
                  : ''}
              </div>
            </div>
            <span
              className={cn(
                'shrink-0 rounded-md px-1.5 py-0.5 text-sm font-semibold tabular-nums',
                normalRateClass(
                  selectedQuality.normalShare,
                  selectedQuality.requests
                )
              )}
            >
              {formatRatePercent(
                selectedQuality.normal,
                selectedQuality.requests
              )}
            </span>
          </div>
          <div className='mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted'>
            <span
              className='bg-emerald-500'
              style={{ width: `${selectedQuality.normalShare}%` }}
            />
            <span
              className='bg-amber-500'
              style={{ width: `${selectedQuality.watchShare}%` }}
            />
            <span
              className='bg-rose-500'
              style={{ width: `${selectedQuality.highShare}%` }}
            />
          </div>
        </div>
      ) : null}
    </section>
  )
}
