import { describe, expect, it } from 'vitest'
import { parseRequestSample } from './request-audit-request-sample'

describe('parseRequestSample', () => {
  it('extracts the last user turn from a responses payload', () => {
    const sample = JSON.stringify({
      model: 'grok-4',
      instructions: 'huge system prompt',
      input: [
        { type: 'function_call', name: 'read_file' },
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'upstream → chenyme/grok2api 已经同步过了吗？',
            },
          ],
        },
      ],
      tools: [{ name: 'read_file' }],
    })
    const parsed = parseRequestSample(sample)
    expect(parsed.latestUserTurn).toBe('upstream → chenyme/grok2api 已经同步过了吗？')
    expect(parsed.truncatedEnvelope).toBe(false)
    expect(parsed.bodyText).toContain('"model": "grok-4"')
  })

  it('reads latestUserTurn from a grok2api truncated envelope', () => {
    const sample = JSON.stringify({
      truncatedRequestSample: true,
      latestUserTurn: '继续',
      model: 'grok-4',
      originalBytes: 180000,
      head: '{"model":"grok-4"',
      tail: '"prompt_cache_key":"abc"}',
    })
    const parsed = parseRequestSample(sample)
    expect(parsed.latestUserTurn).toBe('继续')
    expect(parsed.truncatedEnvelope).toBe(true)
    expect(parsed.originalBytes).toBe(180000)
    expect(parsed.bodyText).not.toContain('truncatedRequestSample')
    expect(parsed.bodyText).toContain('"model": "grok-4"')
  })

  it('extracts the last chat completions user turn', () => {
    const sample = JSON.stringify({
      model: 'grok-4',
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
    })
    expect(parseRequestSample(sample).latestUserTurn).toBe('second')
  })
})
