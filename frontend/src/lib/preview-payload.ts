import {
  type AccountDetailResponse,
  type ProbeProfile,
  type ProbeRun,
  type ProbeSample,
  type RequestAuditRecord,
  type UpstreamAccount,
} from '@/lib/api'
import { extractHtmlPreviews } from '@/lib/formatted-content'

export const PREVIEW_TEXT_LIMIT = 8_000
export const RUN_PREVIEW_GC_TIME = 15_000
export const ACCOUNT_PREVIEW_SAMPLE_LIMIT = 30

export type RunPreviewPayload = {
  runId: string
  status?: string
  samples: ProbeSample[]
  profile: Pick<ProbeProfile, 'name' | 'expected_output' | 'expected_image_url'>
}

export type AccountPreviewRun = Pick<
  ProbeRun,
  | 'id'
  | 'account_id'
  | 'account_name'
  | 'account_email'
  | 'account_created_at'
  | 'profile_id'
  | 'rounds'
  | 'completed_steps'
  | 'total_steps'
  | 'status'
  | 'error'
  | 'created_at'
>

export const ACTIVE_PREVIEW_RUN_STATUSES = new Set([
  'queued',
  'running',
  'cancel_requested',
  'recovering',
])

export function isActivePreviewRun(status?: string | null) {
  return Boolean(status && ACTIVE_PREVIEW_RUN_STATUSES.has(status))
}

export function previewRunRefetchInterval(status?: string | null) {
  return isActivePreviewRun(status) ? 2_000 : false
}

export function previewRunsRefetchInterval(
  runs?: Array<{ status?: string | null }> | null
) {
  return (runs ?? []).some((run) => isActivePreviewRun(run.status))
    ? 2_000
    : false
}

export function previewPlaceholderLabel(
  status?: string | null,
  inView = true
) {
  if (!inView) return '滚动后加载'
  if (status === 'queued') return '任务排队中'
  if (status === 'running') return '任务执行中'
  if (status === 'recovering') return '任务恢复中'
  if (status === 'cancel_requested') return '任务取消中'
  if (status === 'cancelled') return '任务已取消'
  if (status === 'failed') return '任务失败'
  if (status === 'completed_with_errors') return '任务部分异常'
  return '没有可预览正文'
}

export type AccountPreviewPayload = {
  accountId: number
  account: UpstreamAccount
  samples: ProbeSample[]
  runs: AccountPreviewRun[]
}

export function slimPreviewResponseText(content: string): string {
  const html = extractHtmlPreviews(content)[0]
  if (html) return html
  if (content.length <= PREVIEW_TEXT_LIMIT) return content
  return content.slice(0, PREVIEW_TEXT_LIMIT)
}

export function slimPreviewSample(sample: ProbeSample): ProbeSample {
  return {
    ...sample,
    response_text: slimPreviewResponseText(sample.response_text || ''),
    reasoning_text: '',
  }
}

export function slimRunPreview(data: {
  run: ProbeRun
  profile: ProbeProfile
  samples: ProbeSample[]
}): RunPreviewPayload {
  return {
    runId: data.run.id,
    status: data.run.status,
    profile: {
      name: data.profile.name,
      expected_output: data.profile.expected_output || '',
      expected_image_url: data.profile.expected_image_url || '',
    },
    samples: data.samples.map(slimPreviewSample),
  }
}

export function slimAccountRun(run: ProbeRun): AccountPreviewRun {
  return {
    id: run.id,
    account_id: run.account_id,
    account_name: run.account_name,
    account_email: run.account_email,
    account_created_at: run.account_created_at,
    profile_id: run.profile_id,
    rounds: run.rounds,
    completed_steps: run.completed_steps,
    total_steps: run.total_steps,
    status: run.status,
    error: run.error,
    created_at: run.created_at,
  }
}

export function hasAccountPreviewSamples(
  data: {
    account?: {
      assessment?: { sample_count?: number | null } | null
    } | null
    history?: {
      samples?: unknown[] | null
      runs?: Array<{ completed_steps?: number | null }> | null
    } | null
  },
  samplePage?: { total?: number | null; items?: unknown[] | null } | null
): boolean {
  if ((data.account?.assessment?.sample_count ?? 0) > 0) return true
  if ((data.history?.samples?.length ?? 0) > 0) return true
  if ((data.history?.runs ?? []).length > 0) return true
  if ((samplePage?.total ?? 0) > 0) return true
  return (samplePage?.items?.length ?? 0) > 0
}

export function slimAccountPreview(
  data: AccountDetailResponse
): AccountPreviewPayload {
  return {
    accountId: Number(data.account.id),
    account: data.account,
    samples: data.history.samples.map(slimPreviewSample),
    runs: (data.history.runs ?? []).map(slimAccountRun),
  }
}

export function slimRequestAuditRecord(
  record: RequestAuditRecord
): RequestAuditRecord {
  if (!record.probeSamples?.length) return record
  return { ...record, probeSamples: [] }
}
