/**
 * #1867 (§24 Q-13) バッジの説明を付く条件に合わせる migration (20261018040000_badges_description_matches_award.sql) と、
 * planner の説明を AI の週の献立の生成でも付くことに合わせた migration (20261018050000_planner_badge_description_weekly_menu.sql) を読む道具。
 * 静的な検査 (tests/badges-description-matches-award-contract.test.ts) と結合テスト
 * (tests/integration/security/badges-description-matches-award.test.ts) の両方が使う。
 */
import fs from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '../..');

export const BADGE_DESCRIPTION_MIGRATION = 'supabase/migrations/20261018040000_badges_description_matches_award.sql';
export const BADGE_DESCRIPTION_ROLLBACK = 'supabase/rollbacks/20261018040000_badges_description_matches_award.down.sql';
/**
 * #1867 planner が AI の週の献立の生成でも付くようになったのに合わせ、planner の説明だけをもう一度書き換えた migration と戻し口
 * (20261018040000 の後に当たる。planner のいまの説明はこちらの文)
 */
export const PLANNER_DESCRIPTION_MIGRATION = 'supabase/migrations/20261018050000_planner_badge_description_weekly_menu.sql';
export const PLANNER_DESCRIPTION_ROLLBACK = 'supabase/rollbacks/20261018050000_planner_badge_description_weekly_menu.down.sql';

/** バッジの説明を書き換える migration と戻し口。当たる順 (版の番号の順) に並べる。戻すときは逆順 */
export const BADGE_DESCRIPTION_MIGRATIONS = [
  { migration: BADGE_DESCRIPTION_MIGRATION, rollback: BADGE_DESCRIPTION_ROLLBACK },
  { migration: PLANNER_DESCRIPTION_MIGRATION, rollback: PLANNER_DESCRIPTION_ROLLBACK },
] as const;

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

/**
 * 説明を書き換える migration を当てる順に全部当てたあとの説明 (code → 文)。後の migration の文が勝つ。
 * migration を当てた DB のいまの説明と同じになる
 */
export function currentBadgeDescriptions(): Map<string, string> {
  const current = new Map<string, string>();
  for (const { migration } of BADGE_DESCRIPTION_MIGRATIONS) {
    for (const [code, text] of parseDescriptionUpdates(readRepoFile(migration))) current.set(code, text);
  }
  return current;
}
