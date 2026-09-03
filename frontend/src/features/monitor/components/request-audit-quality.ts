import { formatNumber } from '@/lib/utils'

export const NORMAL_RATE_BANDS = [
  {
    min: 95,
    label: '≥95%',
    swatch: 'bg-emerald-500',
    className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  {
    min: 80,
    label: '≥80%',
    swatch: 'bg-sky-500',
    className: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  },
  {
    min: 60,
    label: '≥60%',
    swatch: 'bg-amber-500',
    className: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  },
  {
    min: 40,
    label: '≥40%',
    swatch: 'bg-orange-500',
    className: 'bg-orange-500/12 text-orange-700 dark:text-orange-300',
  },
  {
    min: 0,
    label: '<40%',
    swatch: 'bg-rose-500',
    className: 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
  },
] as const

export const NORMAL_RATE_HINT =
  '百分比是正常率，越高越健康，按区间上色：绿 ≥95%、蓝 ≥80%、黄 ≥60%、橙 ≥40%、红 <40%。'

export function formatRatePercent(part: number, total: number) {
  if (total <= 0) return '—'
  const percent = (part / total) * 100
  if (percent <= 0) return '0%'
  if (percent >= 100) return '100%'
  return `${formatNumber(percent, 1)}%`
}

export function normalRateClass(normalShare: number, requests: number) {
  if (requests <= 0) return 'text-muted-foreground'
  return (
    NORMAL_RATE_BANDS.find((band) => normalShare >= band.min)?.className ??
    NORMAL_RATE_BANDS[NORMAL_RATE_BANDS.length - 1].className
  )
}

export function requestQualityParts(
  requests: number,
  watchRequests = 0,
  highRiskRequests = 0
) {
  const abnormal = Math.max(0, watchRequests) + Math.max(0, highRiskRequests)
  const normal = Math.max(0, requests - abnormal)
  const share = (part: number) => (requests > 0 ? (part / requests) * 100 : 0)
  return {
    requests,
    watchRequests: Math.max(0, watchRequests),
    highRiskRequests: Math.max(0, highRiskRequests),
    abnormal,
    normal,
    normalShare: share(normal),
    watchShare: share(Math.max(0, watchRequests)),
    highShare: share(Math.max(0, highRiskRequests)),
  }
}
