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
    queryKey: ['accounts', 'cooldown-stats', source, fromIso, toIso],
    queryFn: ({ signal }) =>
      api.cooldownStats({ from: fromIso, to: toIso, source }, signal),
    enabled: Boolean(fromIso && toIso && fromIso <= toIso),
  })
  const data = query.data
  const invalidRange = Boolean(fromIso && toIso && fromIso > toIso)
  const policy = grokSource ? undefined : data?.policy

  return (
    <TitledCard
      icon={<Timer />}
      iconTone='amber'
      title={grokSource ? '上游同步看板' : '本系统冷却看板'}
      description={
        grokSource
          ? '看后台定时任务同步下来的 grok2api 缺思考冷却，以及所选时间内写入或结束了多少条。'
          : '看当前正在冷却的账号，以及所选时间内发生了多少次高速 TPS 冷却。'
      }
      hint={
        grokSource
          ? '上游同步只读本地库，不会在打开页面时现拉 grok2api。提前结束会清除上游冷却，不会改启用状态。'
          : '冷却是临时停用，到期自动恢复调度，不会进隔离区。冷却后再连续达到次数才会永久停用。'
      }
      action={
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
                label: '当前冷却中',
                value: formatNumber(data?.zone.cooling ?? 0, 0),
                hint: grokSource
                  ? '当前仍在 grok2api 降智冷却窗口内、尚未到期的账号。'
                  : '当前仍在本系统高速 TPS 冷却窗口内、尚未到期恢复的账号。',
              },
              {
                icon: Clock3,
                tone: 'cyan',
                label: '即将结束',
                value: formatNumber(data?.zone.expiringSoon ?? 0, 0),
                detail: '2 分钟内',
                hint: '剩余不超过 2 分钟的冷却账号。',
              },
              ...(grokSource
                ? []
                : [
                    {
                      icon: PowerOff,
                      tone: 'violet' as const,
                      label: '本次由系统停用',
                      value: formatNumber(data?.zone.disabledByCooldown ?? 0, 0),
                      hint: '冷却开始时由本系统停用上游、到期会自动重新启用的账号。',
                    },
                  ]),
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
                label: '区间内冷却次数',
                value: formatNumber(data?.events.cooled ?? 0, 0),
                hint: grokSource
                  ? '所选时间内同步到本地的降智冷却次数，同一账号只保留最新一次。'
                  : '所选时间内发生的高速 TPS 冷却次数，同一账号可能多次冷却。',
              },
              {
                icon: UsersRound,
                tone: 'blue',
                label: '涉及账号',
                value: formatNumber(data?.events.uniqueAccounts ?? 0, 0),
                hint: '所选时间内至少冷却过一次的去重账号数。',
              },
              {
                icon: CircleCheck,
                tone: 'emerald',
                label: '区间内已结束',
                value: formatNumber(data?.events.expired ?? 0, 0),
                hint: '所选时间内到期或被提前结束的冷却次数。',
              },
              {
                icon: ShieldBan,
                tone: 'rose',
                label: '冷却后已隔离',
                value: formatNumber(data?.events.isolatedAfter ?? 0, 0),
                hint: grokSource
                  ? '这些同步冷却账号当前已在隔离区。'
                  : '冷却结束后又连续高速 TPS，被永久停用并移入隔离区的账号。',
              },
            ]}
          />
          {(data?.trend.length ?? 0) > 1 ? (
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
