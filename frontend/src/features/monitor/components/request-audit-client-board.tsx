import { KeyRound } from 'lucide-react'
import { type RequestAuditClientKeyOption } from '@/lib/api'
import { cn, formatNumber, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { InfoTooltip } from '@/components/info-tooltip'

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
            content='当前分析窗口内发过请求的客户端 Key。点击后会按该 Key 过滤流水，再点一次或点清除即可取消。'
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
            <Skeleton key={index} className='h-14 rounded-lg' />
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
                    <div className='truncate text-sm font-medium'>{label}</div>
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
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
