import { describe, expect, it } from 'vitest'
import {
  formatRemainingDuration,
  isCooldownExpiringSoon,
  remainingSecondsUntil,
} from './cooldown-remaining'

describe('cooldown remaining', () => {
  it('computes remaining seconds from cooldownUntil', () => {
    const now = Date.parse('2026-09-02T12:00:00.000Z')
    expect(remainingSecondsUntil('2026-09-02T12:04:30.000Z', now)).toBe(270)
    expect(remainingSecondsUntil('2026-09-02T11:59:00.000Z', now)).toBe(-60)
    expect(remainingSecondsUntil(null, now)).toBeNull()
    expect(remainingSecondsUntil('not-a-date', now)).toBeNull()
  })

  it('formats remaining duration in Chinese', () => {
    expect(formatRemainingDuration(null)).toBe('—')
    expect(formatRemainingDuration(0)).toBe('已结束')
    expect(formatRemainingDuration(-8)).toBe('已结束')
    expect(formatRemainingDuration(9)).toBe('9 秒')
    expect(formatRemainingDuration(60)).toBe('1 分')
    expect(formatRemainingDuration(75)).toBe('1 分 15 秒')
    expect(formatRemainingDuration(3600)).toBe('1 小时')
    expect(formatRemainingDuration(5400)).toBe('1 小时 30 分')
  })

  it('flags remaining time within two minutes as expiring soon', () => {
    expect(isCooldownExpiringSoon(120)).toBe(true)
    expect(isCooldownExpiringSoon(121)).toBe(false)
    expect(isCooldownExpiringSoon(0)).toBe(false)
    expect(isCooldownExpiringSoon(null)).toBe(false)
  })
})
