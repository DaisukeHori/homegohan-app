/**
 * #1222: プレビュー用 Blob URL (`URL.createObjectURL`) を解放するための純粋ヘルパー。
 *
 * `URL.createObjectURL(file)` で作った URL は、`URL.revokeObjectURL` で明示的に解放するまで
 * ブラウザが元の Blob を保持し続ける。写真解析 3 ページ (食事 / 冷蔵庫 / 健診) は、
 * 撮り直し・削除・リセットのたびに URL を state から外すだけで revoke しておらず、
 * タブを閉じるまでメモリが増え続けていた。
 *
 * このファイルは React に依存しない関数だけを置く (単体テストしやすくするため)。
 * React から使うときの配線は `src/hooks/useRevokeBlobUrls.ts`。
 */

/**
 * `URL.createObjectURL` が返す Blob URL (`blob:` で始まる文字列) かどうか。
 *
 * 画面側が state に入れる Blob 以外の値 (例: 健診ページの目印 `'__pdf__'`、
 * ハンズオンの固定画像 `/handson-tour/sample-meal.webp`、`data:` URL) は false になる。
 */
export function isBlobUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('blob:');
}

/**
 * 前回の URL 配列にあって、今回の配列には無い URL (= 画面から外れた URL) を返す。
 *
 * - 同じ URL が重複していても 1 件にまとめる (順序は前回配列の出現順)
 * - 今回の配列に残っている URL は返さない (まだ表示中のものを解放しないため)
 */
export function findRemovedUrls(
  prev: readonly string[],
  next: readonly string[],
): string[] {
  const kept = new Set(next);
  const removed = new Set<string>();
  for (const url of prev) {
    if (!kept.has(url)) removed.add(url);
  }
  return Array.from(removed);
}

/**
 * `blob:` で始まる URL だけを `URL.revokeObjectURL` で解放する。
 *
 * 次の値は何もしない (誤って別の URL を revoke しないための安全側の挙動):
 * - null / undefined / 空文字
 * - Blob URL 以外 (通常の URL・`data:` URL・`'__pdf__'` のような目印)
 *
 * React の cleanup から呼ばれても例外で画面が落ちないよう、
 * `URL.revokeObjectURL` が無い環境 (SSR・古い WebView) では何もしない。
 */
export function revokeBlobUrls(
  urls: readonly (string | null | undefined)[],
): void {
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
    return;
  }
  for (const url of urls) {
    if (isBlobUrl(url)) URL.revokeObjectURL(url);
  }
}
