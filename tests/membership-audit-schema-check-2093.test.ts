// @vitest-environment node
/**
 * #2093 (triage-1030a の記録の古さ 9) のテスト: メンバーシップの監査ログの Zod (src/schemas/membership/membership-audit.ts) が、
 * DB の CHECK の値の全数をそろえていること。
 *
 * 以前、AuditActionSchema は 21 値で、DB の CHECK membership_audit_action_check (28 値。最後の定義は
 * supabase/migrations/20261017030000_parental_consent_and_birth_date.sql) にある
 * owner_transfer_declined・representative_transfer_declined・child_promotion_requested・child_promotion_rejected・
 * child_promotion_revoked・parental_consent_recorded・parental_consent_revoked の 7 値が無かった
 * (表示名の表 src/lib/membership/audit-labels.ts は 28 値を持つ)。
 * Zod で監査ログの行を読むと、DB が持てる行を「形が違う」と断ることになるので、ここで突き合わせる:
 *  1. 操作: AuditActionSchema の値が、membership_audit_action_check (最後に定義した migration の CHECK の配列) と同じ値・同じ並び
 *  2. 操作: AuditActionSchema の値と、表示名の表 MEMBERSHIP_AUDIT_ACTION_LABELS のキーが同じ集合
 *  3. 対象: AuditScopeSchema の値が、membership_audit_scope_check (最後の定義) と同じ値・同じ並び
 *  4. 走査の空振りの番兵: 7 値のどれも CHECK にあり、Zod でも通る
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMBERSHIP_AUDIT_ACTION_LABELS } from '@/lib/membership/audit-labels';
import { AuditActionSchema, AuditScopeSchema } from '@/schemas/membership/membership-audit';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');

/** 以前の Zod に無かった 7 値 (走査が空振りしていないことの番兵) */
const PREVIOUSLY_MISSING_ACTIONS = [
  'owner_transfer_declined',
  'representative_transfer_declined',
  'child_promotion_requested',
  'child_promotion_rejected',
  'child_promotion_revoked',
  'parental_consent_recorded',
  'parental_consent_revoked',
] as const;

/** 元に戻す migration (.down.sql) を除いた migration (ファイル名の順 = 適用の順) */
function upMigrations(): { name: string; sql: string }[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

/** SQL の行コメント (-- から行末) を除く */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/**
 * 制約を最後に定義した migration の、許す値の配列 (書かれた並びのまま)。
 * 定義の形は「CONSTRAINT "<name>" CHECK (... ARRAY[...])」(初期のスキーマ) と「ADD CONSTRAINT <name> CHECK (... ARRAY[...])」(後の変更) の 2 つ
 */
function latestCheckValues(constraint: string): { migration: string; values: string[] } {
  const pattern = new RegExp(`CONSTRAINT\\s+"?${constraint}"?\\s+CHECK\\s*\\(([\\s\\S]*?ARRAY\\s*\\[[\\s\\S]*?\\])`, 'g');
  let latest: { migration: string; values: string[] } | null = null;
  for (const { name, sql } of upMigrations()) {
    for (const match of stripLineComments(sql).matchAll(pattern)) {
      const arrayBody = match[1].slice(match[1].indexOf('['));
      latest = { migration: name, values: Array.from(arrayBody.matchAll(/'([^']*)'/g), (m) => m[1]) };
    }
  }
  if (!latest) throw new Error(`${constraint} の定義が migration に無い`);
  return latest;
}

describe('#2093 監査ログの Zod が、DB の CHECK の値の全数をそろえている', () => {
  it('AuditActionSchema の値は membership_audit_action_check (最後の定義) と同じ値・同じ並び', () => {
    const { migration, values } = latestCheckValues('membership_audit_action_check');
    expect(values.length, `${migration} の CHECK の値`).toBeGreaterThan(0);
    expect([...AuditActionSchema.options]).toEqual(values);
  });

  it('AuditActionSchema の値と、表示名の表 (MEMBERSHIP_AUDIT_ACTION_LABELS) のキーが同じ集合', () => {
    expect([...AuditActionSchema.options].sort()).toEqual(Object.keys(MEMBERSHIP_AUDIT_ACTION_LABELS).sort());
  });

  it('AuditScopeSchema の値は membership_audit_scope_check (最後の定義) と同じ値・同じ並び', () => {
    const { values } = latestCheckValues('membership_audit_scope_check');
    expect([...AuditScopeSchema.options]).toEqual(values);
  });

  it('以前の Zod に無かった 7 値は、どれも CHECK にあり、Zod で読める (走査の空振りの番兵)', () => {
    const { values } = latestCheckValues('membership_audit_action_check');
    for (const action of PREVIOUSLY_MISSING_ACTIONS) {
      expect(values, action).toContain(action);
      expect(AuditActionSchema.safeParse(action).success, action).toBe(true);
    }
    expect(AuditActionSchema.safeParse('future_action').success).toBe(false);
  });
});
