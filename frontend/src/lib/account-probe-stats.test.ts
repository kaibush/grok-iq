import { describe, expect, it } from 'vitest'
import {
  accountHasActiveProbeRun,
  accountProbePeriodStats,
} from './account-probe-stats'

describe('accountProbePeriodStats', () => {
  it('uses the in-progress probe when it already has samples', () => {
    expect(
      accountProbePeriodStats({
        assessment: { sample_count: 2, anomaly_count: 1 },
        latestProbeRun: {
          status: 'running',
          sampleCount: 3,
          anomalyCount: 2,
        },
      })
    ).toEqual({ sampleCount: 3, anomalyCount: 2, source: 'active' })
  })

  it('keeps the assessment window when a queued probe has no samples yet', () => {
    expect(
      accountProbePeriodStats({
        assessment: { sample_count: 4, anomaly_count: 1 },
        latestProbeRun: {
          status: 'queued',
          sampleCount: 0,
          anomalyCount: 0,
        },
      })
    ).toEqual({ sampleCount: 4, anomalyCount: 1, source: 'assessment' })
  })

  it('falls back to the featured probe when the assessment window is empty', () => {
    expect(
      accountProbePeriodStats({
        assessment: { sample_count: 0, anomaly_count: 0 },
        latestProbeRun: {
          status: 'completed',
          sampleCount: 3,
          anomalyCount: 3,
        },
      })
    ).toEqual({ sampleCount: 3, anomalyCount: 3, source: 'featured' })
  })

  it('does not use a failed empty probe as the list counts', () => {
    expect(
      accountProbePeriodStats({
        assessment: { sample_count: 0, anomaly_count: 0 },
        latestProbeRun: {
          status: 'failed',
          sampleCount: 0,
          anomalyCount: 0,
        },
      })
    ).toEqual({ sampleCount: 0, anomalyCount: 0, source: 'empty' })
  })
})

describe('accountHasActiveProbeRun', () => {
  it('treats queued and running probes as active', () => {
    expect(accountHasActiveProbeRun({ latestProbeRun: { status: 'queued' } })).toBe(
      true
    )
    expect(
      accountHasActiveProbeRun({ latestProbeRun: { status: 'running' } })
    ).toBe(true)
    expect(
      accountHasActiveProbeRun({ latestProbeRun: { status: 'completed' } })
    ).toBe(false)
    expect(
      accountHasActiveProbeRun({
        hasActiveProbeRun: true,
        latestProbeRun: { status: 'completed' },
      })
    ).toBe(true)
  })
})
