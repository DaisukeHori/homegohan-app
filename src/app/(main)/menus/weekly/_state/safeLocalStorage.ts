/**
 * 献立表 (page.tsx) の生成中の印 (v4MenuGenerating・weeklyMenuGenerating・singleMealGenerating・shoppingListRegenerating) の
 * localStorage の読み書き。どれも失敗を握り、呼び出し側へ投げない。
 *
 * 保存が禁止された環境 (localStorage への参照そのものや removeItem が SecurityError で投げる) では、印の読み書きは
 * 永続化の補助でしかないので、失敗しても画面の処理 (失敗の表示 GEN_FAIL・完了の後処理・中止) を止めない (#2275 T3)。
 * src/hooks/useV4MenuGeneration.ts の clearGeneratingMarker (#2272 S2) と同じ考え方。
 * 使える環境での読み書きは素の localStorage と同じ。
 */

/** 生成中の印のキーの一覧 (保存の上限に当たったときに、ほかの古い印を消して空きを作る) */
const GENERATION_MARKER_KEYS = ['weeklyMenuGenerating', 'singleMealGenerating', 'shoppingListRegenerating', 'v4MenuGenerating'] as const;

/**
 * localStorage.getItem の失敗を握る形。読めなかったときは null (印が無いのと同じ扱い) を返す。
 */
export function readLocalStorageItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (storageError: unknown) {
    console.warn('[weekly] localStorage.getItem failed:', key, storageError);
    return null;
  }
}

/**
 * localStorage.removeItem の失敗を握る形。消せなかったときは警告だけ出して戻る。
 */
export function removeLocalStorageItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (storageError: unknown) {
    console.warn('[weekly] localStorage.removeItem failed:', key, storageError);
  }
}

/**
 * QuotaExceededError-safe localStorage.setItem (#141).
 * On quota failure, clears stale generation-tracker keys and retries once.
 * If it still fails, logs a warning — the UI state is already set in React,
 * so omitting persistence is acceptable.
 */
export function safeLocalStorageSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      // 旧い生成中状態キーを削除して再試行
      for (const k of GENERATION_MARKER_KEYS) {
        if (k !== key) removeLocalStorageItem(k);
      }
      try {
        localStorage.setItem(key, value);
      } catch {
        console.warn('[weekly] localStorage quota exceeded: 生成状態を永続化できませんでした', key);
      }
    } else {
      console.warn('[weekly] localStorage.setItem failed:', key, e);
    }
  }
}
