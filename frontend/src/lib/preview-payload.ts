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
  | 'created_at'
>

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
    created_at: run.created_at,
  }
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
