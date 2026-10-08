/**
 * #1175 migration 20261008150100_auth_users_fk_on_delete.sql (と、そのロールバック) のソース走査 contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (外部キーの動作・退会・権限) は tests/integration/security/auth-users-fk-on-delete.test.ts と
 * account-deletion.test.ts が確かめる。ここでは、migration の書き方の決まりごとが崩れていないかを、SQL の文面だけで確かめる。
 *   1. CHECK 制約を新しく足さない (足せるのは、受け入れる範囲を広げる coupon_redemptions_user_or_org の置き換えだけ)。
 *      既存の表に CHECK を足すと、本番に違反した既存の行があるとき、その行はどの列の更新でも失敗するようになる
 *   2. migration 本体 (関数の中を除く) に、既存の行を書き換える UPDATE / DELETE / INSERT / TRUNCATE が無い (データの修復をしない)
 *   3. 外部キーの張り直しは、同じ ALTER TABLE 文の中で DROP CONSTRAINT IF EXISTS と ADD CONSTRAINT を行う
 *      (別々にすると、その間は外部キーが無い状態になる)。CONCURRENTLY は使わない (migration はトランザクションの中で流れる)
 *   4. prepare_account_deletion は SECURITY DEFINER + SET search_path = ''、EXECUTE は service_role だけ
 *   5. ロックの待ちに上限を付ける (SET LOCAL lock_timeout)
 *   6. ロールバックは、migration が触った外部キー 33 本をすべて NO ACTION に戻す
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = 'supabase/migrations/20261008150100_auth_users_fk_on_delete.sql';
const ROLLBACK = 'supabase/rollbacks/20261008150100_auth_users_fk_on_delete.down.sql';

/** `--` から行末までのコメントを除く (この 2 つのファイルでは、文字列リテラルの中に `--` は出てこない) */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** `$tag$ ... $tag$` で囲まれた本体 (関数の本体・DO ブロック) を空にする */
function stripDollarQuoted(sql: string): string {
  return sql.replace(/(\$[A-Za-z_]*\$)[\s\S]*?\1/g, '$1$1');
}

const migrationRaw = fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8');
const rollbackRaw = fs.readFileSync(path.join(ROOT, ROLLBACK), 'utf8');
const migration = stripLineComments(migrationRaw);
const rollback = stripLineComments(rollbackRaw);

/** `ALTER TABLE ... ;` 1 文ずつ */
function alterTableStatements(sql: string): string[] {
  return stripDollarQuoted(sql)
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => /^ALTER\s+TABLE\b/i.test(statement));
}

const FK_ADD = /ADD\s+CONSTRAINT\s+(\w+)\s+FOREIGN\s+KEY\s*\((\w+)\)\s+REFERENCES\s+auth\.users\s*\(id\)(\s+ON\s+DELETE\s+(?:CASCADE|SET\s+NULL))?/i;

describe('#1175 migration の書き方 (auth_users_fk_on_delete)', () => {
  it('CHECK 制約は、coupon_redemptions_user_or_org (受け入れる範囲を広げる置き換え) の 1 つだけ', () => {
    const checks = [...migration.matchAll(/ADD\s+CONSTRAINT\s+(\w+)\s+CHECK\b/gi)].map((match) => match[1]);
    expect(checks).toEqual(['coupon_redemptions_user_or_org']);
    // 置き換えは「元の条件 OR anonymized_at IS NOT NULL」。元の条件を含んだまま広げている
    expect(migration).toMatch(
      /CHECK\s*\(\s*user_id\s+IS\s+NOT\s+NULL\s+OR\s+organization_id\s+IS\s+NOT\s+NULL\s+OR\s+anonymized_at\s+IS\s+NOT\s+NULL\s*\)/i,
    );
    expect(migration).not.toMatch(/\bNOT\s+VALID\b/i);
  });

  it('関数・DO ブロックの外に、既存の行を書き換える UPDATE / DELETE / INSERT / TRUNCATE が無い (データの修復をしない)', () => {
    const outside = stripDollarQuoted(migration);
    expect(outside).not.toMatch(/^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/im);
  });

  it('外部キーの張り直しは DROP CONSTRAINT IF EXISTS と ADD CONSTRAINT を同じ ALTER TABLE 文で行う。CONCURRENTLY は使わない', () => {
    const added = alterTableStatements(migration).filter((statement) => FK_ADD.test(statement));
    expect(added).toHaveLength(32);
    for (const statement of added) {
      const name = FK_ADD.exec(statement)![1];
      expect(statement, `${name}: 同じ文の中に DROP CONSTRAINT IF EXISTS が必要`).toMatch(
        new RegExp(`DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${name}\\b`, 'i'),
      );
      // 動作は CASCADE か SET NULL のどちらかを必ず書く (NO ACTION のままにしない)
      expect(FK_ADD.exec(statement)![3], `${name}: ON DELETE の指定が必要`).toBeTruthy();
    }
    expect(migration).not.toMatch(/\bCONCURRENTLY\b/i);
  });

  it('重複していた admin_audit_logs_admin_id_fkey は外すだけ (同じ列には admin_audit_logs_actor_id_fkey が残る)', () => {
    expect(migration).toMatch(/ALTER\s+TABLE\s+public\.admin_audit_logs\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+admin_audit_logs_admin_id_fkey\s*;/i);
    expect(migration).not.toMatch(/ADD\s+CONSTRAINT\s+admin_audit_logs_admin_id_fkey/i);
  });

  it("prepare_account_deletion は SECURITY DEFINER + SET search_path = ''、EXECUTE は service_role だけ", () => {
    expect(migration).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.prepare_account_deletion\(p_user_id\s+uuid\)\s+RETURNS\s+jsonb\s+LANGUAGE\s+plpgsql\s+SECURITY\s+DEFINER\s+SET\s+search_path\s*=\s*''/i,
    );
    expect(migration).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.prepare_account_deletion\(uuid\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role\s*;/i,
    );
    expect(migration).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.prepare_account_deletion\(uuid\)\s+TO\s+service_role\s*;/i);
    // service_role 以外へ GRANT しない
    const grants = [...migration.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.prepare_account_deletion\(uuid\)\s+TO\s+([^;]+);/gi)].map(
      (match) => match[1].trim(),
    );
    expect(grants).toEqual(['service_role']);
  });

  it('ロックの待ちに上限を付ける (migration もロールバックも)', () => {
    expect(migration).toMatch(/^SET\s+LOCAL\s+lock_timeout\s*=\s*'10s'\s*;/im);
    expect(rollback).toMatch(/^SET\s+LOCAL\s+lock_timeout\s*=\s*'10s'\s*;/im);
  });
});

describe('#1175 ロールバック (auth_users_fk_on_delete.down)', () => {
  it('migration が触った外部キー 33 本 (張り直し 32 本 + 外した 1 本) を、すべて ON DELETE の指定なし (NO ACTION) に戻す', () => {
    const migrated = new Set(
      alterTableStatements(migration)
        .map((statement) => FK_ADD.exec(statement)?.[1])
        .filter((name): name is string => Boolean(name)),
    );
    migrated.add('admin_audit_logs_admin_id_fkey');
    expect(migrated.size).toBe(33);

    const restored = new Map<string, string | undefined>();
    for (const statement of alterTableStatements(rollback)) {
      const match = FK_ADD.exec(statement);
      if (match) restored.set(match[1], match[3]);
    }
    expect(new Set(restored.keys())).toEqual(migrated);
    // どれも ON DELETE の指定が無い (= NO ACTION)
    expect([...restored.values()].filter((onDelete) => onDelete !== undefined)).toEqual([]);
  });

  it('関数・トリガーを消し、行のデータは書き換えない', () => {
    expect(rollback).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.prepare_account_deletion\(uuid\)/i);
    expect(rollback).toMatch(/DROP\s+TRIGGER\s+IF\s+EXISTS\s+trg_coupon_redemptions_mark_anonymized\s+ON\s+public\.coupon_redemptions/i);
    expect(rollback).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.coupon_redemptions_mark_anonymized\(\)/i);
    expect(stripDollarQuoted(rollback)).not.toMatch(/^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/im);
  });
});
