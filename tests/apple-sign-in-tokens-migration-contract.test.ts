/**
 * Sign in with Apple の refresh token の表 apple_sign_in_tokens の migration (と、その戻し口) のソース走査 contract テスト (DB は使わない)
 * 設計: docs/design/mobile/08-sign-in-with-apple.md §8.1
 *
 * 本物の DB での外部キーの動作は tests/integration/security/auth-users-fk-on-delete.test.ts (EXPECTED_ACTIONS)、権限は
 * tests/integration/security/db-privilege-hardening.test.ts が確かめる。ここでは SQL の文面だけを確かめる。
 *   1. 表は PK (user_id, client_id)・user_id は auth.users を指し ON DELETE CASCADE
 *   2. RLS を有効にし、PUBLIC / anon / authenticated の権限を外す (ポリシー・GRANT は書かない。読み書きは service_role だけ)
 *   3. 既存の行に触る文 (UPDATE / INSERT / DELETE) と、既存の表への ALTER が無い (追加だけの migration)
 *   4. ロックの待ちに上限を付ける
 *   5. 戻し口は DROP TABLE IF EXISTS だけ
 *   6. コメントに、記録の無い決定の帰属の語を書かない
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase/rollbacks');
const MIGRATION_SUFFIX = '_apple_sign_in_tokens.sql';
const ROLLBACK_SUFFIX = '_apple_sign_in_tokens.down.sql';

/** `--` から行末までのコメントを除く (この 2 つのファイルでは、文字列リテラルの中に `--` は出てこない) */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(MIGRATION_SUFFIX));
const rollbackFiles = fs.readdirSync(ROLLBACKS_DIR).filter((name) => name.endsWith(ROLLBACK_SUFFIX));

describe('apple_sign_in_tokens の migration と戻し口のファイル', () => {
  it('migration と戻し口が 1 本ずつあり、同じ版の番号で対になっている', () => {
    expect(migrationFiles).toHaveLength(1);
    expect(rollbackFiles).toHaveLength(1);
    const migrationVersion = migrationFiles[0].slice(0, -MIGRATION_SUFFIX.length);
    const rollbackVersion = rollbackFiles[0].slice(0, -ROLLBACK_SUFFIX.length);
    expect(migrationVersion).toMatch(/^\d{14}$/);
    expect(rollbackVersion).toBe(migrationVersion);
  });
});

const migrationRaw = fs.readFileSync(path.join(MIGRATIONS_DIR, migrationFiles[0]), 'utf8');
const rollbackRaw = fs.readFileSync(path.join(ROLLBACKS_DIR, rollbackFiles[0]), 'utf8');
const migration = stripLineComments(migrationRaw);
const rollback = stripLineComments(rollbackRaw);

describe('apple_sign_in_tokens の migration の書き方', () => {
  it('CREATE TABLE IF NOT EXISTS public.apple_sign_in_tokens (PK (user_id, client_id)・user_id は auth.users ON DELETE CASCADE)', () => {
    expect(migration).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.apple_sign_in_tokens\s*\(/i);
    expect(migration).toMatch(/user_id\s+uuid\s+NOT\s+NULL\s+REFERENCES\s+auth\.users\s*\(id\)\s+ON\s+DELETE\s+CASCADE/i);
    expect(migration).toMatch(/client_id\s+text\s+NOT\s+NULL/i);
    expect(migration).toMatch(/refresh_token\s+text\s+NOT\s+NULL/i);
    expect(migration).toMatch(/PRIMARY\s+KEY\s*\(\s*user_id\s*,\s*client_id\s*\)/i);
  });

  it('ENABLE ROW LEVEL SECURITY と REVOKE ALL FROM PUBLIC, anon, authenticated がある', () => {
    expect(migration).toMatch(/ALTER\s+TABLE\s+public\.apple_sign_in_tokens\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\s*;/i);
    expect(migration).toMatch(/REVOKE\s+ALL\s+ON\s+TABLE\s+public\.apple_sign_in_tokens\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated\s*;/i);
  });

  it('ポリシー・GRANT・UPDATE/INSERT/DELETE/TRUNCATE が無い (利用者は読めず書けない。既存の行に触らない)', () => {
    expect(migration).not.toMatch(/\bCREATE\s+POLICY\b/i);
    expect(migration).not.toMatch(/\bGRANT\b/i);
    expect(migration).not.toMatch(/^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/im);
  });

  it('触る表は apple_sign_in_tokens だけ (既存の表を ALTER しない)', () => {
    const altered = [...migration.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?([\w.]+)/gi)].map((match) => match[1]);
    expect(altered).toEqual(['public.apple_sign_in_tokens']);
  });

  it('SET LOCAL lock_timeout がある (migration も戻し口も)', () => {
    expect(migration).toMatch(/^SET\s+LOCAL\s+lock_timeout\s*=\s*'10s'\s*;/im);
    expect(rollback).toMatch(/^SET\s+LOCAL\s+lock_timeout\s*=\s*'10s'\s*;/im);
  });

  it('1 行目と 2 行目は自分の番号を指す (見出し -- migration: と 戻し方の案内)', () => {
    const [first, second] = migrationRaw.split('\n');
    expect(first).toBe(`-- migration: ${migrationFiles[0]}`);
    expect(second).toBe(`-- 戻し方: supabase/rollbacks/${rollbackFiles[0]}`);
    expect(rollbackRaw.split('\n')[0]).toBe(`-- rollback: ${migrationFiles[0]}`);
  });

  it('コメントに、記録の無い決定の帰属 (オーナー判断) や、確かめられない確認の手続き (税理士) を書かない (tests/account-deletion-migration-contract.test.ts の規則 7 と同じ)', () => {
    for (const raw of [migrationRaw, rollbackRaw]) {
      expect(raw).not.toMatch(/オーナー判断|オーナーが決め|税理士/);
    }
  });
});

describe('apple_sign_in_tokens の戻し口', () => {
  it('DROP TABLE IF EXISTS public.apple_sign_in_tokens だけ (SET LOCAL を除く文が 1 つ)', () => {
    const statements = rollback
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '' && !/^SET\s+LOCAL\b/i.test(statement));
    expect(statements).toEqual(['DROP TABLE IF EXISTS public.apple_sign_in_tokens']);
  });
});
