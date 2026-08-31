import {
  type ProbeProfile,
  type ProbeRun,
  type ProbeSample,
  type RequestAuditRecord,
} from '@/lib/api'
import { extractHtmlPreviews } from '@/lib/formatted-content'

export const PREVIEW_TEXT_LIMIT = 8_000
export const RUN_PREVIEW_GC_TIME = 15_000

export type RunPreviewPayload = {
  runId: string
  samples: ProbeSample[]
  profile: Pick<ProbeProfile, 'name' | 'expected_output' | 'expected_image_url'>
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

export function slimRequestAuditRecord(
  record: RequestAuditRecord
): RequestAuditRecord {
  if (!record.probeSamples?.length) return record
  return { ...record, probeSamples: [] }
}
