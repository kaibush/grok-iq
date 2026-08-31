import { useEffect, useState } from 'react'

export const MAX_LIVE_HTML_THUMBS = 8
export const HTML_THUMB_FRAME_WIDTH = 720
export const HTML_THUMB_FRAME_HEIGHT = 450

type ThumbSlotWaiter = () => void

let liveThumbCount = 0
const thumbWaiters: ThumbSlotWaiter[] = []

function flushThumbWaiters() {
  while (thumbWaiters.length && liveThumbCount < MAX_LIVE_HTML_THUMBS) {
    const next = thumbWaiters.shift()
    next?.()
  }
}

export function acquireHtmlThumbSlot(onGranted: () => void): () => void {
  let granted = false
  let cancelled = false

  const tryGrant = () => {
    if (cancelled || granted || liveThumbCount >= MAX_LIVE_HTML_THUMBS) {
      return
    }
    liveThumbCount += 1
    granted = true
    onGranted()
  }

  const waiter = () => tryGrant()
  if (liveThumbCount < MAX_LIVE_HTML_THUMBS) {
    tryGrant()
  } else {
    thumbWaiters.push(waiter)
  }

  return () => {
    cancelled = true
    const index = thumbWaiters.indexOf(waiter)
    if (index >= 0) thumbWaiters.splice(index, 1)
    if (!granted) return
    granted = false
    liveThumbCount = Math.max(0, liveThumbCount - 1)
    flushThumbWaiters()
  }
}

export function resetHtmlThumbSlotsForTests() {
  liveThumbCount = 0
  thumbWaiters.length = 0
}

export function useHtmlThumbSlot(active: boolean) {
  const [held, setHeld] = useState(false)
  if (!active && held) {
    setHeld(false)
  }
  useEffect(() => {
    if (!active) return
    return acquireHtmlThumbSlot(() => setHeld(true))
  }, [active])
  return active && held
}
