import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarDays,
  CircleCheck,
  Clock3,
  Hourglass,
  PowerOff,
  ShieldBan,
  Timer,
  TimerReset,
  UsersRound,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api, type CooldownStatsResponse } from '@/lib/api'
import { formatNumber, getErrorMessage } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/segmented-control'
import { MetricStrip } from '@/components/stat-card'
import { TitledCard } from '@/components/titled-card'
import { formatRemainingDuration } from '@/features/monitor/components/cooldown-remaining'

export type CooldownStatsPreset = 'today' | '24h' | '7d' | '30d' | 'custom'

export type CooldownStatsView = {
  preset: CooldownStatsPreset
  from: string
  to: string
}

export const COOLDOWN_STATS_VIEW_KEY = 'grokiq.monitor.cooldown-stats.v2'
export const defaultCooldownStatsView: CooldownStatsView = {
  preset: '7d',
  from: '',
  to: '',
}

const PRESETS: Array<{
  value: Exclude<CooldownStatsPreset, 'custom'>
  label: string
  icon?: typeof CalendarDays
}> = [
  { value: 'today', label: '今天', icon: CalendarDays },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
]

export function cooldownStatsRange(view: CooldownStatsView) {
  return rangeForPreset(view.preset, view.from, view.to)
}

export function cooldownStatsRangeIso(view: CooldownStatsView) {
  const range = cooldownStatsRange(view)
  return {
    from: toIsoDateTime(range.from),
    to: toIsoDateTime(range.to),
    range,
  }
}

export function cooldownStatsRangeLabel(view: CooldownStatsView) {
  const preset = PRESETS.find((item) => item.value === view.preset)
  if (preset) return preset.label
  const range = cooldownStatsRange(view)
  if (range.from && range.to) {
    return `${range.from.replace('T', ' ')} — ${range.to.replace('T', ' ')}`
  }
  return '自定义时间'
}

export function CooldownStatsBoard({
  view,
  onViewChange,
  source = 'local',
}: {
  view: CooldownStatsView
  onViewChange: (next: CooldownStatsView) => void
  source?: 'local' | 'grok2api'
}) {
  const { preset, from, to } = view
  const range = useMemo(
    () => rangeForPreset(preset, from, to),
    [from, preset, to]
  )
  const fromIso = toIsoDateTime(range.from)
  const toIso = toIsoDateTime(range.to)
  const grokSource = source === 'grok2api'
  const query = useQuery({
    queryKey: grokSource
      ? ['accounts', 'cooldown-stats', source]
      : ['accounts', 'cooldown-stats', source, fromIso, toIso],
    queryFn: ({ signal }) =>
      api.cooldownStats(
        grokSource ? { source } : { from: fromIso, to: toIso, source },
        signal
      ),
    enabled: grokSource || Boolean(fromIso && toIso && fromIso <= toIso),
  })
  const data = query.data
  const invalidRange =
    !grokSource && Boolean(fromIso && toIso && fromIso > toIso)
  const policy = grokSource ? undefined : data?.policy

  return (
    <TitledCard
      icon={<Timer />}
      iconTone='amber'
      title={grokSource ? '上游同步看板' : '本系统冷却看板'}
      description={
        grokSource
          ? '实时读取 grok2api 缺思考记录：定时停用、永久停用、已启用和累计命中次数。'
          : '看当前正在冷却的账号，以及所选时间内发生了多少次高速 TPS 冷却。'
      }
      hint={
        grokSource
          ? '打开页面时直接查询 grok2api 缺思考接口。解除冷却会立即启用上游账号，不会改本地隔离状态。'
          : '冷却是临时停用，到期自动恢复调度，不会进隔离区。冷却后再连续达到次数才会永久停用。'
      }
      action={
        grokSource ? null : (
          <div className='flex min-w-0 flex-col gap-2 sm:items-end'>
            <SegmentedControl
              ariaLabel='冷却看板时间范围'
              value={preset}
              onChange={(next) => {
                const rangeNext = rangeForPreset(next, '', '')
                onViewChange({
                  preset: next,
                  from: rangeNext.from,
                  to: rangeNext.to,
                })
              }}
              options={PRESETS}
            />
            <div className='grid w-full gap-2 sm:w-auto sm:grid-cols-2'>
              <label className='grid gap-1'>
                <span className='text-[11px] text-muted-foreground'>开始</span>
                <Input
                  type='datetime-local'
                  value={range.from}
                  max={range.to || undefined}
                  onChange={(event) =>
                    onViewChange({
                      preset: 'custom',
                      from: event.target.value,
                      to: range.to,
                    })
                  }
                  className='h-8 rounded-lg text-xs'
                  aria-label='统计开始时间'
                />
              </label>
              <label className='grid gap-1'>
                <span className='text-[11px] text-muted-foreground'>结束</span>
                <Input
                  type='datetime-local'
                  value={range.to}
                  min={range.from || undefined}
                  onChange={(event) =>
                    onViewChange({
                      preset: 'custom',
                      from: range.from,
                      to: event.target.value,
                    })
                  }
                  className='h-8 rounded-lg text-xs'
                  aria-label='统计结束时间'
                />
              </label>
            </div>
          </div>
        )
      }
      contentClassName='space-y-4'
    >
      {invalidRange ? (
        <p className='text-sm text-destructive'>结束时间不能早于开始时间</p>
      ) : query.isError ? (
        <p className='text-sm text-destructive'>
          {getErrorMessage(query.error)}
        </p>
      ) : (
        <>
          {policy ? (
            <p className='text-xs text-muted-foreground'>
              连续 {formatNumber(policy.minCount, 0)} 次高速 TPS 后冷却{' '}
              {formatNumber(policy.cooldownMinutes, 0)} 分钟
            </p>
          ) : null}
          <MetricStrip
            loading={query.isLoading}
            items={[
              {
                icon: Timer,
                tone: 'amber',
                label: grokSource ? '定时停用' : '当前冷却中',
                value: formatNumber(data?.zone.cooling ?? 0, 0),
                hint: grokSource
                  ? 'grok2api 当前因缺思考定时停用、到期后会自动恢复的账号。'
                  : '当前仍在本系统高速 TPS 冷却窗口内、尚未到期恢复的账号。',
              },
              {
                icon: Clock3,
                tone: 'cyan',
                label: grokSource ? '即将恢复' : '即将结束',
                value: formatNumber(data?.zone.expiringSoon ?? 0, 0),
                detail: '2 分钟内',
                hint: grokSource
                  ? '定时停用中剩余不超过 2 分钟，或 grok2api 已标记即将恢复的账号。'
                  : '剩余不超过 2 分钟的冷却账号。',
              },
              {
                icon: PowerOff,
                tone: 'violet' as const,
                label: grokSource ? '永久停用' : '本次由系统停用',
                value: formatNumber(data?.zone.disabledByCooldown ?? 0, 0),
                hint: grokSource
                  ? '因缺思考被 grok2api 永久停用、需要手动启用的账号。'
                  : '冷却开始时由本系统停用上游、到期会自动重新启用的账号。',
              },
              {
                icon: Hourglass,
                tone: 'sky',
                label: '平均剩余',
                value: formatRemainingDuration(
                  data?.zone.avgRemainingSeconds ?? null
                ),
                hint: '当前冷却中账号的平均剩余时长。',
              },
            ]}
          />
          <MetricStrip
            loading={query.isLoading}
            items={[
              {
                icon: TimerReset,
                tone: 'amber',
                label: grokSource ? '累计缺思考次数' : '区间内冷却次数',
                value: formatNumber(data?.events.cooled ?? 0, 0),
                hint: grokSource
                  ? 'grok2api 缺思考记录的累计命中次数。'
                  : '所选时间内发生的高速 TPS 冷却次数，同一账号可能多次冷却。',
              },
              {
                icon: UsersRound,
                tone: 'blue',
                label: '涉及账号',
                value: formatNumber(data?.events.uniqueAccounts ?? 0, 0),
                hint: grokSource
                  ? 'grok2api 缺思考历史覆盖的账号数。'
                  : '所选时间内至少冷却过一次的去重账号数。',
              },
              {
                icon: CircleCheck,
                tone: 'emerald',
                label: grokSource ? '已启用' : '区间内已结束',
                value: formatNumber(data?.events.expired ?? 0, 0),
                hint: grokSource
                  ? '缺思考历史中当前已重新启用的账号。'
                  : '所选时间内到期或被提前结束的冷却次数。',
              },
              {
                icon: ShieldBan,
                tone: 'rose',
                label: grokSource ? '上游已删除' : '冷却后已隔离',
                value: formatNumber(data?.events.isolatedAfter ?? 0, 0),
                hint: grokSource
                  ? '缺思考历史中账号已在 grok2api 删除的记录。'
                  : '冷却结束后又连续高速 TPS，被永久停用并移入隔离区的账号。',
              },
            ]}
          />
          {!grokSource && (data?.trend.length ?? 0) > 1 ? (
            <TrendChart data={data?.trend ?? []} />
          ) : null}
        </>
      )}
    </TitledCard>
  )
}

function TrendChart({ data }: { data: CooldownStatsResponse['trend'] }) {
  return (
    <div className='h-56 rounded-xl border p-3'>
      <ResponsiveContainer width='100%' height='100%'>
        <AreaChart data={data} margin={{ left: -20, right: 8, top: 8 }}>
          <CartesianGrid
            strokeDasharray='3 3'
            vertical={false}
            stroke='var(--border)'
          />
          <XAxis
            dataKey='day'
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            contentStyle={{
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--popover)',
              fontSize: 12,
            }}
          />
          <Area
            type='monotone'
            dataKey='cooled'
            name='冷却'
            stroke='var(--chart-2)'
            fill='var(--chart-2)'
            fillOpacity={0.12}
            strokeWidth={2}
          />
          <Area
            type='monotone'
            dataKey='expired'
            name='已结束'
            stroke='var(--chart-3)'
            fill='transparent'
            strokeWidth={1.5}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function rangeForPreset(preset: CooldownStatsPreset, from: string, to: string) {
  if (preset === 'today') return localDayRange(new Date())
  if (preset === '24h') return recentHoursRange(24)
  if (preset === '7d') return recentHoursRange(24 * 7)
  if (preset === '30d') return recentHoursRange(24 * 30)
  return { from, to }
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

function toIsoDateTime(value: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}
