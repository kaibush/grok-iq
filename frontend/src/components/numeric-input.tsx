import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Input } from '@/components/ui/input'

export function isIncompleteNumberDraft(raw: string) {
  const value = raw.trim()
  return (
    value === '' ||
    value === '-' ||
    value === '+' ||
    value === '.' ||
    value === '-.' ||
    value === '+.' ||
    value.endsWith('.') ||
    /[eE][+-]?$/.test(value)
  )
}

export function parseNumberInput(raw: string) {
  const value = raw.trim()
  if (isIncompleteNumberDraft(value)) return null
  const next = Number(value)
  return Number.isFinite(next) ? next : null
}

export function clampNumber(value: number, min?: number, max?: number) {
  let next = value
  if (min != null && next < min) next = min
  if (max != null && next > max) next = max
  return next
}

function committedText(value: number | string | null | undefined) {
  if (typeof value === 'string') return value
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  return String(value)
}

export function NumericInput({
  value,
  onChange,
  min,
  max,
  step,
  onBlur,
  onFocus,
  ...props
}: Omit<
  ComponentProps<typeof Input>,
  'type' | 'value' | 'defaultValue' | 'onChange'
> & {
  value: number | string | null | undefined
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
}) {
  const focusedRef = useRef(false)
  const [text, setText] = useState(() => committedText(value))

  useEffect(() => {
    if (!focusedRef.current) setText(committedText(value))
  }, [value])

  const commit = (raw: string) => {
    const parsed = parseNumberInput(raw)
    if (parsed == null) {
      setText(committedText(value))
      return
    }
    const next = clampNumber(parsed, min, max)
    onChange(next)
    setText(String(next))
  }

  return (
    <Input
      {...props}
      type='number'
      min={min}
      max={max}
      step={step}
      value={text}
      onFocus={(event) => {
        focusedRef.current = true
        onFocus?.(event)
      }}
      onChange={(event) => {
        const raw = event.target.value
        setText(raw)
        const parsed = parseNumberInput(raw)
        if (parsed == null) return
        onChange(parsed)
      }}
      onBlur={(event) => {
        focusedRef.current = false
        commit(event.target.value)
        onBlur?.(event)
      }}
    />
  )
}
