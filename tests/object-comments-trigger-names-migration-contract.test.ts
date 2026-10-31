// @vitest-environment node
/**
 * #2144 S4: supabase/migrations/20261031130000_object_comments_trigger_names.sql (と、その戻し口) の文面の契約テスト
 * (DB は使わない。#2141 の tests/last-login-at-column-comment-migration-contract.test.ts と同じ形)。
 *
 * 本番 DB のコメント 6 つ (列 user_sessions_metadata.alert_status・関数 membership_audit_hash_email_in_metadata(jsonb)・
 * 表 account_deletion_guards・関数 personal_subscription_hold_plan_key_share() / family_group_hold_plan_key_share() /
 * organization_hold_plan_key_share()) は、既存の migration でトリガーが呼ぶ関数の名前を「トリガー」と呼んでいた。
 * この migration はコメントだけを出し直し、実際のトリガーの名前を書き、関数の名前は「関数 …」と書く。ここでは
 *   1. 番号は、足したときの origin/main の最大より大きく、11/1 に出す枝の番号より小さい
 *   2. migration を番号順に見て、6 つの対象に最後に効く COMMENT はこの migration の文 (後の migration が古い文で上書きしない)。
 *      後で出し直した対象 (REISSUED_LATER) は、名指しした migration の文が最後に効く (その文面はその migration の契約テストが確かめる)
 *   3. 新しい文は、前に効いていた文の「トリガー <関数>」(1 か所) を「トリガー <トリガー> (関数 <関数>)」に置き換えただけ
 *      (ほかの文字は変えない)。(トリガー, 関数) の組は migration の CREATE TRIGGER が作るもの。
 *      見つけ方が空振りしないこと (前に効いていた文には反応して赤になる) も確かめる
 *   4. 列 alert_status の文は設計書 docs/design/cross/16-auth-history-sessions.md §11.1 の写しと 1 文字も違わない
 *   5. migration は COMMENT ON の 6 文 (と lock_timeout) だけで、表・行・関数を変えない
 *   6. 戻し口は、前に効いていた 6 つの文を format で組み立てて出し直し、組み立てた文は前の文と 1 文字も違わない。
 *      ほかには何も変えない
 *   7. migration と戻し口の 1 行目が互いのファイル名を指し、migration の冒頭が戻し口を案内する
 * を確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentKey, commentStatementsIn, effectiveComments, sqlTopLevelText } from './helpers/sql-comment-statements';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261031130000_object_comments_trigger_names';
const MIGRATION_FILE = `${MIGRATION}.sql`;
const ROLLBACK_FILE = `${MIGRATION}.down.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', ROLLBACK_FILE);
/** この migration を足したときの origin/main の最大の版 (これより大きくなければ本番へ当たらない) */
const PREVIOUS_MAX_VERSION = '20261031120000';
/** 11/1 に出す枝 (feat/recipe-author-name-db) の migration の版。これより小さくして、その枝の番号を付け直さずに済むようにする */
const NEXT_BRANCH_VERSION = '20261101090000';
const DESIGN_DOC = path.join(ROOT, 'docs', 'design', 'cross', '16-auth-history-sessions.md');
/** 設計書で列 alert_status の COMMENT の写しを持つ節の見出し */
const DESIGN_SECTION_HEADING = '11.1 ';

type Target = {
  /** COMMENT ON の種類と対象 (この migration の書き方) */
  kind: string;
  target: string;
  /** 前にこのコメントを出した migration (トリガーが呼ぶ関数の名前を「トリガー」と呼んでいた文) */
  previousFile: string;
  /** 文の中で呼ぶトリガーと、そのトリガーが呼ぶ関数 (migration の CREATE TRIGGER の組) */
  trigger: string;
  fn: string;
};

/** 出し直す 6 つ (migration と戻し口の文の順) */
const TARGETS: readonly Target[] = [
  {
    kind: 'COLUMN',
    target: 'public.user_sessions_metadata.alert_status',
    previousFile: '20261016243000_auth_history_sessions.sql',
    trigger: 'on_auth_session_created',
    fn: 'auth_session_created',
  },
  {
    kind: 'FUNCTION',
    target: 'public.membership_audit_hash_email_in_metadata(jsonb)',
    previousFile: '20261016190000_deletion_record_and_invite_email_hash.sql',
    trigger: 'trg_membership_audit_hash_invite_email',
    fn: 'membership_audit_hash_invite_email',
  },
  {
    kind: 'TABLE',
    target: 'public.account_deletion_guards',
    previousFile: '20261023130000_account_deletion_owner_guard.sql',
    trigger: 'trg_organizations_owner_not_deleting',
    fn: 'organizations_owner_not_deleting',
  },
  {
    kind: 'FUNCTION',
    target: 'public.personal_subscription_hold_plan_key_share()',
    previousFile: '20261024130000_plan_deprecate_lock_and_price_change_reservation.sql',
    trigger: 'trg_guard_plan_deprecate_subscribers',
    fn: 'guard_plan_deprecate_subscribers',
  },
  {
    kind: 'FUNCTION',
    target: 'public.family_group_hold_plan_key_share()',
    previousFile: '20261024130000_plan_deprecate_lock_and_price_change_reservation.sql',
    trigger: 'trg_guard_plan_deprecate_subscribers',
    fn: 'guard_plan_deprecate_subscribers',
  },
  {
    kind: 'FUNCTION',
    target: 'public.organization_hold_plan_key_share()',
    previousFile: '20261024130000_plan_deprecate_lock_and_price_change_reservation.sql',
    trigger: 'trg_guard_plan_deprecate_subscribers',
    fn: 'guard_plan_deprecate_subscribers',
  },
];
/** 列 alert_status (設計書の写しと突き合わせる対象) */
const ALERT_STATUS = TARGETS[0];

const read = (file: string): string => fs.readFileSync(file, 'utf-8');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** SQL の 1 つの文字列リテラル ('…'。'' は ' 1 文字) */
const SQL_LITERAL = String.raw`'((?:[^']|'')*)'`;
const unquote = (body: string): string => body.replace(/''/g, "'");
/** SQL の -- のコメントを外す ($$ … $$ の本文を残したまま見るため。ここで見る文字列の中に -- は無い) */
const stripLineComments = (text: string): string => text.replace(/--.*$/gm, '');
const keyOf = ({ kind, target }: Target): string => commentKey(kind, target);
/** 関数の名前を「トリガー」の直後に書く所 (間に空白・` ・ ( だけを挟む) */
const triggerBeforeFn = (fn: string): RegExp => new RegExp(`トリガー[\\s\`(]*${escapeRegExp(fn)}(?![A-Za-z0-9_])`);

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: read(path.join(MIGRATIONS_DIR, file)) }));
const before = effectiveComments(migrations.filter(({ file }) => file < MIGRATION_FILE));
/** この migration までを当てたときのコメント (後で出し直した対象も、この migration が出した文を見る) */
const asOfThis = effectiveComments(migrations.filter(({ file }) => file <= MIGRATION_FILE));
const after = effectiveComments(migrations);

/**
 * この migration の後に出し直した対象と、出し直した migration。表に無い対象を後の migration が上書きしたら赤にする
 * (表 account_deletion_guards は #2150 Q4 が家族の代表者のトリガーを書き足した。
 * 文面は tests/account-deletion-guards-comment-family-representative-migration-contract.test.ts が確かめる)
 */
const REISSUED_LATER: ReadonlyMap<string, string> = new Map([
  [commentKey('TABLE', 'public.account_deletion_guards'), '20261031140000_account_deletion_guards_comment_family_representative.sql'],
]);

/**
 * migration の CREATE TRIGGER 文ごとの (トリガー, 関数) の組 (名前の " とスキーマの接頭辞は外す)。
 * DO $$ … $$ の中の CREATE TRIGGER (auth の表のトリガーは同じ名前が無いときだけ作る) も読むので、本文は残して -- のコメントだけ外す
 */
function triggerPairsIn(sql: string): { trigger: string; fn: string }[] {
  const pattern =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?(\w+)"?[\s\S]*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\(/gi;
  return [...stripLineComments(sql).matchAll(pattern)].map(([, trigger, fn]) => ({ trigger, fn }));
}

/** 文が組を「トリガー <トリガー> (関数 <関数>)」と書き、関数の名前を「トリガー」の直後に書かない */
const namesTriggerCorrectly = (text: string, { trigger, fn }: Target): boolean =>
  text.includes(`トリガー ${trigger} (関数 ${fn})`) && !triggerBeforeFn(fn).test(text);

const sql = read(path.join(MIGRATIONS_DIR, MIGRATION_FILE));
const rawRollback = read(ROLLBACK_PATH);
const rollback = sqlTopLevelText(rawRollback);

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

describe('本番のコメントのトリガーの呼び方 (#2144 S4)', () => {
  it('番号は、足したときの origin/main の最大より大きく、11/1 に出す枝の番号より小さい', () => {
    const version = MIGRATION.slice(0, PREVIOUS_MAX_VERSION.length);
    expect(version > PREVIOUS_MAX_VERSION).toBe(true);
    expect(version < NEXT_BRANCH_VERSION).toBe(true);
    expect(migrations.map(({ file }) => file)).toContain(MIGRATION_FILE);
  });

  it('migration を番号順に見て、6 つの対象に最後に効く COMMENT はこの migration の文 (後で出し直した対象は名指しした migration の文)', () => {
    const own = commentStatementsIn(sql);
    expect(own.map(({ key }) => key)).toEqual(TARGETS.map(keyOf));
    for (const [index, target] of TARGETS.entries()) {
      expect(asOfThis.get(keyOf(target))).toEqual({ file: MIGRATION_FILE, text: own[index].text });
      expect(after.get(keyOf(target))?.file, keyOf(target)).toBe(REISSUED_LATER.get(keyOf(target)) ?? MIGRATION_FILE);
    }
    // 名指しした migration は、この migration より後で、出し直す対象はこの migration の対象
    for (const [key, file] of REISSUED_LATER) {
      expect(file > MIGRATION_FILE, file).toBe(true);
      expect(TARGETS.map(keyOf)).toContain(key);
    }
  });

  it('新しい文は、前に効いていた文の「トリガー <関数>」を「トリガー <トリガー> (関数 <関数>)」に置き換えただけ', () => {
    const allPairs = migrations.flatMap(({ sql: text }) => triggerPairsIn(text));
    for (const target of TARGETS) {
      const { trigger, fn, previousFile } = target;
      // 組は migration の CREATE TRIGGER が作るもので、トリガーの名前は関数の名前と別
      expect(allPairs).toContainEqual({ trigger, fn });
      expect(trigger).not.toBe(fn);

      const previous = before.get(keyOf(target));
      expect(previous?.file, keyOf(target)).toBe(previousFile);
      const previousText = previous?.text ?? '';
      // 前の文は関数の名前を「トリガー」の直後に 1 か所だけ書いていた
      expect(previousText.match(new RegExp(`トリガー ${escapeRegExp(fn)}(?![A-Za-z0-9_])`, 'g')), keyOf(target)).toHaveLength(1);
      const expected = previousText.replace(
        new RegExp(`トリガー ${escapeRegExp(fn)}(?![A-Za-z0-9_])`),
        `トリガー ${trigger} (関数 ${fn})`,
      );
      expect(asOfThis.get(keyOf(target))?.text, keyOf(target)).toBe(expected);
      expect(namesTriggerCorrectly(expected, target), keyOf(target)).toBe(true);
    }
  });

  it('見つけ方が空振りしない: この migration の前に効いていた文には反応して赤になる', () => {
    for (const target of TARGETS) {
      const previousText = before.get(keyOf(target))?.text ?? '';
      expect(namesTriggerCorrectly(previousText, target), keyOf(target)).toBe(false);
      expect(previousText, keyOf(target)).toMatch(triggerBeforeFn(target.fn));
    }
  });

  it('列 alert_status の文は設計書 cross/16 §11.1 の写しと 1 文字も違わない', () => {
    const designSection = read(DESIGN_DOC)
      .split(/^### /m)
      .find((section) => section.startsWith(DESIGN_SECTION_HEADING));
    expect(designSection, 'cross/16 に §11.1 の見出しが無い').toBeDefined();
    const copies = commentStatementsIn(designSection ?? '').filter(({ key }) => key === keyOf(ALERT_STATUS));
    expect(copies).toHaveLength(1);
    expect(copies[0].text).toBe(after.get(keyOf(ALERT_STATUS))?.text);
  });

  it('migration は COMMENT ON の 6 文 (と lock_timeout) だけで、表・行・関数を変えない', () => {
    const statements = statementsOf(stripLineComments(sql));
    const others = statements.filter((statement) => !LOCK_TIMEOUT_STATEMENT.test(statement));
    expect(others).toHaveLength(TARGETS.length);
    for (const [index, target] of TARGETS.entries()) {
      expect(others[index]).toMatch(
        new RegExp(String.raw`^COMMENT\s+ON\s+${target.kind}\s+${escapeRegExp(target.target)}\s+IS\s+'`),
      );
    }
    // 文字列リテラルの外に、表・行・関数・トリガー・権限を変える語が無い
    const outsideLiterals = stripLineComments(sql).replace(new RegExp(SQL_LITERAL, 'g'), "''");
    expect(outsideLiterals).not.toMatch(SCHEMA_OR_DATA_CHANGE);
  });

  it('戻し口は前に効いていた 6 つの文を出し直し、組み立てた文は前の文と 1 文字も違わない', () => {
    const body = stripLineComments(rawRollback);
    // EXECUTE format('COMMENT ON <種類> <対象> IS %L', format('<型>', '<名前>'…))
    const pattern = new RegExp(
      String.raw`EXECUTE\s+format\(\s*'COMMENT\s+ON\s+(\w+)\s+([^']+?)\s+IS\s+%L'\s*,\s*format\(\s*${SQL_LITERAL}((?:\s*,\s*${SQL_LITERAL})*)\s*\)\s*\)\s*;`,
      'g',
    );
    const rebuilt = [...body.matchAll(pattern)].map((match) => {
      const template = unquote(match[3]);
      const args = [...match[4].matchAll(new RegExp(SQL_LITERAL, 'g'))].map((arg) => unquote(arg[1]));
      expect(template.split('%s')).toHaveLength(args.length + 1);
      return { key: commentKey(match[1], match[2]), text: args.reduce((text, arg) => text.replace('%s', arg), template), args };
    });
    expect(rebuilt.map(({ key }) => key)).toEqual(TARGETS.map(keyOf));
    for (const [index, target] of TARGETS.entries()) {
      expect(rebuilt[index].text, keyOf(target)).toBe(before.get(keyOf(target))?.text);
      // 組み立てた文は、トリガーが呼ぶ関数の名前を入れる
      expect(rebuilt[index].args, keyOf(target)).toEqual([target.fn]);
    }
  });

  it('戻し口はコメントのほかに何も変えない', () => {
    const statements = statementsOf(stripLineComments(rawRollback));
    const others = statements.filter((statement) => !LOCK_TIMEOUT_STATEMENT.test(statement));
    expect(others).toHaveLength(1);
    expect(others[0]).toMatch(/^DO\s+\$\$/);
    const outsideLiterals = stripLineComments(rawRollback).replace(new RegExp(SQL_LITERAL, 'g'), "''");
    expect(outsideLiterals).not.toMatch(SCHEMA_OR_DATA_CHANGE);
    // 戻し口は COMMENT を直に書かない (DO の本文の外に COMMENT ON の文が無い)
    expect(commentStatementsIn(rollback)).toEqual([]);
    // DO の本文の中の EXECUTE は 6 つ (出し直した対象の数)
    expect(stripLineComments(rawRollback).match(/\bEXECUTE\s+format\(/g)).toHaveLength(TARGETS.length);
  });

  it('migration と戻し口の 1 行目が互いのファイル名を指し、migration の冒頭が戻し口を案内する', () => {
    expect(sql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION_FILE}`);
    expect(rawRollback.split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
    expect(sql).toContain(`supabase/rollbacks/${ROLLBACK_FILE}`);
  });
});
