export type ParsedRequestSample = {
  latestUserTurn: string
  bodyText: string
  originalBytes?: number
  truncatedEnvelope: boolean
}

export function parseRequestSample(value?: string | null): ParsedRequestSample {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) {
    return { latestUserTurn: '', bodyText: '', truncatedEnvelope: false }
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (parsed && parsed.truncatedRequestSample === true) {
      const latestUserTurn =
        typeof parsed.latestUserTurn === 'string' ? parsed.latestUserTurn.trim() : ''
      const originalBytes =
        typeof parsed.originalBytes === 'number' ? parsed.originalBytes : undefined
      const remainder = { ...parsed }
      delete remainder.truncatedRequestSample
      delete remainder.latestUserTurn
      return {
        latestUserTurn,
        bodyText: JSON.stringify(remainder, null, 2),
        originalBytes,
        truncatedEnvelope: true,
      }
    }
    return {
      latestUserTurn: extractLatestUserTurnFromJSON(parsed),
      bodyText: JSON.stringify(parsed, null, 2),
      truncatedEnvelope: false,
    }
  } catch {
    return { latestUserTurn: '', bodyText: trimmed, truncatedEnvelope: false }
  }
}

function extractLatestUserTurnFromJSON(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
  const root = parsed as Record<string, unknown>
  const fromMessages = lastUserFromRoleMessages(root.messages)
  if (fromMessages) return fromMessages
  const fromInput = lastUserFromResponsesInput(root.input)
  if (fromInput) return fromInput
  if (typeof root.prompt === 'string' && root.prompt.trim()) return root.prompt.trim()
  return ''
}

function lastUserFromRoleMessages(value: unknown): string {
  if (!Array.isArray(value)) return ''
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const item = value[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const role = String((item as Record<string, unknown>).role ?? '')
      .toLowerCase()
      .trim()
    if (role !== 'user') continue
    const text = flattenSampleContent((item as Record<string, unknown>).content)
    if (text) return text
  }
  return ''
}

function lastUserFromResponsesInput(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const item = value[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const typeName = String(record.type ?? '').trim()
    const role = String(record.role ?? '').toLowerCase().trim()
    if (typeName && typeName !== 'message' && typeName !== 'input_text' && typeName !== 'text') {
      continue
    }
    if (role && role !== 'user') continue
    const text =
      flattenSampleContent(record.content) ||
      (typeof record.text === 'string' ? record.text.trim() : '')
    if (text && (role === 'user' || role === '')) return text
  }
  return ''
}

function flattenSampleContent(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const part of value) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    const record = part as Record<string, unknown>
    const typeName = String(record.type ?? '').trim()
    if (typeName && typeName !== 'text' && typeName !== 'input_text' && typeName !== 'output_text') {
      continue
    }
    if (typeof record.text === 'string' && record.text.trim()) parts.push(record.text.trim())
  }
  return parts.join('\n')
}
