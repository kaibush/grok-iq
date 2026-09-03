import { describe, expect, it } from 'vitest'
import {
  clampNumber,
  isIncompleteNumberDraft,
  parseNumberInput,
} from './numeric-input'

describe('numeric input drafts', () => {
  it('treats an empty or partial value as in-progress instead of zero', () => {
    expect(isIncompleteNumberDraft('')).toBe(true)
    expect(isIncompleteNumberDraft('-')).toBe(true)
    expect(isIncompleteNumberDraft('1.')).toBe(true)
    expect(parseNumberInput('')).toBeNull()
    expect(parseNumberInput('-')).toBeNull()
    expect(parseNumberInput('1.')).toBeNull()
  })

  it('parses finished numbers including zero', () => {
    expect(parseNumberInput('0')).toBe(0)
    expect(parseNumberInput('1')).toBe(1)
    expect(parseNumberInput('20')).toBe(20)
    expect(parseNumberInput('-3.5')).toBe(-3.5)
  })

  it('clamps only after a finished number exists', () => {
    expect(clampNumber(0, 1, 20)).toBe(1)
    expect(clampNumber(21, 1, 20)).toBe(20)
    expect(clampNumber(8, 1, 20)).toBe(8)
  })
})
