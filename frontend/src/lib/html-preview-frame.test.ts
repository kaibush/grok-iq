import { describe, expect, it, beforeEach } from 'vitest'
import {
  MAX_LIVE_HTML_THUMBS,
  acquireHtmlThumbSlot,
  resetHtmlThumbSlotsForTests,
} from './html-preview-frame'

describe('acquireHtmlThumbSlot', () => {
  beforeEach(() => {
    resetHtmlThumbSlotsForTests()
  })

  it('caps concurrent thumbnail iframes and reuses released slots', () => {
    const granted: number[] = []
    const releases: Array<() => void> = []
    for (let index = 0; index < MAX_LIVE_HTML_THUMBS + 3; index += 1) {
      const current = index
      releases.push(
        acquireHtmlThumbSlot(() => {
          granted.push(current)
        })
      )
    }
    expect(granted).toEqual(
      Array.from({ length: MAX_LIVE_HTML_THUMBS }, (_, index) => index)
    )
    releases[0]?.()
    expect(granted).toEqual([
      ...Array.from({ length: MAX_LIVE_HTML_THUMBS }, (_, index) => index),
      MAX_LIVE_HTML_THUMBS,
    ])
  })
})
