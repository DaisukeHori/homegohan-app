/**
 * リクエストの本文 (JSON) に NULL 文字 (U+0000) が含まれていないかを調べる (#1622)
 *
 * Postgres の text 型は U+0000 を保存できず (invalid byte sequence for encoding "UTF8": 0x00)、
 * jsonb も \u0000 を受け付けない (unsupported Unicode escape sequence)。
 * 利用者の入力をそのまま insert すると DB が拒み、route は 500 を返していた
 * (POST /api/ai/menu/weekly/request の note に NULL 文字を入れると 500。tests/e2e/w5-3-menu-gen-adversarial.spec.ts の C-12)。
 * 入口で見つけて 400 にし、DB には渡さない。
 *
 * 文字列・配列の要素・オブジェクトのキーと値をすべてたどる (どの項目が DB のどの列に入るかを route ごとに追わなくて済むように、本文を丸ごと見る)。
 * 再帰を使わずに手持ちの山でたどるので、深く入れ子にした本文でもスタックを溢れさせない。
 */

/** NULL 文字 (U+0000) */
const NULL_CHARACTER = '\u0000';

/** NULL 文字が含まれていたときに 400 の本文 (error) に入れる文 */
export const NULL_CHARACTER_ERROR_MESSAGE = '使用できない文字 (NULL 文字) が含まれています';

/** NULL 文字が含まれていたときに 400 の本文 (code) に入れる値 */
export const NULL_CHARACTER_ERROR_CODE = 'INVALID_CHARACTER';

/**
 * value (JSON.parse の結果など) のどこかの文字列に NULL 文字が含まれていれば true。
 * 文字列以外の値 (数・真偽値・null・undefined) は含まないと扱う。
 */
export function containsNullCharacter(value: unknown): boolean {
  const pending: unknown[] = [value];
  // JSON.parse の結果に循環は無いが、引数は unknown なので、同じオブジェクトを 2 度たどらないようにしておく
  const visited = new Set<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (current.includes(NULL_CHARACTER)) return true;
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (key.includes(NULL_CHARACTER)) return true;
      pending.push(item);
    }
  }
  return false;
}
