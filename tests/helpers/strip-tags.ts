/**
 * HTML のタグを取り除く (テスト用)。1 回の置き換えでは「<scr<x>ipt>」のような入れ子が残るので、変わらなくなるまで繰り返す
 * (CodeQL js/incomplete-multi-character-sanitization)。replacement は取り除いたタグの代わりに置く文字列。
 */
export function stripAllTags(html: string, replacement = ''): string {
  let prev: string;
  let out = html;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, replacement);
  } while (out !== prev);
  return out;
}
