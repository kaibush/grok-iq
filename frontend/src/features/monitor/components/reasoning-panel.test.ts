import { describe, expect, it } from 'vitest'
import { reasoningPresence } from './reasoning-panel'

describe('reasoningPresence', () => {
  it('marks real thinking text as present', () => {
    expect(
      reasoningPresence({
        content: '  chain  ',
        tokenCount: 4,
      })
    ).toEqual({ hasText: true, missing: false })
  })

  it('uses the slim preview flag when text was stripped', () => {
    expect(
      reasoningPresence({
        content: '',
        tokenCount: 4,
        hasReasoningText: true,
      })
    ).toEqual({ hasText: true, missing: false })
  })

  it('marks reported tokens without a body as missing', () => {
    expect(
      reasoningPresence({
        content: '  ',
        tokenCount: 8,
      })
    ).toEqual({ hasText: false, missing: true })
  })

  it('hides the marker when there is no thinking at all', () => {
    expect(
      reasoningPresence({
        content: '',
        tokenCount: 0,
      })
    ).toEqual({ hasText: false, missing: false })
  })
})
