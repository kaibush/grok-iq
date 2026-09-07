import { describe, expect, it } from 'vitest'
import {
  mergeEnabledProfileIds,
  moveOrderedId,
  normalizeWechatAlertKeys,
  syncRegisterProbeProfileRounds,
  toggleWechatAlertKey,
} from './settings-model'

describe('moveOrderedId', () => {
  it('moves a selected profile up and down without dropping others', () => {
    expect(moveOrderedId(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b'])
    expect(moveOrderedId(['a', 'c', 'b'], 'c', -1)).toEqual(['c', 'a', 'b'])
    expect(moveOrderedId(['c', 'a', 'b'], 'c', -1)).toEqual(['c', 'a', 'b'])
    expect(moveOrderedId(['c', 'a', 'b'], 'c', 1)).toEqual(['a', 'c', 'b'])
  })
})

describe('mergeEnabledProfileIds', () => {
  it('keeps the current selection order and appends remaining enabled profiles', () => {
    expect(mergeEnabledProfileIds(['c', 'a'], ['a', 'b', 'c'])).toEqual([
      'c',
      'a',
      'b',
    ])
  })
})

describe('syncRegisterProbeProfileRounds', () => {
  it('keeps rounds aligned to the selected profile order', () => {
    expect(
      syncRegisterProbeProfileRounds(
        ['b', 'a'],
        { a: 4, b: 1, extra: 9 },
        3
      )
    ).toEqual({ b: 1, a: 4 })
  })
})

describe('normalizeWechatAlertKeys', () => {
  it('drops unlabeled, duplicate, and invalid keys', () => {
    expect(
      normalizeWechatAlertKeys([
        { id: 'key-1', name: '生产' },
        { id: 'unlabeled', name: '未记录 Key' },
        { id: 'key-1', name: '重复' },
        { id: ' key-2 ', name: ' 备用 ', threshold: 88.2 },
        { id: '', name: 'empty' },
        null,
      ] as unknown)
    ).toEqual([
      { id: 'key-1', name: '生产' },
      { id: 'key-2', name: '备用', threshold: 88.2 },
    ])
  })
})

describe('toggleWechatAlertKey', () => {
  it('adds and removes a labeled key without touching unlabeled', () => {
    const added = toggleWechatAlertKey([], { id: 'key-1', name: '生产' })
    expect(added).toEqual([{ id: 'key-1', name: '生产' }])
    expect(toggleWechatAlertKey(added, { id: 'key-1' })).toEqual([])
    expect(
      toggleWechatAlertKey(added, { id: 'unlabeled', name: '未记录 Key' })
    ).toEqual(added)
  })
})
