// @vitest-environment node
/**
 * #2150 Q4: supabase/migrations/20261031140000_account_deletion_guards_comment_family_representative.sql (と、その戻し口) の
 * 文面の契約テスト (DB は使わない。#2144 S4 の tests/object-comments-trigger-names-migration-contract.test.ts と同じ形)。
 *
 * 表 account_deletion_guards (退会の印) の本番のコメントは、印を読むものとして組織の作成のトリガーだけを書いていた。
 * 家族の作成と代表者の変更のトリガー (20261023150000) も同じ印を読むので、この migration はコメントだけを出し直し、両方を書く。ここでは
 *   1. 番号は、足したときの origin/main の最大より大きく、11/1 に出す枝の番号より小さい
 *   2. migration を番号順に見て、表 account_deletion_guards に最後に効く COMMENT はこの migration の文
 *      (後の migration が古い文で上書きしない)
 *   3. 新しい文は、前に効いていた文 (20261031130000) の「トリガー <組織のトリガー> (関数 …) が組織の作成で読む」(1 か所) を
 *      「組織の作成ではトリガー <組織のトリガー> (関数 …) が、家族の作成と代表者の変更ではトリガー <家族のトリガー> (関数 …) が読む」に
 *      置き換えただけ (ほかの文字は変えない)
 *   4. 文に書いた (トリガー, 関数) の組は migration の CREATE TRIGGER が作るもの (最後の定義)。トリガーの表と契機は文の言葉
 *      (組織の作成 = organizations の INSERT・家族の作成と代表者の変更 = family_groups の INSERT と representative_id の UPDATE) と合い、
 *      関数の本文 (最後の定義) は表 account_deletion_guards を読む。見つけ方が空振りしないこと (前に効いていた文には反応して赤になる) も確かめる
 *   5. migration は COMMENT ON の 1 文 (と lock_timeout) だけで、表・行・関数を変えない
 *   6. 戻し口は前に効いていた文を出し直し、その文は前の文と 1 文字も違わない。ほかには何も変えない
 *   7. migration と戻し口の 1 行目が互いのファイル名を指し、migration の冒頭が戻し口を案内する
 * を確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentKey, commentStatementsIn, effectiveComments } from './helpers/sql-comment-statements';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261031140000_account_deletion_guards_comment_family_representative';
const MIGRATION_FILE = `${MIGRATION}.sql`;
const ROLLBACK_FILE = `${MIGRATION}.down.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', ROLLBACK_FILE);
/** この migration を足したときの origin/main の最大の版 (これより大きくなければ本番へ当たらない) */
const PREVIOUS_MAX_VERSION = '20261031130000';
/** 11/1 に出す枝 (feat/recipe-author-name-db) の migration の版。これより小さくして、その枝の番号を付け直さずに済むようにする */
const NEXT_BRANCH_VERSION = '20261101090000';
/** 前にこの表のコメントを出した migration (#2144 S4) */
const PREVIOUS_FILE = '20261031130000_object_comments_trigger_names.sql';
const TABLE_KEY = commentKey('TABLE', 'public.account_deletion_guards');
/** 印の表 (関数の本文が読むこと) */
const GUARD_TABLE = 'public.account_deletion_guards';

type Reader = {
  trigger: string;
  fn: string;
  /** トリガーを付ける表 */
  table: string;
  /** CREATE TRIGGER の契機 (BEFORE の後・ON の前。空白は 1 つにそろえる) */
  events: string;
};

/** 組織の作成で印を読むトリガー (20261023130000) */
const ORGANIZATION_READER: Reader = {
  trigger: 'trg_organizations_owner_not_deleting',
  fn: 'organizations_owner_not_deleting',
  table: 'public.organizations',
  events: 'INSERT',
};
/** 家族の作成と代表者の変更で印を読むトリガー (20261023150000) */
const FAMILY_REPRESENTATIVE_READER: Reader = {
  trigger: 'trg_representative_not_deleting',
  fn: 'family_groups_representative_not_deleting',
  table: 'public.family_groups',
  events: 'INSERT OR UPDATE OF representative_id',
};
const READERS: readonly Reader[] = [ORGANIZATION_READER, FAMILY_REPRESENTATIVE_READER];

/** 前の文で置き換える所と、置き換えた後の所 */
const PREVIOUS_PHRASE = `トリガー ${ORGANIZATION_READER.trigger} (関数 ${ORGANIZATION_READER.fn}) が組織の作成で読む`;
const NEW_PHRASE =
  `組織の作成ではトリガー ${ORGANIZATION_READER.trigger} (関数 ${ORGANIZATION_READER.fn}) が、` +
  `家族の作成と代表者の変更ではトリガー ${FAMILY_REPRESENTATIVE_READER.trigger} (関数 ${FAMILY_REPRESENTATIVE_READER.fn}) が読む`;

const read = (file: string): string => fs.readFileSync(file, 'utf-8');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** SQL の 1 つの文字列リテラル ('…'。'' は ' 1 文字) */
const SQL_LITERAL = String.raw`'((?:[^']|'')*)'`;
/** SQL の -- のコメントを外す ($…$ の本文を残したまま見るため。ここで見る文字列の中に -- は無い) */
const stripLineComments = (text: string): string => text.replace(/--.*$/gm, '');
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: read(path.join(MIGRATIONS_DIR, file)) }));
const before = effectiveComments(migrations.filter(({ file }) => file < MIGRATION_FILE));
const after = effectiveComments(migrations);

const sql = read(path.join(MIGRATIONS_DIR, MIGRATION_FILE));
const rawRollback = read(ROLLBACK_PATH);

type TriggerDefinition = { file: string; trigger: string; events: string; table: string; fn: string };

/**
 * migration の CREATE TRIGGER 文 (BEFORE / AFTER の行トリガー) を番号順に読む (名前の " とスキーマの接頭辞は外す)。
 * 契機は ; をまたがない (文の行トリガーでない CREATE TRIGGER から次の文へ読み進めない)
 */
function triggerDefinitions(): TriggerDefinition[] {
  const pattern =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?(\w+)"?\s+(?:BEFORE|AFTER)\s+([^;]+?)\s+ON\s+((?:"?\w+"?\.)?"?\w+"?)\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\(/gi;
  return migrations.flatMap(({ file, sql: text }) =>
    [...stripLineComments(text).matchAll(pattern)].map(([, trigger, events, table, fn]) => ({
      file,
      trigger,
      events: squash(events),
      table: table.replace(/"/g, ''),
      fn,
    })),
  );
}

/** トリガーの最後の定義 (番号順で最後の CREATE TRIGGER) */
const lastTriggerDefinition = (trigger: string): TriggerDefinition | undefined =>
  triggerDefinitions()
    .filter((definition) => definition.trigger === trigger)
    .at(-1);

/** 関数 public.<fn>() の最後の定義の本文 ($tag$ … $tag$ の中)。無ければ undefined */
function lastFunctionBody(fn: string): string | undefined {
  const head = new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.${escapeRegExp(fn)}\s*\(\s*\)`, 'gi');
  let body: string | undefined;
  for (const { sql: text } of migrations) {
    const cleaned = stripLineComments(text);
    for (const match of cleaned.matchAll(head)) {
      const rest = cleaned.slice(match.index + match[0].length);
      const tag = rest.match(/\$(\w*)\$/);
      if (!tag || tag.index === undefined) continue;
      const start = tag.index + tag[0].length;
      const end = rest.indexOf(tag[0], start);
      if (end !== -1) body = rest.slice(start, end);
    }
  }
  return body;
}

/** トリガーを消す文 (DROP TRIGGER) が migration にあるか */
const droppedTrigger = (trigger: string): string[] =>
  migrations
    .filter(({ sql: text }) =>
      new RegExp(String.raw`\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?${escapeRegExp(trigger)}"?(?![A-Za-z0-9_])`, 'i').test(
        stripLineComments(text),
      ),
    )
    .map(({ file }) => file);

/** 文が、印を読むトリガーを 2 つとも「トリガー <トリガー> (関数 <関数>)」と書き、それぞれの契機の言葉を添える */
const namesBothReaders = (text: string): boolean => text.includes(NEW_PHRASE) && !text.includes(PREVIOUS_PHRASE);

/** SQL を ; で文に分ける (空の文は除く。ここで見る SQL に $ … $ の本文は無い) */
const statementsOf = (text: string): string[] =>
  text
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

/** 表・行・関数・トリガー・権限を変える文の頭の語 */
const SCHEMA_OR_DATA_CHANGE = /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|DO|EXECUTE)\b/i;
const LOCK_TIMEOUT_STATEMENT = /^SET\s+LOCAL\s+lock_timeout\s*=\s*'\d+s'$/i;
const TABLE_COMMENT_STATEMENT = new RegExp(
  String.raw`^COMMENT\s+ON\s+TABLE\s+${escapeRegExp(GUARD_TABLE)}\s+IS\s+${SQL_LITERAL}$`,
);

describe('表 account_deletion_guards の本番のコメントに家族の代表者のトリガーを書く (#2150 Q4)', () => {
  it('番号は、足したときの origin/main の最大より大きく、11/1 に出す枝の番号より小さい', () => {
    const version = MIGRATION.slice(0, PREVIOUS_MAX_VERSION.length);
    expect(version > PREVIOUS_MAX_VERSION).toBe(true);
    expect(version < NEXT_BRANCH_VERSION).toBe(true);
    expect(migrations.map(({ file }) => file)).toContain(MIGRATION_FILE);
  });

  it('migration を番号順に見て、表 account_deletion_guards に最後に効く COMMENT はこの migration の文', () => {
    const own = commentStatementsIn(sql);
    expect(own.map(({ key }) => key)).toEqual([TABLE_KEY]);
    expect(after.get(TABLE_KEY)).toEqual({ file: MIGRATION_FILE, text: own[0].text });
  });

  it('新しい文は、前に効いていた文の組織のトリガーの所を、組織と家族の代表者の 2 つのトリガーの所に置き換えただけ', () => {
    const previous = before.get(TABLE_KEY);
    expect(previous?.file).toBe(PREVIOUS_FILE);
    const previousText = previous?.text ?? '';
    expect(previousText.split(PREVIOUS_PHRASE)).toHaveLength(2);
    const expected = previousText.replace(PREVIOUS_PHRASE, NEW_PHRASE);
    expect(after.get(TABLE_KEY)?.text).toBe(expected);
    expect(namesBothReaders(expected)).toBe(true);
  });

  it('文に書いた (トリガー, 関数) の組は migration の CREATE TRIGGER の最後の定義で、表と契機が文の言葉と合い、関数は印の表を読む', () => {
    for (const reader of READERS) {
      const definition = lastTriggerDefinition(reader.trigger);
      expect(definition, reader.trigger).toBeDefined();
      expect(
        { trigger: definition?.trigger, fn: definition?.fn, table: definition?.table, events: definition?.events },
        reader.trigger,
      ).toEqual({ trigger: reader.trigger, fn: reader.fn, table: reader.table, events: reader.events });
      // トリガーの名前は関数の名前と別 (関数の名前を「トリガー」と呼ばない)
      expect(reader.trigger).not.toBe(reader.fn);
      // 作った後で消していない
      expect(droppedTrigger(reader.trigger), reader.trigger).toEqual([]);
      // 関数の最後の定義の本文が印の表を読む
      const body = lastFunctionBody(reader.fn);
      expect(body, reader.fn).toBeDefined();
      expect(body ?? '', reader.fn).toMatch(new RegExp(String.raw`\bFROM\s+${escapeRegExp(GUARD_TABLE)}\b`));
    }
  });

  it('見つけ方が空振りしない: この migration の前に効いていた文には反応して赤になる', () => {
    const previousText = before.get(TABLE_KEY)?.text ?? '';
    expect(namesBothReaders(previousText)).toBe(false);
    expect(previousText).not.toContain(FAMILY_REPRESENTATIVE_READER.trigger);
    expect(previousText).toContain(PREVIOUS_PHRASE);
  });

  it('migration は COMMENT ON の 1 文 (と lock_timeout) だけで、表・行・関数を変えない', () => {
    const statements = statementsOf(stripLineComments(sql));
    const others = statements.filter((statement) => !LOCK_TIMEOUT_STATEMENT.test(statement));
    expect(others).toHaveLength(1);
    expect(others[0]).toMatch(TABLE_COMMENT_STATEMENT);
    // 文字列リテラルの外に、表・行・関数・トリガー・権限を変える語が無い
    const outsideLiterals = stripLineComments(sql).replace(new RegExp(SQL_LITERAL, 'g'), "''");
    expect(outsideLiterals).not.toMatch(SCHEMA_OR_DATA_CHANGE);
  });

  it('戻し口は前に効いていた文を出し直し、その文は前の文と 1 文字も違わない。ほかには何も変えない', () => {
    const statements = statementsOf(stripLineComments(rawRollback));
    const others = statements.filter((statement) => !LOCK_TIMEOUT_STATEMENT.test(statement));
    expect(others).toHaveLength(1);
    expect(others[0]).toMatch(TABLE_COMMENT_STATEMENT);
    const restored = commentStatementsIn(rawRollback);
    expect(restored.map(({ key }) => key)).toEqual([TABLE_KEY]);
    expect(restored[0].text).toBe(before.get(TABLE_KEY)?.text);
    const outsideLiterals = stripLineComments(rawRollback).replace(new RegExp(SQL_LITERAL, 'g'), "''");
    expect(outsideLiterals).not.toMatch(SCHEMA_OR_DATA_CHANGE);
  });

  it('migration と戻し口の 1 行目が互いのファイル名を指し、migration の冒頭が戻し口を案内する', () => {
    expect(sql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION_FILE}`);
    expect(rawRollback.split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
    expect(sql).toContain(`supabase/rollbacks/${ROLLBACK_FILE}`);
  });
});
