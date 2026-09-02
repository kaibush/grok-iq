export const COOLDOWN_EXPIRING_SOON_SECONDS = 120

export function remainingSecondsUntil(
  until?: string | null,
  nowMs: number = Date.now()
): number | null {
  if (!until) return null
  const date = new Date(until)
  if (Number.isNaN(date.getTime())) return null
  return Math.floor((date.getTime() - nowMs) / 1000)
}

export function formatRemainingDuration(
  seconds: number | null | undefined
): string {
  if (seconds == null || Number.isNaN(seconds)) return '—'
  if (seconds <= 0) return '已结束'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) {
    return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  }
  if (minutes > 0) {
    return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`
  }
  return `${rest} 秒`
}

export function isCooldownExpiringSoon(
  remaining: number | null | undefined
): boolean {
  return (
    remaining != null &&
    remaining > 0 &&
    remaining <= COOLDOWN_EXPIRING_SOON_SECONDS
  )
}

export function remainingForAccount(
  account: {
    status?: string
    cooldownUntil?: string | null
    remainingSeconds?: number
  },
  nowMs: number = Date.now()
): number | null {
  const fromUntil = remainingSecondsUntil(account.cooldownUntil, nowMs)
  if (fromUntil != null) return fromUntil
  if (account.status === 'expired') return 0
  return account.remainingSeconds ?? null
}
