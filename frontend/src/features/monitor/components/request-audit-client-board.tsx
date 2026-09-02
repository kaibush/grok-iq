import { KeyRound } from 'lucide-react'
import { type RequestAuditClientKeyOption } from '@/lib/api'
import { cn, formatNumber, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { InfoTooltip } from '@/components/info-tooltip'

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

export function RequestAuditClientBoard({
  items,
  selectedId,
  loading = false,
  onSelect,
}: {
  items: RequestAuditClientKeyOption[]
  selectedId: string
  loading?: boolean
  onSelect: (id: string) => void
}) {
  const totalRequests = items.reduce(
    (sum, item) => sum + (item.requestCount ?? 0),
    0
  )
  const maxCount = Math.max(
    1,
    ...items.map((item) => item.requestCount ?? 0)
  )
  const selected = selectedId !== 'all'

  if (!loading && items.length === 0) return null

  return (
    <section className='border-b px-4 py-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-2'>
          <KeyRound className='size-3.5 text-muted-foreground' />
          <span className='text-sm font-medium'>活跃客户端</span>
          <InfoTooltip
            label='活跃客户端'
            content='当前分析窗口内发过请求的客户端 Key。忙碌程度按窗口内请求量相对比较：条越长越忙，不是任务进度。点击卡片会按该 Key 过滤流水。'
          />
          {loading ? (
            <Skeleton className='h-5 w-24 rounded-full' />
          ) : (
            <span className='text-[11px] text-muted-foreground'>
              {formatNumber(items.length, 0)} 个 · {formatNumber(totalRequests, 0)}{' '}
              次
            </span>
          )}
        </div>
        {selected ? (
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='h-7 px-2 text-xs'
            onClick={() => onSelect('all')}
          >
            清除 Key 筛选
          </Button>
        ) : null}
      </div>
      {loading ? (
        <div className='mt-3 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2'>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className='h-[4.75rem] rounded-lg' />
          ))}
        </div>
      ) : (
        <div
          className='mt-3 grid max-h-56 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2 overflow-y-auto'
          role='list'
          aria-label='当前窗口活跃客户端'
        >
          {items.map((item) => {
            const active = item.id === selectedId
            const label =
              item.name ||
              (item.id === 'unlabeled' ? '未记录 Key' : `#${item.id}`)
            const count = item.requestCount ?? 0
            const level = clientBusyLevel(
              count,
              totalRequests,
              maxCount,
              items.length
            )
            const share = Math.max(0.06, count / maxCount)
            return (
              <button
                key={item.id}
                type='button'
                role='listitem'
                aria-pressed={active}
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-left transition-colors',
                  active
                    ? 'border-primary/40 bg-primary/8'
                    : 'bg-muted/20 hover:bg-muted/40'
                )}
                onClick={() => onSelect(active ? 'all' : item.id)}
              >
                <div className='flex items-start justify-between gap-3'>
                  <div className='min-w-0'>
                    <div className='flex min-w-0 items-center gap-1.5'>
                      <span className='truncate text-sm font-medium'>{label}</span>
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                          level === 'busy' &&
                            'bg-amber-500/15 text-amber-700 dark:text-amber-300',
                          level === 'warm' &&
                            'bg-sky-500/12 text-sky-700 dark:text-sky-300',
                          level === 'normal' &&
                            'bg-muted text-muted-foreground',
                          level === 'quiet' &&
                            'bg-muted text-muted-foreground'
                        )}
                      >
                        {BUSY_LABEL[level]}
                      </span>
                    </div>
                    <div className='mt-0.5 truncate text-[11px] text-muted-foreground'>
                      {item.id !== 'unlabeled' && item.name
                        ? `#${item.id}`
                        : '未记录身份'}
                      {item.lastSeenAt
                        ? ` · ${formatRelativeTime(item.lastSeenAt)}`
                        : ''}
                    </div>
                  </div>
                  <div className='shrink-0 text-right'>
                    <div className='font-mono text-sm font-semibold tabular-nums'>
                      {formatNumber(count, 0)}
                    </div>
                    <div className='text-[10px] text-muted-foreground'>次</div>
                  </div>
                </div>
                <div className='mt-2'>
                  <div className='mb-1 flex items-center justify-between text-[10px] text-muted-foreground'>
                    <span>相对忙碌</span>
                    <span>
                      {Math.round((count / maxCount) * 100)}%
                    </span>
                  </div>
                  <div
                    className='h-1 overflow-hidden rounded-full bg-background/80'
                    aria-label={`相对忙碌 ${Math.round((count / maxCount) * 100)}%`}
                  >
                    <div
                      className={cn(
                        'h-full rounded-full',
                        level === 'busy' && 'bg-amber-500',
                        level === 'warm' && 'bg-sky-500',
                        (level === 'normal' || level === 'quiet') &&
                          'bg-foreground/20'
                      )}
                      style={{ width: `${Math.round(share * 100)}%` }}
                    />
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
