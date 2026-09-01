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

export function streamSampleDiagnostics(audit: {
  reasoningTokens: number
  outputTokens: number
  streamSample?: RequestAuditStreamSample | null
}): StreamSampleDiagnostics {
  const sample = audit.streamSample
  const hasSample = Boolean(sample && Object.keys(sample).length > 0)
  const hasThinking = Boolean(sample?.hasThinking)
  const hasEncryptedThinking = Boolean(sample?.hasEncryptedThinking)
  const hasOutput = Boolean(sample?.hasVisibleOutput || sample?.hasToolOutput)
  const thinkingThenOutput = Boolean(sample?.thinkingThenOutput)
  const reasoningMismatch =
    hasSample && audit.reasoningTokens > 0 && !hasThinking && !hasEncryptedThinking
  const visibleTokens = Math.max(0, audit.outputTokens - audit.reasoningTokens)
  const outputMismatch = hasSample && visibleTokens > 0 && !hasOutput
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
      '用量报告了推理 Token，但流里没有思考正文或加密思考证据。高 Token/s 时优先核对这一项。'
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
  if (
    (diagnostics.hasThinking || diagnostics.hasEncryptedThinking) &&
    !diagnostics.hasOutput
  ) {
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
