/**
 * ソースコード中の `.from('<table>').select('<列>')` から、読みにいく列と埋め込みリレーションを取り出す。
 *
 * 存在しない列を select すると PostgREST は 42703 で失敗する。supabase-js の戻り値は
 * `{ data: null, error }` なので、error を見ていない呼び出し元では「行が無い」と区別できず、
 * 権限エラーや空表示として現れる (家族の招待 API が全員 403 になっていた例)。
 * 単体テストは Supabase をモックするため列の有無を見ない。そこで、ここで取り出した列を
 * 実際のスキーマ (ローカル Supabase のカタログ) と突き合わせる結合テストで検出する。
 *
 * 対象にするのは `.from(...)` の直後に `.select(...)` が続き、第 1 引数が文字列リテラル
 * (式の埋め込みが無いテンプレートリテラルを含む) の場合だけ。insert / update の後の select や、
 * 変数で組み立てた select は対象外 (取りこぼしはあるが、誤検出はしない方を優先する)。
 */

export interface SelectRef {
  /** `.from()` に渡したテーブル (またはビュー) 名 */
  table: string;
  /** 列名、または埋め込みリレーション名 */
  name: string;
  /** column: 列として読む / relation: `rel(...)` の形で埋め込むリレーション */
  kind: 'column' | 'relation';
  /** ソース中の行番号 (1 始まり、`.from(` の位置) */
  line: number;
}

/** PostgREST の集約関数 (`count()` など)。列ではないので対象外にする */
const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);

const FROM_SELECT =
  /\.from\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\)\s*\.select\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;

/** トップレベル (括弧の外) のカンマで区切る */
export function splitTopLevel(select: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of select) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * select の 1 項目を解釈する。対象外 (`*`、集約、スプレッド、解釈できない形) は null。
 *   - `alias:col` / `col::text` / `col->key` / `col->>key` → 列 col
 *   - `rel(...)` / `rel!hint(...)` / `alias:rel!inner(...)` → リレーション rel
 */
export function parseSelectItem(item: string): { name: string; kind: 'column' | 'relation' } | null {
  let text = item.trim();
  if (text === '' || text === '*' || text.startsWith('...')) return null;

  const parenAt = text.indexOf('(');
  const isEmbed = parenAt >= 0;
  if (isEmbed) text = text.slice(0, parenAt).trim();

  // alias:target (型変換の :: は別扱い)
  const aliasMatch = /^[A-Za-z_][A-Za-z0-9_]*\s*:(?!:)\s*(.+)$/.exec(text);
  if (aliasMatch) text = aliasMatch[1].trim();

  text = text.split('::')[0];
  text = text.split('->')[0];
  text = text.split('!')[0];
  text = text.trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return null;
  if (isEmbed && AGGREGATES.has(text.toLowerCase())) return null;
  return { name: text, kind: isEmbed ? 'relation' : 'column' };
}

/** ソース 1 ファイル分の `.from().select()` から、列とリレーションの参照を取り出す */
export function extractSelectRefs(source: string): SelectRef[] {
  const refs: SelectRef[] = [];
  FROM_SELECT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FROM_SELECT.exec(source)) !== null) {
    const table = m[2];
    const select = m[3] ?? m[4] ?? m[5] ?? '';
    // テンプレートリテラルに式が埋め込まれている場合は中身が確定しないので見ない
    if (m[5] !== undefined && select.includes('${')) continue;
    const line = source.slice(0, m.index).split('\n').length;
    for (const item of splitTopLevel(select)) {
      const parsed = parseSelectItem(item);
      if (parsed) refs.push({ table, line, ...parsed });
    }
  }
  return refs;
}
