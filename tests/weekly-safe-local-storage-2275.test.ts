/**
 * #2275 T3 献立表 (page.tsx) の生成中の印の localStorage の読み書き (_state/safeLocalStorage.ts) の単体テスト。
 *
 * 保存が禁止された環境 (localStorage への参照そのものや getItem / removeItem / setItem が SecurityError で投げる) でも、
 * 読み書きの関数は呼び出し側へ投げない (読めなければ null)。使える環境では素の localStorage と同じに読み書きする。
 * 画面の経路 (失敗の表示・完了の後処理・中止) は tests/weekly-generation-marker-storage-2275.test.tsx が確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readLocalStorageItem,
  removeLocalStorageItem,
  safeLocalStorageSetItem,
} from '@/app/(main)/menus/weekly/_state/safeLocalStorage';

/** 保存が禁止された環境の例外 */
const SECURITY_ERROR = new DOMException('The operation is insecure.', 'SecurityError');
/** 保存の上限に当たったときの例外 */
const QUOTA_ERROR = new DOMException('The quota has been exceeded.', 'QuotaExceededError');

const MARKER_KEY = 'v4MenuGenerating';
const MARKER_VALUE = JSON.stringify({ requestId: 'req-2275', timestamp: 1 });

let restoreStorage: (() => void) | null = null;

/** localStorage への参照そのものを投げる形にする (後片付けは afterEach) */
function makeLocalStorageReferenceThrow(): void {
  const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => {
      throw SECURITY_ERROR;
    },
  });
  restoreStorage = () => {
    if (own) Object.defineProperty(globalThis, 'localStorage', own);
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('使える環境では素の localStorage と同じに読み書きする (#2275 T3)', () => {
  it('readLocalStorageItem は保存した値を返し、無いキーは null を返す。警告は出さない', () => {
    localStorage.setItem(MARKER_KEY, MARKER_VALUE);
    expect(readLocalStorageItem(MARKER_KEY)).toBe(MARKER_VALUE);
    expect(readLocalStorageItem('weeklyMenuGenerating')).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('removeLocalStorageItem はそのキーだけを消す。警告は出さない', () => {
    localStorage.setItem(MARKER_KEY, MARKER_VALUE);
    localStorage.setItem('singleMealGenerating', 'keep');
    removeLocalStorageItem(MARKER_KEY);
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
    expect(localStorage.getItem('singleMealGenerating')).toBe('keep');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('safeLocalStorageSetItem は値を保存する', () => {
    safeLocalStorageSetItem(MARKER_KEY, MARKER_VALUE);
    expect(localStorage.getItem(MARKER_KEY)).toBe(MARKER_VALUE);
  });
});

describe('保存が禁止された環境でも投げない (#2275 T3)', () => {
  it('getItem が投げる: readLocalStorageItem は null を返し、警告を出す', () => {
    localStorage.setItem(MARKER_KEY, MARKER_VALUE);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw SECURITY_ERROR;
    });
    expect(readLocalStorageItem(MARKER_KEY)).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('removeItem が投げる: removeLocalStorageItem は投げず、警告を出す', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw SECURITY_ERROR;
    });
    expect(() => removeLocalStorageItem(MARKER_KEY)).not.toThrow();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('localStorage への参照そのものが投げる: 3 つとも投げない (読みは null)', () => {
    makeLocalStorageReferenceThrow();
    expect(readLocalStorageItem(MARKER_KEY)).toBeNull();
    expect(() => removeLocalStorageItem(MARKER_KEY)).not.toThrow();
    expect(() => safeLocalStorageSetItem(MARKER_KEY, MARKER_VALUE)).not.toThrow();
  });

  it('保存の上限に当たり、ほかの印を消す removeItem も投げる: safeLocalStorageSetItem は投げずに、ほかの印を消そうとしてから 1 度だけ保存し直す', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw QUOTA_ERROR;
    });
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw SECURITY_ERROR;
    });
    expect(() => safeLocalStorageSetItem(MARKER_KEY, MARKER_VALUE)).not.toThrow();
    // 自分のキー以外の 3 つの印を消そうとする
    expect(removeItem.mock.calls.map(([key]) => key)).toEqual(['weeklyMenuGenerating', 'singleMealGenerating', 'shoppingListRegenerating']);
    // 最初の保存 + 保存し直し
    expect(setItem).toHaveBeenCalledTimes(2);
  });
});
