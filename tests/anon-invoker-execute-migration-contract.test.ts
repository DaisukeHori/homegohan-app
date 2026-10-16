/**
 * #1821: migration 20261017210000_revoke_anon_execute_on_invoker_functions.sql (と、そのロールバック) の contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (anon が 12 本を /rest/v1/rpc で呼ぶと 42501、ログインした利用者と service_role は呼べる、
 * 許可一覧に無い SECURITY INVOKER の関数に anon の EXECUTE が残っていない) は
 * tests/integration/security/anon-invoker-execute.test.ts が確かめる。
 * ここでは、文面だけで崩れやすい所を確かめる。
 *   1. 本 migration は 12 本それぞれを、引数の型まで書いた完全形で anon と PUBLIC から REVOKE する
 *   2. authenticated・service_role の権限には触れない (GRANT / REVOKE のどちらにも出てこない)。関数の本文も変えない
 *   3. ロールバックは 12 本を anon へ戻し、修正前に PUBLIC にも付いていた 10 本だけを PUBLIC へ戻す
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_STEM = '20261017210000_revoke_anon_execute_on_invoker_functions';
const MIGRATION_PATH = path.join(ROOT, 'supabase/migrations', `${MIGRATION_STEM}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase/rollbacks', `${MIGRATION_STEM}.down.sql`);

/**
 * 外す 12 本の完全形 (引数の型)。PUBLIC に修正前から EXECUTE が付いていたかどうか
 * (2026-10-17 のローカルのベースライン + migration の ACL。supabase/baseline/prod_function_acl.sql と同じ)
 */
const REVOKED: Array<{ signature: string; hadPublic: boolean }> = [
  { signature: 'public.create_org_invite(uuid, text, public.org_role_enum, text)', hadPublic: false },
  { signature: 'public.get_7d_checkin_averages(uuid, date)', hadPublic: true },
  { signature: 'public.user_has_non_sandbox_activity()', hadPublic: false },
  { signature: 'public.normalize_dish_name(text)', hadPublic: true },
  { signature: 'public.search_dataset_ingredients_by_embedding(extensions.vector, integer)', hadPublic: true },
  { signature: 'public.search_ingredients_by_text_similarity(text, numeric, integer)', hadPublic: true },
  { signature: 'public.search_ingredients_full_by_embedding(extensions.vector, integer)', hadPublic: true },
  { signature: 'public.search_menu_examples(extensions.vector, integer, text, numeric, text[])', hadPublic: true },
  { signature: 'public.search_recipes_hybrid(text, extensions.vector, integer, numeric)', hadPublic: true },
  { signature: 'public.search_recipes_with_nutrition(text, numeric, integer)', hadPublic: true },
  { signature: 'public.search_similar_dataset_ingredients(text, numeric, integer)', hadPublic: true },
  { signature: 'public.search_similar_dataset_recipes(text, numeric, integer)', hadPublic: true },
];

/** SQL のコメント (-- から行末) を除き、空白を 1 つに詰めて、文 (セミコロン区切り) に分ける */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const migration = statements(fs.readFileSync(MIGRATION_PATH, 'utf8'));
const rollback = statements(fs.readFileSync(ROLLBACK_PATH, 'utf8'));

describe('#1821 20261017210000 の migration', () => {
  it('12 本それぞれを、完全形で anon と PUBLIC から REVOKE する文が 1 つずつある (それ以外の文は無い)', () => {
    expect(migration).toEqual(
      REVOKED.map((r) => `REVOKE EXECUTE ON FUNCTION ${r.signature} FROM anon, PUBLIC`),
    );
  });

  it('authenticated・service_role に触れない。GRANT・関数の作り直し・表の変更をしない', () => {
    const joined = migration.join(';\n');
    expect(joined).not.toMatch(/\bauthenticated\b/);
    expect(joined).not.toMatch(/\bservice_role\b/);
    expect(joined).not.toMatch(/\bGRANT\b/i);
    expect(joined).not.toMatch(/\bCREATE\b|\bALTER\b|\bDROP\b|\bUPDATE\b|\bDELETE\b|\bINSERT\b/i);
  });
});

describe('#1821 20261017210000 のロールバック', () => {
  it('12 本を anon へ戻し、修正前に PUBLIC にも付いていた 10 本だけを PUBLIC へ戻す', () => {
    const expected = REVOKED.map(
      (r) => `GRANT EXECUTE ON FUNCTION ${r.signature} TO ${r.hadPublic ? 'anon, PUBLIC' : 'anon'}`,
    ).sort();
    expect([...rollback].sort()).toEqual(expected);
  });

  it('PUBLIC へ戻す本数は 10 本 (create_org_invite・user_has_non_sandbox_activity は PUBLIC に付いていなかった)', () => {
    expect(rollback.filter((s) => s.endsWith('PUBLIC'))).toHaveLength(REVOKED.filter((r) => r.hadPublic).length);
    expect(REVOKED.filter((r) => !r.hadPublic).map((r) => r.signature)).toEqual([
      'public.create_org_invite(uuid, text, public.org_role_enum, text)',
      'public.user_has_non_sandbox_activity()',
    ]);
  });
});
