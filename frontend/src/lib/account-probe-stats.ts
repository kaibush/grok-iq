export const ACTIVE_ACCOUNT_PROBE_STATUSES = new Set([
  'queued',
  'running',
  'cancel_requested',
  'recovering',
])

type AccountProbePeriodInput = {
  assessment?: {
    sample_count?: number | null
    anomaly_count?: number | null
  } | null
  latestProbeRun?: {
    status?: string | null
    sampleCount?: number | null
    anomalyCount?: number | null
  } | null
}

function asCount(value: number | null | undefined) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function accountHasActiveProbeRun(account: {
  hasActiveProbeRun?: boolean | null
  latestProbeRun?: { status?: string | null } | null
}) {
  if (account.hasActiveProbeRun) return true
  return ACTIVE_ACCOUNT_PROBE_STATUSES.has(
    String(account.latestProbeRun?.status || '')
  )
}

export function accountProbePeriodStats(account: AccountProbePeriodInput) {
  const assessmentSamples = asCount(account.assessment?.sample_count)
  const assessmentAnomalies = asCount(account.assessment?.anomaly_count)
  const run = account.latestProbeRun
  const runSamples = asCount(run?.sampleCount)
  const runAnomalies = asCount(run?.anomalyCount)
  const runActive = ACTIVE_ACCOUNT_PROBE_STATUSES.has(String(run?.status || ''))

  if (runActive && runSamples > 0) {
    return {
      sampleCount: runSamples,
      anomalyCount: runAnomalies,
      source: 'active' as const,
    }
  }
  if (assessmentSamples > 0) {
    return {
      sampleCount: assessmentSamples,
      anomalyCount: assessmentAnomalies,
      source: 'assessment' as const,
    }
  }
  if (runSamples > 0) {
    return {
      sampleCount: runSamples,
      anomalyCount: runAnomalies,
      source: 'featured' as const,
    }
  }
  return {
    sampleCount: 0,
    anomalyCount: 0,
    source: 'empty' as const,
  }
}
