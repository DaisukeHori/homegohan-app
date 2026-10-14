/**
 * 利用者別の localStorage のキーの一覧は 1 か所 (packages/shared/src/user-scoped-storage.ts) だけに持つ (#1037)
 *
 * ログアウトで消す側は 2 つある。
 *   - Web: src/lib/user-storage.ts の clearUserScopedLocalStorage()
 *   - モバイルアプリ: apps/mobile/src/lib/webViewUserStorageCleanup.ts (ネイティブのログアウト・退会のあと、
 *     次に開く WebView で消す。中身の検査は apps/mobile/__tests__/lib/web-view-user-storage-cleanup.test.ts)
 * どちらも共有の一覧を読み、キーを写さない。一覧にキーを足せば、両方の掃除が自動で追随する。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FAMILY_VIEW_STATE_KEY_PREFIX,
  USER_SCOPED_LOCAL_STORAGE_KEYS,
  USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES,
  USER_SCOPED_STORAGE_CLEARED_EVENT as SHARED_CLEARED_EVENT,
} from '@homegohan/shared'

import { USER_SCOPED_STORAGE_CLEARED_EVENT, clearUserScopedLocalStorage } from '@/lib/user-storage'

const REPO_ROOT = path.resolve(__dirname, '../../..')

/** 一覧を読んで消す 2 つのモジュール。ここにキーの文字列を写すと、一覧に足したキーが片方で消えなくなる */
const CLEANUP_MODULES = ['src/lib/user-storage.ts', 'apps/mobile/src/lib/webViewUserStorageCleanup.ts']

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('Web の clearUserScopedLocalStorage()', () => {
  it('共有の一覧のキーをすべて消し、一覧に無いキーは残す', () => {
    expect(USER_SCOPED_LOCAL_STORAGE_KEYS.length).toBeGreaterThan(0)
    for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) localStorage.setItem(key, 'previous-user')
    localStorage.setItem('unrelated-key', 'keep')

    clearUserScopedLocalStorage()

    expect(USER_SCOPED_LOCAL_STORAGE_KEYS.filter((key) => localStorage.getItem(key) !== null)).toEqual([])
    expect(localStorage.getItem('unrelated-key')).toBe('keep')
  })

  it('利用者別の接頭辞で始まるキー (家族の表示の切り替え familyViewState_<familyId> など) もすべて消す (#1599)', () => {
    expect(USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES).toContain(FAMILY_VIEW_STATE_KEY_PREFIX)
    // 消しながら数えるとずれるので、連続した 3 つ以上のキーで確かめる
    const familyKeys = ['family-a', 'family-b', 'family-c'].map((id) => `${FAMILY_VIEW_STATE_KEY_PREFIX}${id}`)
    for (const key of familyKeys) localStorage.setItem(key, JSON.stringify({ preset: 'children_only', visible_member_ids: ['m-1'] }))
    for (const prefix of USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES) localStorage.setItem(`${prefix}other`, 'previous-user')
    localStorage.setItem('unrelated-key', 'keep')
    // 接頭辞が途中にあるだけのキーは消さない (前方一致だけ)
    localStorage.setItem(`x${FAMILY_VIEW_STATE_KEY_PREFIX}family-a`, 'keep')

    clearUserScopedLocalStorage()

    const remaining = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort()
    expect(remaining).toEqual(['unrelated-key', `x${FAMILY_VIEW_STATE_KEY_PREFIX}family-a`].sort())
  })

  it('useFamilyView (src/hooks/useFamilyView.ts) は、共有の接頭辞でキーを作る (接頭辞を写すと、ログアウトで消えなくなる)', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'src/hooks/useFamilyView.ts'), 'utf8')

    expect(source).toContain('FAMILY_VIEW_STATE_KEY_PREFIX')
    expect(source.includes(`'${FAMILY_VIEW_STATE_KEY_PREFIX}`) || source.includes(`\`${FAMILY_VIEW_STATE_KEY_PREFIX}`)).toBe(false)
  })

  it('消したことを、共有の名前のイベントで知らせる (モバイルアプリが注入する掃除の JS も同じ名前を使う)', () => {
    const listener = vi.fn()
    window.addEventListener(SHARED_CLEARED_EVENT, listener)

    clearUserScopedLocalStorage()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(USER_SCOPED_STORAGE_CLEARED_EVENT).toBe(SHARED_CLEARED_EVENT)
    window.removeEventListener(SHARED_CLEARED_EVENT, listener)
  })
})

describe('一覧を写さない', () => {
  it.each(CLEANUP_MODULES)('%s は、共有の一覧のキーの文字列を書かない (@homegohan/shared から読む)', (relativePath) => {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')

    expect(source).toContain('USER_SCOPED_LOCAL_STORAGE_KEYS')
    expect(source).toMatch(/from ['"]@homegohan\/shared['"]/)
    const copied = USER_SCOPED_LOCAL_STORAGE_KEYS.filter(
      (key) => source.includes(`'${key}'`) || source.includes(`"${key}"`),
    )
    expect(copied).toEqual([])
  })
})
