/**
 * #1867 (§24 Q-13) バッジの説明を付く条件に合わせる migration (20261018040000_badges_description_matches_award.sql) を読む道具。
 * 静的な検査 (tests/badges-description-matches-award-contract.test.ts) と結合テスト
 * (tests/integration/security/badges-description-matches-award.test.ts) の両方が使う。
 */
import fs from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '../..');

export const BADGE_DESCRIPTION_MIGRATION = 'supabase/migrations/20261018040000_badges_description_matches_award.sql';
export const BADGE_DESCRIPTION_ROLLBACK = 'supabase/rollbacks/20261018040000_badges_description_matches_award.down.sql';
/** badges の元の行 (INSERT) がある migration。本番スキーマのベースラインを入れたもので、書き換えられない */
export const BADGE_ORIGINAL_MIGRATION = 'supabase/migrations/20251126124224_create_meal_planner_tables.sql';

export function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

/** `-- ...` の行コメントを外す (SQL の文字列の中に `--` は無い前提。下の parse が文を全部読めたかを確かめるので、崩れたら検査が赤になる) */
export function stripSqlLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** SQL の文字列リテラルの中身を戻す ('' → ') */
function unquote(literal: string): string {
  return literal.replace(/''/g, "'");
}

/**
 * `UPDATE public.badges SET description = '<文>' WHERE code = '<code>';` の並びを読む。
 * それ以外の文が 1 つでもあれば例外にする (description 以外を書き換えていないことを、読めた文で全部説明できることで確かめる)。
 */
export function parseDescriptionUpdates(sql: string): Map<string, string> {
  const body = stripSqlLineComments(sql);
  const statement = /UPDATE\s+public\.badges\s+SET\s+description\s*=\s*'((?:[^']|'')*)'\s+WHERE\s+code\s*=\s*'([a-z0-9_]+)'\s*;/g;
  const updates = new Map<string, string>();
  for (const match of body.matchAll(statement)) {
    const code = match[2];
    if (updates.has(code)) throw new Error(`${code} の UPDATE が 2 つあります`);
    updates.set(code, unquote(match[1]));
  }
  const rest = body.replace(statement, '').trim();
  if (rest !== '') throw new Error(`badges の description の UPDATE 以外の文があります: ${rest.slice(0, 200)}`);
  return updates;
}

export interface OriginalBadgeRow {
  code: string;
  name: string;
  description: string;
  conditionJson: string;
}

/** 元の migration の `INSERT INTO public.badges` の行 (code → 行) */
export function readOriginalBadgeRows(): Map<string, OriginalBadgeRow> {
  const rows = new Map<string, OriginalBadgeRow>();
  const insert = /INSERT INTO public\.badges \([^)]*\) VALUES \('[^']*', '([^']*)', '([^']*)', '([^']*)', '([^']*)'/g;
  for (const match of readRepoFile(BADGE_ORIGINAL_MIGRATION).matchAll(insert)) {
    rows.set(match[1], { code: match[1], name: match[2], description: match[3], conditionJson: match[4] });
  }
  return rows;
}
