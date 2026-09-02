import { KeyRound } from 'lucide-react'
import { type RequestAuditClientKeyOption } from '@/lib/api'
import { cn, formatNumber, formatRelativeTime } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { TitledCard } from '@/components/titled-card'

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

  return (
    <TitledCard
      icon={<KeyRound />}
      iconTone='sky'
      title='当前窗口活跃客户端'
      description='展示这个分析窗口里发过请求的客户端 Key。点击卡片会套用和筛选条件相同的 Key 过滤；再点一次可取消。'
      hint='数据来自当前分析窗口的请求流水，不限本页。次数是该 Key 在窗口内的请求数。'
      contentClassName='space-y-3'
    >
      <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
        <span>{formatNumber(items.length, 0)} 个客户端</span>
        <span>{formatNumber(totalRequests, 0)} 次请求</span>
        {selected ? <span>已按客户端 Key 过滤流水</span> : null}
      </div>
      {loading ? (
        <div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className='h-16 rounded-xl' />
          ))}
        </div>
      ) : items.length ? (
        <div
          className='grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
          role='list'
          aria-label='当前窗口活跃客户端'
        >
          <button
            type='button'
            role='listitem'
            aria-pressed={!selected}
            className={cn(
              'flex min-h-16 flex-col justify-center rounded-xl border px-3 py-2 text-left transition-colors',
              !selected
                ? 'border-primary bg-primary/5 ring-2 ring-inset ring-primary'
                : 'bg-background hover:bg-muted/45'
            )}
            onClick={() => onSelect('all')}
          >
            <span className='text-sm font-medium'>全部客户端</span>
            <span className='mt-0.5 text-[11px] text-muted-foreground'>
              {formatNumber(items.length, 0)} 个 Key ·{' '}
              {formatNumber(totalRequests, 0)} 次
            </span>
          </button>
          {items.map((item) => {
            const active = item.id === selectedId
            const label = item.name || (item.id === 'unlabeled' ? '未记录 Key' : `#${item.id}`)
            return (
              <button
                key={item.id}
                type='button'
                role='listitem'
                aria-pressed={active}
                className={cn(
                  'flex min-h-16 flex-col justify-center rounded-xl border px-3 py-2 text-left transition-colors',
                  active
                    ? 'border-primary bg-primary/5 ring-2 ring-inset ring-primary'
                    : 'bg-background hover:bg-muted/45'
                )}
                onClick={() => onSelect(active ? 'all' : item.id)}
              >
                <span className='truncate text-sm font-medium'>{label}</span>
                <span className='mt-0.5 truncate text-[11px] text-muted-foreground'>
                  {item.id !== 'unlabeled' && item.name ? `#${item.id} · ` : ''}
                  {formatNumber(item.requestCount ?? 0, 0)} 次
                  {item.lastSeenAt
                    ? ` · ${formatRelativeTime(item.lastSeenAt)}`
                    : ''}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <p className='text-sm text-muted-foreground'>
          当前分析窗口还没有客户端请求。
        </p>
      )}
    </TitledCard>
  )
}
