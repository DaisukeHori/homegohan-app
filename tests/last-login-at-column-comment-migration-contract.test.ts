// @vitest-environment node
/**
 * #2139 T3: supabase/migrations/20261031120000_last_login_at_column_comment_trigger_names.sql (と、その戻し口) の文面の契約テスト
 * (DB は使わない)。
 *
 * 列 user_profiles.last_login_at のコメント (本番 DB の COMMENT) は、20261016243000_auth_history_sessions.sql で
 * トリガーが呼ぶ関数の名前を「トリガー」と呼んでいた。この migration はコメントだけを出し直し、実際のトリガーの名前
 * (on_auth_session_created・trg_user_profiles_fill_login_stats) を書き、関数の名前は「関数 …」と書く。ここでは
 *   1. 番号は、足したときの origin/main の最大より大きく、11/1 に出す枝の番号より小さい
 *   2. migration を番号順に見て、この列に最後に効く COMMENT はこの migration の文 (後の migration が古い文で上書きしない)
 *   3. 最後に効く文は、migration の CREATE TRIGGER が作る (トリガー, 関数) の組を「トリガー <トリガー> (関数 <関数>)」と書く。
 *      見つけ方が空振りしないこと (この migration の前に効いていた文には反応して赤になる) も確かめる
 *   4. 文は設計書 docs/design/cross/16-auth-history-sessions.md §11.3 の写しと 1 文字も違わない
 *   5. migration は COMMENT ON COLUMN の 1 文 (と lock_timeout) だけで、表・行・関数を変えない
 *   6. 戻し口は、前の migration (20261016243000) の文を format で組み立てて出し直し、組み立てた文は前の文と 1 文字も違わない。
 *      ほかには何も変えない
 *   7. migration と戻し口の 1 行目が互いのファイル名を指し、migration の冒頭が戻し口を案内する
 * を確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261031120000_last_login_at_column_comment_trigger_names';
const MIGRATION_FILE = `${MIGRATION}.sql`;
const ROLLBACK_FILE = `${MIGRATION}.down.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', ROLLBACK_FILE);
/** この列のコメントを前に出した migration (トリガーが呼ぶ関数の名前を「トリガー」と呼んでいた文) */
const PREVIOUS_MIGRATION_FILE = '20261016243000_auth_history_sessions.sql';
/** この migration を足したときの origin/main の最大の版 (これより大きくなければ本番へ当たらない) */
const PREVIOUS_MAX_VERSION = '20261031100000';
/** 11/1 に出す枝 (feat/recipe-author-name-db) の migration の版。これより小さくして、その枝の番号を付け直さずに済むようにする */
const NEXT_BRANCH_VERSION = '20261101090000';
const DESIGN_DOC = path.join(ROOT, 'docs', 'design', 'cross', '16-auth-history-sessions.md');

const COLUMN = 'public.user_profiles.last_login_at';
/** この列の書き手の (トリガー, 関数) の組 (20261016243000 の CREATE TRIGGER) */
const WRITER_PAIRS = [
  { trigger: 'on_auth_session_created', fn: 'auth_session_created' },
  { trigger: 'trg_user_profiles_fill_login_stats', fn: 'user_profiles_fill_login_stats' },
] as const;

const read = (file: string): string => fs.readFileSync(file, 'utf-8');
/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** SQL の 1 つの文字列リテラル ('…'。'' は ' 1 文字) */
const SQL_LITERAL = String.raw`'((?:[^']|'')*)'`;
const unquote = (body: string): string => body.replace(/''/g, "'");

/** 文の中の「COMMENT ON COLUMN <列> IS '…';」の文字列 (出てくる順) */
function columnCommentsIn(text: string): string[] {
  const pattern = new RegExp(String.raw`COMMENT\s+ON\s+COLUMN\s+${escapeRegExp(COLUMN)}\s+IS\s+${SQL_LITERAL}\s*;`, 'g');
  return [...text.matchAll(pattern)].map((match) => unquote(match[1]));
}

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: read(path.join(MIGRATIONS_DIR, file)) }));

/** 番号順に当てたとき、この列に最後に効く COMMENT の文と、それを出した migration */
function effectiveComment(files: readonly { file: string; sql: string }[]): { file: string; text: string } | undefined {
  let last: { file: string; text: string } | undefined;
  for (const { file, sql } of files) {
    for (const text of columnCommentsIn(stripLineComments(sql))) last = { file, text };
  }
  return last;
}

/** migration の CREATE TRIGGER 文ごとの (トリガー, 関数) の組 (名前の " とスキーマの接頭辞は外す) */
function triggerPairsIn(sql: string): { trigger: string; fn: string }[] {
  const pattern =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?(\w+)"?[\s\S]*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\(/gi;
  return [...stripLineComments(sql).matchAll(pattern)].map(([, trigger, fn]) => ({ trigger, fn }));
}

/** 文が書き手の組を全部「トリガー <トリガー> (関数 <関数>)」と書き、関数の名前を「トリガー」の直後に書かない */
function namesWriterTriggersCorrectly(text: string): boolean {
  return WRITER_PAIRS.every(
    ({ trigger, fn }) =>
      text.includes(`トリガー ${trigger} (関数 ${fn})`) && !new RegExp(`トリガー\\s*${escapeRegExp(fn)}(?![A-Za-z0-9_])`).test(text),
  );
}

const sql = read(path.join(MIGRATIONS_DIR, MIGRATION_FILE));
const rawRollback = read(ROLLBACK_PATH);
const rollback = stripLineComments(rawRollback);

/** SQL を ; で文に分ける (DO $$ … $$ の中の ; では分けない)。空の文は除く */
function statementsOf(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let at = 0; at < text.length; at += 1) {
    if (text.startsWith('$$', at)) {
      inDollar = !inDollar;
      current += '$$';
      at += 1;
      continue;
    }
    const char = text[at];
    if (char === ';' && !inDollar) {
      out.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current.trim());
  return out.filter((statement) => statement.length > 0);
}

/** 表・行・関数・トリガー・権限を変える文の頭の語 */
const SCHEMA_OR_DATA_CHANGE = /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE)\b/i;
const LOCK_TIMEOUT_STATEMENT = /^SET\s+LOCAL\s+lock_timeout\s*=\s*'\d+s'$/i;

describe('列 user_profiles.last_login_at のコメントのトリガーの呼び方 (#2139 T3)', () => {
  it('番号は、足したときの origin/main の最大より大きく、11/1 に出す枝の番号より小さい', () => {
    const version = MIGRATION.slice(0, PREVIOUS_MAX_VERSION.length);
    expect(version > PREVIOUS_MAX_VERSION).toBe(true);
    expect(version < NEXT_BRANCH_VERSION).toBe(true);
    expect(migrations.map(({ file }) => file)).toContain(MIGRATION_FILE);
  });

  it('migration を番号順に見て、この列に最後に効く COMMENT はこの migration の文', () => {
    expect(columnCommentsIn(stripLineComments(sql))).toHaveLength(1);
    expect(effectiveComment(migrations)).toEqual({ file: MIGRATION_FILE, text: columnCommentsIn(stripLineComments(sql))[0] });
  });

  it('最後に効く文は、CREATE TRIGGER が作る (トリガー, 関数) の組を「トリガー <トリガー> (関数 <関数>)」と書く', () => {
    const allPairs = migrations.flatMap(({ sql: text }) => triggerPairsIn(text));
    expect(allPairs).toEqual(expect.arrayContaining([...WRITER_PAIRS]));
    // 書き手のトリガーの名前は関数の名前と別 (同じなら「トリガー <関数>」でも正しく、この検査の前提が崩れる)
    expect(WRITER_PAIRS.filter(({ trigger, fn }) => trigger === fn)).toEqual([]);

    const effective = effectiveComment(migrations);
    expect(effective).toBeDefined();
    expect(namesWriterTriggersCorrectly(effective?.text ?? '')).toBe(true);
  });

  it('見つけ方が空振りしない: この migration の前に効いていた文 (20261016243000) には反応して赤になる', () => {
    const before = effectiveComment(migrations.filter(({ file }) => file < MIGRATION_FILE));
    expect(before?.file).toBe(PREVIOUS_MIGRATION_FILE);
    expect(namesWriterTriggersCorrectly(before?.text ?? '')).toBe(false);
    // 前の文は、関数の名前を「トリガー」の直後に書いていた (書き手の 2 組とも)
    for (const { fn } of WRITER_PAIRS) {
      expect(before?.text ?? '').toMatch(new RegExp(`トリガー\\s*${escapeRegExp(fn)}(?![A-Za-z0-9_])`));
    }
  });

  it('文は設計書 cross/16 §11.3 の写しと 1 文字も違わない', () => {
    const designSection = read(DESIGN_DOC).split(/^### /m).find((section) => section.startsWith('11.3 '));
    expect(designSection, 'cross/16 に §11.3 の見出しが無い').toBeDefined();
    expect(columnCommentsIn(designSection ?? '')).toEqual(columnCommentsIn(stripLineComments(sql)));
  });

  it('migration は COMMENT ON COLUMN の 1 文 (と lock_timeout) だけで、表・行・関数を変えない', () => {
    const statements = statementsOf(stripLineComments(sql));
    const others = statements.filter((statement) => !LOCK_TIMEOUT_STATEMENT.test(statement));
    expect(others).toHaveLength(1);
    expect(others[0]).toMatch(new RegExp(String.raw`^COMMENT\s+ON\s+COLUMN\s+${escapeRegExp(COLUMN)}\s+IS\s+'`));
    // 文字列リテラルの外に、表・行・関数・トリガー・権限を変える語が無い
    const outsideLiterals = stripLineComments(sql).replace(new RegExp(SQL_LITERAL, 'g'), "''");
    expect(outsideLiterals).not.toMatch(SCHEMA_OR_DATA_CHANGE);
  });

  it('戻し口は前の migration の文を出し直し、組み立てた文は前の文と 1 文字も違わない', () => {
    const previous = columnCommentsIn(stripLineComments(read(path.join(MIGRATIONS_DIR, PREVIOUS_MIGRATION_FILE))));
    expect(previous).toHaveLength(1);

    // EXECUTE format('COMMENT ON COLUMN <列> IS %L', format('<型>', '<名前>', '<名前>'))
    const outer = new RegExp(
      String.raw`EXECUTE\s+format\(\s*'COMMENT\s+ON\s+COLUMN\s+${escapeRegExp(COLUMN)}\s+IS\s+%L'\s*,\s*format\(\s*${SQL_LITERAL}((?:\s*,\s*${SQL_LITERAL})*)\s*\)\s*\)\s*;`,
    );
    const match = rollback.match(outer);
    expect(match, '戻し口に EXECUTE format(... %L, format(...)) の文が無い').not.toBeNull();
    const template = unquote(match?.[1] ?? '');
    const args = [...(match?.[2] ?? '').matchAll(new RegExp(SQL_LITERAL, 'g'))].map((arg) => unquote(arg[1]));
    expect(template.split('%s')).toHaveLength(args.length + 1);
    const rebuilt = args.reduce((text, arg) => text.replace('%s', arg), template);
    expect(rebuilt).toBe(previous[0]);
    // 組み立てた文は、書き手の関数の名前を 2 つとも入れる (順は文の順)
    expect(args).toEqual(WRITER_PAIRS.map(({ fn }) => fn));
  });

  it('戻し口は列のコメントのほかに何も変えない', () => {
    const statements = statementsOf(rollback);
    const others = statements.filter((statement) => !LOCK_TIMEOUT_STATEMENT.test(statement));
    expect(others).toHaveLength(1);
    expect(others[0]).toMatch(/^DO\s+\$\$/);
    const outsideLiterals = rollback.replace(new RegExp(SQL_LITERAL, 'g'), "''");
    expect(outsideLiterals).not.toMatch(SCHEMA_OR_DATA_CHANGE);
    expect(columnCommentsIn(rollback)).toEqual([]);
  });

  it('migration と戻し口の 1 行目が互いのファイル名を指し、migration の冒頭が戻し口を案内する', () => {
    expect(sql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION_FILE}`);
    expect(rawRollback.split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
    expect(sql).toContain(`supabase/rollbacks/${ROLLBACK_FILE}`);
  });
});
