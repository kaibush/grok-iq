import { describe, expect, it } from 'vitest'
import type { ProbeProfile, ProbeRun, ProbeSample } from '@/lib/api'
import {
  slimAccountPreview,
  slimPreviewResponseText,
  slimRequestAuditRecord,
  slimRunPreview,
} from './preview-payload'

const sample = (overrides: Partial<ProbeSample> = {}): ProbeSample =>
  ({
    id: 's1',
    run_id: 'r1',
    account_id: 1,
    round_number: 1,
    target_key: 'current',
    target_kind: 'current',
    egress_name: 'node',
    request_id: 'req',
    status: 'completed',
    status_code: 200,
    output_tokens: 10,
    reasoning_tokens: 4,
    first_token_ms: 20,
    duration_ms: 100,
    generation_ms: 80,
    first_token_share: 0.2,
    tps: 12,
    classification: 'normal',
    error: '',
    created_at: '2026-08-31T00:00:00Z',
    response_text: 'hello',
    reasoning_text: 'secret chain',
    ...overrides,
  }) as ProbeSample

describe('slimPreviewResponseText', () => {
  it('keeps only the fenced HTML document', () => {
    const content = [
      'intro text that can be dropped',
      '```html',
      '<!doctype html><html><body>card</body></html>',
      '```',
      'trailing notes',
    ].join('\n')
    expect(slimPreviewResponseText(content)).toBe(
      '<!doctype html><html><body>card</body></html>'
    )
  })

  it('truncates plain text previews', () => {
    const content = 'x'.repeat(12_000)
    expect(slimPreviewResponseText(content).length).toBe(8_000)
  })
})

describe('slimRunPreview', () => {
  it('drops reasoning and unused profile fields', () => {
    const profile = {
      id: 'p1',
      built_in: false,
      name: 'HTML card',
      description: 'desc',
      model: 'grok',
      system_prompt: 'a'.repeat(5000),
      prompt: 'b'.repeat(5000),
      expected_text: '',
      expected_output: '<p>ok</p>',
      expected_image_url: '',
      max_output_tokens: 100,
      temperature: null,
      extra_body: { huge: 'c'.repeat(5000) },
      enabled: true,
      created_at: '',
      updated_at: '',
    } as ProbeProfile
    const run = { id: 'r1' } as ProbeRun
    const result = slimRunPreview({
      run,
      profile,
      samples: [
        sample({
          response_text: '```html\n<div>hi</div>\n```\nnotes',
          reasoning_text: 'very long reasoning',
        }),
      ],
    })
    expect(result.profile).toEqual({
      name: 'HTML card',
      expected_output: '<p>ok</p>',
      expected_image_url: '',
    })
    expect(result.samples[0]?.response_text).toBe('<div>hi</div>')
    expect(result.samples[0]?.reasoning_text).toBe('')
  })
})

describe('slimAccountPreview', () => {
  it('keeps account metadata and slims sample payloads', () => {
    const result = slimAccountPreview({
      account: {
        id: '12',
        name: 'iso-account',
        email: 'iso@example.com',
        provider: 'grok',
        enabled: false,
        ssoAvailable: false,
        assessment: {
          account_id: 12,
          monitor_status: 'quarantined',
          risk_score: 90,
          sample_count: 1,
          anomaly_count: 1,
          risk_reasons: [],
        },
      },
      history: {
        samples: [
          sample({
            account_id: 12,
            response_text: '```html\n<section>card</section>\n```\nnotes',
            reasoning_text: 'drop me',
          }),
        ],
        runs: [],
        byTarget: [],
      },
    })
    expect(result.accountId).toBe(12)
    expect(result.account.name).toBe('iso-account')
    expect(result.samples[0]?.response_text).toBe('<section>card</section>')
    expect(result.samples[0]?.reasoning_text).toBe('')
  })
})

describe('slimRequestAuditRecord', () => {
  it('drops nested probe samples from ledger rows', () => {
    const record = {
      id: '1',
      probeSampleCount: 2,
      probeSamples: [{ sample: { id: 's' } }, { sample: { id: 't' } }],
    } as never
    expect(slimRequestAuditRecord(record).probeSamples).toEqual([])
    expect(slimRequestAuditRecord(record).probeSampleCount).toBe(2)
  })
})
