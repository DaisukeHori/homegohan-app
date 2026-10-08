/**
 * 管理画面のユーザー検索 (q) を PostgREST の or=(...) フィルタ文字列にする (#1145)
 *
 * 以前は `nickname.ilike.%${q}%` と検索語をそのまま連結していたため、
 *   - "," ")" などを含む検索語が or=(...) の構文を壊した (構文エラーや、意図しない条件の混入)
 *   - "%" "_" が LIKE のワイルドカードとして働いた (q="%" で全件に一致)
 * ここで検索語を二重にエスケープして、文字どおりの部分一致にする。
 *
 * 制限: PostgREST の ilike は値の "*" を "%" に読み替える (URL に % を書かなくて済むようにするための仕様で、
 * 引用符で囲んでも変わらない)。そのため検索語の "*" だけは任意文字列のワイルドカードとして働く (過剰に一致するだけで、失敗はしない)。
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** LIKE / ILIKE のワイルドカード (% _) とエスケープ文字 (\) を、文字どおりに一致させる形にする */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * or=(...) の中の値を二重引用符で囲む。引用符の中では "," "(" ")" "." が値の一部として扱われ、
 * 特別扱いされるのは " と \ だけ (\ が直後の 1 文字をそのまま通す)。
 */
export function quotePostgrestValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * q から user_profiles 用の or=(...) の中身を作る。検索語が空 (空白だけ含む) なら null。
 *   - nickname の部分一致 (大文字小文字を区別しない)
 *   - q が UUID の形なら id の一致 (大文字の UUID も受ける)
 *   - emailMatchedIds (メールの部分一致で見つかった user_id。admin / super_admin の検索でだけ渡す) があれば id の一致
 */
export function buildUserSearchFilter(q: string, emailMatchedIds: ReadonlyArray<string> = []): string | null {
  const term = q.trim();
  if (!term) return null;

  const conditions = [`nickname.ilike.${quotePostgrestValue(`%${escapeLikePattern(term)}%`)}`];

  if (isUuid(term)) {
    conditions.push(`id.eq.${term.toLowerCase()}`);
  }

  // DB から返った値でも、or=(...) に埋め込む前に UUID の形だけを通す (構文を壊す文字を入れない)
  const ids = Array.from(new Set(emailMatchedIds.filter(isUuid).map((id) => id.toLowerCase())));
  if (ids.length > 0) {
    conditions.push(`id.in.(${ids.join(',')})`);
  }

  return conditions.join(',');
}
