/**
 * 運営のロールで判定する、書き込みを許す public のポリシー (以下「この型」) の台帳 (tests/helpers/operator-write-policy-ledger.ts) を、
 * migration の文面と突き合わせる (DB には接続しない。常設の検査)。
 *
 * 運営がこの型のポリシーに頼って PostgREST から直接書くと、運営の API と監査ログ (admin_audit_logs) を通らない。台帳は、いまこの型に
 * 当たるポリシーの全部を、分類 (運営が書く API が無い / 監査ログそのもの) と理由つきで持つ。分類の無いこの型のポリシーを
 * 残さないため、migration でこの型のポリシーを足す・消す・名前を変えるとここが赤になり、台帳の行を足す・消す・直すことを求める。
 * 実 DB との突き合わせは tests/integration/rls/operator-write-policy-ledger.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isOperatorRoleExpression,
  OPERATOR_WRITE_POLICY_CATEGORY_LABELS,
  OPERATOR_WRITE_POLICY_LEDGER,
  operatorWritePolicyLedgerRows,
  operatorWritePolicyRowsAfterMigrations,
} from './helpers/operator-write-policy-ledger';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'supabase', 'migrations');
/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');
/** migration を version 順に (ファイル名の順) 並べ、行コメントを除いた文面 */
const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: stripLineComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')) }));

describe('運営のロールで判定する書き込みのポリシーの台帳 (いまの状態・migration の文面)', () => {
  it('migration を全部流した後のこの型のポリシーは、台帳と過不足なく一致する (この型を足す・消す migration は、同じ変更で台帳の行も足す・消す)', () => {
    expect(migrations.length).toBeGreaterThan(0);
    expect(operatorWritePolicyRowsAfterMigrations(migrations)).toEqual(operatorWritePolicyLedgerRows());
  });

  it('台帳の行は 1 本ずつで、決まった分類と、空でない理由を持つ', () => {
    const keys = OPERATOR_WRITE_POLICY_LEDGER.map((entry) => `${entry.table}|${entry.policy}`);
    expect(new Set(keys).size).toBe(keys.length);
    const categories = Object.keys(OPERATOR_WRITE_POLICY_CATEGORY_LABELS);
    for (const entry of OPERATOR_WRITE_POLICY_LEDGER) {
      const key = `${entry.table}|${entry.policy}`;
      expect(categories, key).toContain(entry.category);
      expect(entry.reason.trim(), key).not.toBe('');
    }
  });
});

describe('番兵: この型の見つけ方 (台帳との突き合わせが空振りしないこと)', () => {
  it('FOR の無い形 (ALL)・FOR INSERT / UPDATE / DELETE を拾い、SELECT・運営ロールで判定しないもの・public でない表は拾わない', () => {
    const sql = [
      `CREATE POLICY "op all" ON "public"."t1" USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.roles && ARRAY['admin'::text])))));`,
      `CREATE POLICY op_insert ON public.t1 FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE (roles && ARRAY['super_admin'::text]))));`,
      `CREATE POLICY op_update ON t1 FOR UPDATE USING (('finance'::text = ANY (roles)));`,
      `CREATE POLICY op_delete ON public.t2 AS PERMISSIVE FOR DELETE USING ((roles @> ARRAY['support'::text]));`,
      `CREATE POLICY op_select ON public.t1 FOR SELECT USING ((roles && ARRAY['admin'::text]));`,
      `CREATE POLICY own_update ON public.t1 FOR UPDATE USING ((auth.uid() = user_id));`,
      `CREATE POLICY not_operator ON public.t1 FOR INSERT WITH CHECK ((roles && ARRAY['user'::text]));`,
      `CREATE POLICY other_schema ON storage.objects FOR INSERT WITH CHECK ((roles && ARRAY['admin'::text]));`,
    ].join('\n');
    expect(operatorWritePolicyRowsAfterMigrations([{ sql }])).toEqual(
      ['t1|op all ALL', 't1|op_insert INSERT', 't1|op_update UPDATE', 't2|op_delete DELETE'].sort(),
    );
  });

  it('後の migration の DROP POLICY・DROP TABLE で消え、ALTER POLICY の RENAME と式の差し替えに追随する', () => {
    const first = {
      sql: [
        `CREATE POLICY op_a ON public.t3 FOR UPDATE USING ((roles && ARRAY['admin'::text]));`,
        `CREATE POLICY op_b ON public.t3 FOR DELETE USING ((roles && ARRAY['admin'::text]));`,
        `CREATE POLICY op_c ON public.t4 USING ((roles && ARRAY['admin'::text]));`,
        `CREATE POLICY op_d ON public.t3 FOR INSERT WITH CHECK ((auth.uid() = user_id));`,
      ].join('\n'),
    };
    const second = {
      sql: [
        `DROP POLICY IF EXISTS op_a ON public.t3;`,
        `ALTER POLICY op_b ON public.t3 RENAME TO op_b2;`,
        `DROP TABLE IF EXISTS public.t4;`,
        `ALTER POLICY op_d ON public.t3 WITH CHECK ((roles && ARRAY['sales'::text]));`,
      ].join('\n'),
    };
    expect(operatorWritePolicyRowsAfterMigrations([first])).toEqual(['t3|op_a UPDATE', 't3|op_b DELETE', 't4|op_c ALL'].sort());
    expect(operatorWritePolicyRowsAfterMigrations([first, second])).toEqual(['t3|op_b2 DELETE', 't3|op_d INSERT'].sort());
  });

  it.each([
    ["(roles && ARRAY['admin'::text])", true],
    ["('content_moderator'::text = ANY (user_profiles.roles))", true],
    ["(roles && ARRAY['org_industrial_doctor'])", true],
    ["(user_profiles.roles = '{}'::text[])", false],
    ["('admin'::text = current_setting('app.role'::text))", false],
    ["(rolesx && ARRAY['admin'::text])", false],
    ["(roles && ARRAY['administrator'::text])", false],
  ] as const)('isOperatorRoleExpression(%s) は %s (roles の列と運営ロールの文字列の両方が要る)', (expression, expected) => {
    expect(isOperatorRoleExpression(expression)).toBe(expected);
  });
});
