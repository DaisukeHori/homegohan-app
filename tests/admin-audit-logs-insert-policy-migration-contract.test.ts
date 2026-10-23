/**
 * #1736: migration 20261016238000_admin_audit_logs_insert_actor_only.sql (と、そのロールバック) と、
 * admin_audit_logs の書き手の文面の contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (運営でない人・anon の直接の INSERT が 42501、運営のロールの人でも actor を他人・NULL にした行・
 * system.* の行・snapshot を入れた行が 42501、recordAdminAudit の経路は 6 ロールとも書ける) は
 * tests/integration/rls/admin-audit-logs-insert-policy.test.ts が確かめる。
 * ここでは、後の migration の上書きや書き手の追加で崩れやすい所を、ファイルの文面だけで確かめる。
 *   1. 本 migration は古いポリシー "Admins can create audit logs" を外し、audit_logs_insert_admins を TO authenticated で
 *      actor_id = auth.uid()・system.* の禁止・snapshot / impersonated_by の NULL・運営の 6 ロールで作り直す
 *   2. 後の migration が古いポリシーを作り直したり、audit_logs_insert_admins を定義し直したりしていない
 *   3. ロールバックは 2 本を本番の定義 (roles=public) に戻す
 *   4. アプリのコードで admin_audit_logs に直接 INSERT するのは recordAdminAudit (src/lib/admin/audit.ts) と
 *      課金の repository 2 本 (src/lib/billing/repository.ts と iap-repository.ts。service_role) だけ。recordAdminAudit に渡す action_type の文字列に system.* が無い
 *      (system.* は本人の JWT では書けないので、本人の client で渡すと記録が黙って落ちる)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const MIGRATION_STEM = '20261016238000_admin_audit_logs_insert_actor_only';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, `${MIGRATION_STEM}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase/rollbacks', `${MIGRATION_STEM}.down.sql`);

const OLD_POLICY = 'Admins can create audit logs';
const INSERT_POLICY = 'audit_logs_insert_admins';
/** 本人の JWT から書けない action_type の接頭辞 (service_role / SECURITY DEFINER が actor_id NULL で書く) */
const RESERVED_SYSTEM_PREFIX = 'system.';
/** 運営の 6 ロール (operator/07 §3.2) */
const OPERATOR_ROLES = ['admin', 'super_admin', 'support', 'sales', 'finance', 'content_moderator'];

/** アプリのコードで admin_audit_logs に直接 INSERT してよいファイル (書き手の全数。#1736 の表と、billing/03 §8.3 の iap-repository.ts) */
const DIRECT_INSERT_ALLOWED = ['src/lib/admin/audit.ts', 'src/lib/billing/repository.ts', 'src/lib/billing/iap-repository.ts'];

/** recordAdminAudit( の呼び出しから actionType を探す行数 (呼び出しのオブジェクトのリテラルの中に収まる範囲) */
const ACTION_TYPE_LOOKAHEAD_LINES = 14;

/** SQL のコメント (-- から行末) を除き、空白を 1 つに詰める */
function normalizeSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "<名前>" ON ... admin_audit_logs のポリシーの CREATE 文 (セミコロンまで) を取り出す */
function createPolicyStatements(sql: string, policyName: string): string[] {
  const normalized = normalizeSql(sql);
  const statements = normalized.split(';').map((s) => s.trim());
  return statements.filter(
    (s) => s.startsWith(`CREATE POLICY "${policyName}"`) && /admin_audit_logs/.test(s),
  );
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const rollbackSql = fs.readFileSync(ROLLBACK_PATH, 'utf8');

describe('#1736 migration: admin_audit_logs の INSERT のポリシー', () => {
  it('古いポリシー "Admins can create audit logs" を外し、作り直さない', () => {
    expect(normalizeSql(migrationSql)).toContain(`DROP POLICY IF EXISTS "${OLD_POLICY}" ON "public"."admin_audit_logs"`);
    expect(createPolicyStatements(migrationSql, OLD_POLICY)).toEqual([]);
  });

  it('audit_logs_insert_admins を 1 本だけ、TO authenticated の INSERT で作り直す', () => {
    expect(normalizeSql(migrationSql)).toContain(`DROP POLICY IF EXISTS "${INSERT_POLICY}" ON "public"."admin_audit_logs"`);
    const statements = createPolicyStatements(migrationSql, INSERT_POLICY);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('FOR INSERT TO authenticated WITH CHECK');
  });

  it('WITH CHECK は actor_id = auth.uid()・system.* の禁止・snapshot と impersonated_by の NULL・運営の 6 ロールを全部求める', () => {
    const [statement] = createPolicyStatements(migrationSql, INSERT_POLICY);
    expect(statement).toContain('"actor_id" = "auth"."uid"()');
    expect(statement).toContain(`"action_type" NOT LIKE '${RESERVED_SYSTEM_PREFIX}%'`);
    expect(statement).toContain('"actor_email_snapshot" IS NULL');
    expect(statement).toContain('"actor_role_snapshot" IS NULL');
    expect(statement).toContain('"impersonated_by" IS NULL');
    expect(statement).toContain('"user_profiles"."id" = "auth"."uid"()');
    const roleArray = /ARRAY\[([^\]]+)\]\s*&&\s*"user_profiles"\."roles"/.exec(statement);
    expect(roleArray).not.toBeNull();
    const roles = (roleArray?.[1] ?? '').split(',').map((r) => r.trim().replace(/::text$/, '').replace(/'/g, ''));
    expect(roles).toEqual(OPERATOR_ROLES);
    // 条件は AND だけでつなぐ (OR が混ざると、どれか 1 つを満たせば通ってしまう)
    expect(statement).not.toMatch(/\bOR\b/);
  });

  it('後の migration が古いポリシーを作り直したり、audit_logs_insert_admins を定義し直したりしていない', () => {
    const later = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql') && name > `${MIGRATION_STEM}.sql`);
    const offenders = later.filter((name) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      return (
        createPolicyStatements(sql, OLD_POLICY).length > 0 ||
        createPolicyStatements(sql, INSERT_POLICY).length > 0 ||
        normalizeSql(sql).includes(`DROP POLICY IF EXISTS "${INSERT_POLICY}"`)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('ロールバックは 2 本を本番の定義 (roles=public) に戻す', () => {
    const oldPolicy = createPolicyStatements(rollbackSql, OLD_POLICY);
    const insertPolicy = createPolicyStatements(rollbackSql, INSERT_POLICY);
    expect(oldPolicy).toHaveLength(1);
    expect(insertPolicy).toHaveLength(1);
    expect(oldPolicy[0]).toContain('FOR INSERT TO public WITH CHECK');
    expect(oldPolicy[0]).toContain(`ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text"]`);
    expect(insertPolicy[0]).toContain('FOR INSERT TO public WITH CHECK');
    expect(insertPolicy[0]).toContain('"actor_id" = "auth"."uid"()');
    expect(insertPolicy[0]).not.toContain(RESERVED_SYSTEM_PREFIX);
  });

  it('migration とロールバックの 1 行目の見出しが互いのファイル名を指す', () => {
    expect(migrationSql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION_STEM}.sql`);
    expect(rollbackSql.split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION_STEM}.sql`);
    expect(migrationSql).toContain(`supabase/rollbacks/${MIGRATION_STEM}.down.sql`);
  });
});

describe('#1736 admin_audit_logs の書き手 (アプリのコード)', () => {
  const sourceFiles = listFiles(path.join(ROOT, 'src'))
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .map((file) => path.relative(ROOT, file));

  it('src を読めている (読み取りが壊れて素通りしない)', () => {
    expect(sourceFiles).toContain('src/lib/admin/audit.ts');
    expect(sourceFiles).toContain('src/lib/billing/repository.ts');
    expect(sourceFiles).toContain('src/lib/billing/iap-repository.ts');
  });

  it('admin_audit_logs に直接 INSERT するのは recordAdminAudit と課金の repository 2 本 (billing/01 の repository.ts・billing/03 の iap-repository.ts。service_role) だけ', () => {
    const writers = sourceFiles.filter((file) => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      return /from\(\s*['"`]admin_audit_logs['"`]\s*\)\s*\.insert\(/.test(text);
    });
    expect(writers.sort()).toEqual([...DIRECT_INSERT_ALLOWED].sort());
  });

  it('recordAdminAudit に渡す action_type の文字列に system.* が無い', () => {
    const calls: Array<{ file: string; actionType: string }> = [];
    for (const file of sourceFiles) {
      const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        // 呼び出しだけを拾う (定義の行とコメントの使い方の例は除く)
        if (!/\brecordAdminAudit\(/.test(line)) return;
        if (/function recordAdminAudit\(/.test(line) || /^\s*(\*|\/\/|\/\*)/.test(line)) return;
        for (const next of lines.slice(index, index + ACTION_TYPE_LOOKAHEAD_LINES)) {
          const match = /actionType:\s*(.+?),?\s*$/.exec(next);
          if (match) {
            calls.push({ file, actionType: match[1] });
            break;
          }
        }
      });
    }
    // 呼び出しを拾えている (0 件で素通りしない)
    expect(calls.length).toBeGreaterThan(0);
    const reserved = calls.filter(({ actionType }) => /^['"`]system\./.test(actionType));
    expect(reserved).toEqual([]);
  });
});
