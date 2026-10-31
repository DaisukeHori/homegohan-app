/**
 * migration の SQL から COMMENT ON の文を読み、番号順に当てたときに本番の DB に最後に残るコメント (pg_description) を求める
 * (DB は使わない。#2144 S4)。
 *
 * 読むもの: 文の頭の `COMMENT ON <種類> <対象> IS '…';` と `… IS NULL;` (文字列は '' を ' 1 文字として戻す)。
 * 読まないもの (ここでは数えない): -- と /* … *\/ のコメントの中・$$ … $$ / $tag$ … $tag$ の本文 (関数の本文・DO の中の
 * EXECUTE で出す動的なコメント)・E'…' の文字列の \ の逃がし。DROP で消えたもののコメントも消さない (呼ぶ側が必要なら見る)。
 */

/** COMMENT ON の対象の種類 (PostgreSQL の COMMENT の文法のうち、migration に出てくるもの) */
const COMMENT_KINDS = [
  'MATERIALIZED\\s+VIEW',
  'FOREIGN\\s+TABLE',
  'COLUMN',
  'TABLE',
  'VIEW',
  'FUNCTION',
  'PROCEDURE',
  'AGGREGATE',
  'INDEX',
  'SEQUENCE',
  'SCHEMA',
  'TYPE',
  'DOMAIN',
  'EXTENSION',
  'TRIGGER',
  'POLICY',
  'CONSTRAINT',
  'ROLE',
] as const;

/** 対象の名前にスキーマを書かないときのスキーマ (search_path の先頭) */
const DEFAULT_SCHEMA = 'public';

/** `COMMENT ON <種類> <対象> IS <'…' | NULL>;` (種類・対象・文字列の中身。中身が undefined なら NULL) */
const COMMENT_STATEMENT = new RegExp(
  String.raw`\bCOMMENT\s+ON\s+(${COMMENT_KINDS.join('|')})\s+([^';]+?)\s+IS\s+(?:NULL|'((?:[^']|'')*)')\s*;`,
  'gi',
);

/** 名前の後ろに「ON <表>」が付く種類 (対象のうち、スキーマを補うのは表の名前) */
const KINDS_ON_TABLE = new Set(['TRIGGER', 'POLICY', 'CONSTRAINT']);
/** スキーマに属さない種類 (名前にスキーマを補わない) */
const KINDS_WITHOUT_SCHEMA = new Set(['SCHEMA', 'EXTENSION', 'ROLE']);

export type CommentStatement = {
  /** 種類と対象をそろえた鍵 (例: `COLUMN public.user_sessions_metadata.alert_status`・`FUNCTION public.f(jsonb)`) */
  key: string;
  /** コメントの文 (IS NULL なら null) */
  text: string | null;
};

export type EffectiveComment = { file: string; text: string | null };

/**
 * SQL から -- と /* *\/ のコメントを外し、$…$ で囲んだ本文を空にする ('…' の文字列と "…" の名前の中はそのまま残す。
 * 文字列の中の -- や $ をコメント・本文の始まりと取り違えない)
 */
export function sqlTopLevelText(sql: string): string {
  let out = '';
  let at = 0;
  while (at < sql.length) {
    const char = sql[at];
    const next = sql[at + 1];
    if (char === '-' && next === '-') {
      const newline = sql.indexOf('\n', at);
      at = newline === -1 ? sql.length : newline;
    } else if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', at + 2);
      at = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (char === "'" || char === '"') {
      let end = at + 1;
      while (end < sql.length) {
        if (sql[end] === char) {
          if (sql[end + 1] === char) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      out += sql.slice(at, end + 1);
      at = end + 1;
    } else if (char === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(at))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, at + tag.length);
        at = end === -1 ? sql.length : end + tag.length;
        out += ' $$ ';
      } else {
        out += char;
        at += 1;
      }
    } else {
      out += char;
      at += 1;
    }
  }
  return out;
}

/** 名前を 1 つの書き方にそろえる (" を外し、空白を詰め、小文字にする) */
const normalizeName = (name: string): string =>
  name
    .replace(/"/g, '')
    .replace(/\s*([().,])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** 引数の括弧の前の名前にスキーマが無ければ補う (`f(jsonb)` → `public.f(jsonb)`) */
function withSchema(name: string, parts: number): string {
  const paren = name.indexOf('(');
  const head = paren === -1 ? name : name.slice(0, paren);
  return head.split('.').length < parts ? `${DEFAULT_SCHEMA}.${name}` : name;
}

/** 種類と対象から鍵を作る */
export function commentKey(kind: string, target: string): string {
  const normalizedKind = kind.replace(/\s+/g, ' ').toUpperCase();
  const name = normalizeName(target);
  let qualified = name;
  if (normalizedKind === 'COLUMN') {
    qualified = withSchema(name, 3);
  } else if (KINDS_ON_TABLE.has(normalizedKind)) {
    const [object, table] = name.split(' on ');
    qualified = table === undefined ? name : `${object} on ${withSchema(table, 2)}`;
  } else if (!KINDS_WITHOUT_SCHEMA.has(normalizedKind)) {
    qualified = withSchema(name, 2);
  }
  return `${normalizedKind} ${qualified}`;
}

/** SQL の COMMENT ON の文 (出てくる順) */
export function commentStatementsIn(sql: string): CommentStatement[] {
  return [...sqlTopLevelText(sql).matchAll(COMMENT_STATEMENT)].map(([, kind, target, body]) => ({
    key: commentKey(kind, target),
    text: body === undefined ? null : body.replace(/''/g, "'"),
  }));
}

/** migration を並んだ順 (番号順に並べて渡す) に当てたとき、対象ごとに最後に効くコメントと、それを出した migration */
export function effectiveComments(migrations: readonly { file: string; sql: string }[]): Map<string, EffectiveComment> {
  const effective = new Map<string, EffectiveComment>();
  for (const { file, sql } of migrations) {
    for (const { key, text } of commentStatementsIn(sql)) effective.set(key, { file, text });
  }
  return effective;
}
