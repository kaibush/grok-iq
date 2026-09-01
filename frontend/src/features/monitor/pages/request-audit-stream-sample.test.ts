import { describe, expect, it } from 'vitest'
import {
  formatSampleWindow,
  streamSampleDiagnostics,
  streamSampleWarnings,
} from './request-audit-stream-sample'

describe('streamSampleDiagnostics', () => {
  it('flags usage that claims reasoning without streamed thinking', () => {
    const result = streamSampleDiagnostics({
      reasoningTokens: 900,
      outputTokens: 1000,
      streamSample: { hasVisibleOutput: true, outputChars: 40 },
    })
    expect(result.reasoningMismatch).toBe(true)
    expect(result.outputMismatch).toBe(false)
    expect(result.hasThinking).toBe(false)
    expect(result.hasSample).toBe(true)
  })

  it('flags a late thinking dump', () => {
    const result = streamSampleDiagnostics({
      reasoningTokens: 800,
      outputTokens: 820,
      streamSample: {
        hasThinking: true,
        thinkingChars: 400,
        firstThinkingMs: 17100,
        lastThinkingMs: 17200,
        hasVisibleOutput: true,
      },
    })
    expect(result.thinkingBurst).toBe(true)
    expect(result.reasoningMismatch).toBe(false)
  })

  it('does not treat historical rows without a sample as mismatches', () => {
    const result = streamSampleDiagnostics({
      reasoningTokens: 900,
      outputTokens: 1000,
    })
    expect(result.hasSample).toBe(false)
    expect(result.reasoningMismatch).toBe(false)
    expect(result.outputMismatch).toBe(false)
    expect(streamSampleWarnings(result)).toEqual([])
  })
})

describe('formatSampleWindow', () => {
  it('formats a bounded thinking window', () => {
    expect(formatSampleWindow(20, 80, (value) => String(value))).toBe(
      '20 ms → 80 ms'
    )
  })
})
