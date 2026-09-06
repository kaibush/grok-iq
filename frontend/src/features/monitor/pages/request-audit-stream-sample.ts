import type { RequestAuditStreamSample } from '@/lib/api'

export type StreamSampleDiagnostics = {
  hasSample: boolean
  hasThinking: boolean
  hasEncryptedThinking: boolean
  hasOutput: boolean
  thinkingThenOutput: boolean
  reasoningMismatch: boolean
  outputMismatch: boolean
  thinkingBurst: boolean
}

export function streamSamplePreview(
  sample?: Pick<RequestAuditStreamSample, 'thinkingHead' | 'outputHead'> | null,
  max = 48
): { thinking: string; output: string } {
  return {
    thinking: compactSampleSnippet(sample?.thinkingHead, max),
    output: compactSampleSnippet(sample?.outputHead, max),
  }
}

function compactSampleSnippet(value: string | undefined, max: number): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

export function streamSampleDiagnostics(audit: {
  reasoningTokens: number
  outputTokens: number
  streaming?: boolean
  streamSample?: RequestAuditStreamSample | null
}): StreamSampleDiagnostics {
  const sample = audit.streamSample
  const hasSample = Boolean(sample && Object.keys(sample).length > 0)
  const hasThinking = Boolean(sample?.hasThinking)
  const hasEncryptedThinking = Boolean(sample?.hasEncryptedThinking)
  const hasOutput = Boolean(sample?.hasVisibleOutput || sample?.hasToolOutput)
  const thinkingThenOutput = Boolean(sample?.thinkingThenOutput)
  const reasoningMismatch =
    audit.streaming !== false &&
    hasSample &&
    audit.reasoningTokens > 0 &&
    !hasThinking
  const visibleTokens = Math.max(0, audit.outputTokens - audit.reasoningTokens)
  const outputMismatch =
    audit.streaming !== false && hasSample && visibleTokens > 0 && !hasOutput
  const thinkingWindow =
    sample?.firstThinkingMs != null && sample?.lastThinkingMs != null
      ? Math.max(0, sample.lastThinkingMs - sample.firstThinkingMs)
      : undefined
  const thinkingBurst =
    (sample?.thinkingChars ?? 0) >= 80 &&
    thinkingWindow !== undefined &&
    thinkingWindow <= 250
  return {
    hasSample,
    hasThinking,
    hasEncryptedThinking,
    hasOutput,
    thinkingThenOutput,
    reasoningMismatch,
    outputMismatch,
    thinkingBurst,
  }
}

export function streamSampleWarnings(diagnostics: StreamSampleDiagnostics): string[] {
  const warnings: string[] = []
  if (diagnostics.reasoningMismatch) {
    warnings.push(
      '用量报告了推理 Token，但流里没有明文思考正文。只有 Token 数字或加密思考、没有思考文本时，通常是降智。'
    )
  }
  if (diagnostics.outputMismatch) {
    warnings.push('用量报告了可见输出 Token，但流里没有实体文本或工具输出。')
  }
  if (diagnostics.thinkingBurst) {
    warnings.push(
      '思考文本在极短时间内集中到达，可能是缓冲后一次性刷出，会把 Token/s 抬得很高。'
    )
  }
  if (diagnostics.hasThinking && !diagnostics.hasOutput) {
    warnings.push('已看到思考内容，但思考结束后没有实体输出。')
  }
  return warnings
}

export function formatSampleWindow(
  firstMs: number | undefined,
  lastMs: number | undefined,
  formatNumber: (value: number, digits?: number) => string,
  empty = '无'
) {
  if (firstMs == null && lastMs == null) return empty
  const first = firstMs == null ? '—' : `${formatNumber(firstMs, 0)} ms`
  const last = lastMs == null ? '—' : `${formatNumber(lastMs, 0)} ms`
  return `${first} → ${last}`
}
