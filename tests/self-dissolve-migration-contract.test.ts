/**
 * #1917 家族グループ・組織の解散 (migration <VERSION>_self_dissolve.sql・設計 docs/design/family/11-self-dissolve.md §11) の
 * ソース走査 contract テスト (DB には接続しない)。段 A。
 *
 * 実際の動き (後始末・ロック・権限・CHECK・特権列のガード・運営の強制解散) は tests/integration/security/self-dissolve.test.ts で確かめる。
 * ここでは、DB を立てなくても通常のテストで止められる「書き方の取り決め」を固定する (設計 §21.1 の C-1〜C-13)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { stripSqlComments } from './helpers/migration-cron-jobs';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';
import { DISSOLVED_FAMILY_GROUP_RETENTION_DAYS } from '@/lib/membership/self-dissolve';

const ROOT = path.resolve(__dirname, '..');
const VERSION = '20261019120000';
const NAME = 'self_dissolve';
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const ROLLBACK_FILE = `${VERSION}_${NAME}.down.sql`;
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, MIGRATION_FILE);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', ROLLBACK_FILE);

/** 運営の強制解散の RPC 2 本の土台 (置き換える前の最新の定義) */
const OPERATOR_BASE_FILE = path.join(MIGRATIONS_DIR, '20261017130000_operator_mfa_db_gate.sql');
/** 土台のファイルの中の operator_force_dissolve_org (:166-235) と operator_force_dissolve_family (:281-319) の行 (1 始まり・両端を含む) */
const OPERATOR_ORG_LINES = { from: 166, to: 235 } as const;
const OPERATOR_FAMILY_LINES = { from: 281, to: 319 } as const;
/** 家族の行の特権列のガードの土台 (20251126124224 の :1779-1791) */
const GUARD_BASE_FILE = path.join(MIGRATIONS_DIR, '20251126124224_create_meal_planner_tables.sql');
const GUARD_LINES = { from: 1779, to: 1791 } as const;
/** 解散した家族の物理削除のジョブ (保存期間の正) */
const PURGE_FILE = path.join(MIGRATIONS_DIR, '20261018010000_purge_dissolved_family_groups.sql');

const migration = fs.readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
const code = stripSqlComments(migration);
const rollbackCode = stripSqlComments(rollback);

/** ファイルの from〜to 行 (1 始まり・両端を含む) を改行でつないで返す */
function linesOf(file: string, range: { from: number; to: number }): string {
  return fs.readFileSync(file, 'utf-8').split('\n').slice(range.from - 1, range.to).join('\n');
}

/** CREATE OR REPLACE FUNCTION <name>( から本体の終わりの $$ まで (見出しと本体を分けて返す)。name は public. 付きの素の名前 */
function functionSource(sql: string, name: string): { header: string; body: string; whole: string } {
  const pattern = new RegExp(`CREATE OR REPLACE FUNCTION "?public"?\\."?${name}"?\\(`);
  const match = pattern.exec(sql);
  expect(match, `${name} の CREATE OR REPLACE FUNCTION が見つからない`).not.toBeNull();
  const rest = sql.slice((match as RegExpExecArray).index);
  const opener = /\bAS\s+\$\$/.exec(rest);
  expect(opener, `${name} の AS $$ が見つからない`).not.toBeNull();
  const opened = opener as RegExpExecArray;
  const bodyStart = opened.index + opened[0].length;
  const bodyEnd = rest.indexOf('$$', bodyStart);
  expect(bodyEnd, `${name} の本体の終わりの $$ が見つからない`).toBeGreaterThan(bodyStart);
  return { header: rest.slice(0, opened.index), body: rest.slice(bodyStart, bodyEnd), whole: rest.slice(0, bodyEnd + 2) };
}

/** 本体の中の UPDATE 文 (UPDATE から ; まで) を、空白を 1 つにそろえて並べる */
function updateStatements(body: string): string[] {
  return [...body.matchAll(/\bUPDATE\s[^;]*;/g)].map((m) => m[0].replace(/\s+/g, ' ').trim());
}

/** 文の中の識別子の public. / pg_catalog. の接頭辞を外す (土台は search_path = public で接頭辞なしに書く) */
function unqualify(sql: string): string {
  return sql.replace(/\b(public|pg_catalog)\./g, '');
}

describe('#1917 家族グループ・組織の解散 (段 A の migration) のソース走査', () => {
  it('C-1 migration と rollback が対・1 行目の見出しと戻し方の案内が正しい・版の番号が重ならない', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    expect(fs.existsSync(ROLLBACK_PATH)).toBe(true);
    const lines = migration.split('\n');
    expect(lines[0]).toBe(`-- migration: ${MIGRATION_FILE}`);
    expect(lines[1]).toBe(`-- 戻し方: supabase/rollbacks/${ROLLBACK_FILE}`);
    expect(rollback.split('\n')[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
    const sameVersion = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.startsWith(`${VERSION}_`));
    expect(sameVersion).toEqual([MIGRATION_FILE]);
  });

  it("C-2 representative_id と owner_id の DROP NOT NULL が 1 文ずつあり、CHECK を DO ブロックで存在を確かめて足す。外部キー (RESTRICT) に触れない", () => {
    expect(code.match(/ALTER TABLE public\.family_groups ALTER COLUMN representative_id DROP NOT NULL;/g)).toHaveLength(1);
    expect(code.match(/ALTER TABLE public\.organizations ALTER COLUMN owner_id DROP NOT NULL;/g)).toHaveLength(1);

    const doBlock = /DO \$\$([\s\S]*?)\$\$;/.exec(code);
    expect(doBlock, 'CHECK を足す DO ブロックが見つからない').not.toBeNull();
    const block = (doBlock as RegExpExecArray)[1].replace(/\s+/g, ' ');
    expect(block).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_groups_active_has_representative') THEN");
    expect(block).toContain(
      "ALTER TABLE public.family_groups ADD CONSTRAINT family_groups_active_has_representative CHECK (status <> 'active' OR representative_id IS NOT NULL);",
    );
    expect(block).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_active_has_owner') THEN");
    expect(block).toContain(
      "ALTER TABLE public.organizations ADD CONSTRAINT organizations_active_has_owner CHECK (status <> 'active' OR owner_id IS NOT NULL);",
    );

    // 外部キー (auth.users への ON DELETE RESTRICT) は変えない
    expect(code).not.toMatch(/FOREIGN KEY|REFERENCES|_fkey/i);
    expect(code).not.toMatch(/DROP CONSTRAINT/i);
  });

  it.each(['family_dissolve_apply', 'org_dissolve_apply'])(
    "C-3 %s は SECURITY INVOKER・search_path ''・参照が完全修飾。REVOKE ... FROM PUBLIC, anon, authenticated と GRANT EXECUTE ... TO service_role",
    (name) => {
      const { header, body } = functionSource(code, name);
      expect(header).toMatch(/\bSECURITY INVOKER\b/);
      expect(header).not.toMatch(/SECURITY DEFINER/);
      expect(header).toMatch(/SET search_path = ''/);
      const unqualified = [...body.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_]\w*)(\.)?/gi)]
        .filter((m) => !m[2])
        .filter((m) => !/^v_/.test(m[1]))
        .map((m) => m[0]);
      expect(unqualified, 'スキーマ無しの表の参照').toEqual([]);
      const bare = [...body.matchAll(/(?<![.\w])(now|count|array_remove|array_agg|jsonb_build_object)\s*\(/gi)].map((m) => m[0]);
      expect(bare, 'pg_catalog 無しの組み込み関数').toEqual([]);
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${name}(uuid) FROM PUBLIC, anon, authenticated;`);
      const grants = [...code.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(uuid\\) TO ([^;]+);`, 'g'))].map((m) => m[1].trim());
      expect(grants).toEqual(['service_role']);
    },
  );

  it('C-4 後始末の UPDATE の並びは 20261017130000 の運営の RPC の並びと同じ (representative_id = NULL / owner_id = NULL を足した以外は、列と WHERE が同じ)', () => {
    const baseFamily = updateStatements(linesOf(OPERATOR_BASE_FILE, OPERATOR_FAMILY_LINES));
    const baseOrg = updateStatements(stripSqlComments(linesOf(OPERATOR_BASE_FILE, OPERATOR_ORG_LINES)));
    const applyFamily = updateStatements(functionSource(code, 'family_dissolve_apply').body).map(unqualify);
    const applyOrg = updateStatements(functionSource(code, 'org_dissolve_apply').body).map(unqualify);

    expect(baseFamily).toHaveLength(3);
    expect(applyFamily).toHaveLength(3);
    expect(applyFamily.slice(0, 2)).toEqual(baseFamily.slice(0, 2));
    expect(baseFamily[2]).toBe("UPDATE family_groups SET status = 'dissolved', dissolved_at = NOW() WHERE id = p_family_id RETURNING * INTO v_fam;");
    expect(applyFamily[2]).toBe(
      "UPDATE family_groups SET status = 'dissolved', dissolved_at = now(), representative_id = NULL WHERE id = p_family_id RETURNING * INTO v_fam;",
    );

    expect(baseOrg).toHaveLength(3);
    expect(applyOrg).toHaveLength(3);
    // 1 本目 (所属の列 6 つ) と 2 本目 (席数) は大文字小文字 (NOW / now) を除いて同じ
    expect(applyOrg.slice(0, 2).map((s) => s.toLowerCase())).toEqual(baseOrg.slice(0, 2).map((s) => s.toLowerCase()));
    expect(applyOrg[2].toLowerCase()).toBe(
      "update organizations set status = 'dissolved', dissolved_at = now(), updated_at = now(), owner_id = null where id = p_organization_id returning * into v_org;",
    );
    expect(baseOrg[2].toLowerCase()).toBe(
      "update organizations set status = 'dissolved', dissolved_at = now(), updated_at = now() where id = p_organization_id returning * into v_org;",
    );
  });

  it('C-5 利用者の解散の RPC は SECURITY DEFINER・RETURNS jsonb・REVOKE FROM PUBLIC, anon・GRANT TO authenticated, service_role。最初のロックの順', () => {
    for (const [name, arg] of [
      ['dissolve_family_by_representative', 'uuid'],
      ['dissolve_org_by_owner', 'uuid'],
    ] as const) {
      const { header } = functionSource(code, name);
      expect(header).toMatch(/RETURNS jsonb/);
      expect(header).toMatch(/\bSECURITY DEFINER\b/);
      expect(header).toMatch(/SET search_path = ''/);
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${name}(${arg}) FROM PUBLIC, anon;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(${arg}) TO authenticated, service_role;`);
    }

    // 家族: auth.uid() の検査のあと、最初の表の文が family_groups の FOR NO KEY UPDATE
    const family = functionSource(code, 'dissolve_family_by_representative').body;
    const familyTableStatements = [...family.matchAll(/\b(?:SELECT|PERFORM)\b[^;]*\bFROM\s+public\.\w+[^;]*;/g)].map((m) => m[0].replace(/\s+/g, ' '));
    expect(familyTableStatements[0]).toMatch(/FROM public\.family_groups WHERE id = p_family_id FOR NO KEY UPDATE;$/);

    // 組織: user_profiles (本人) の FOR NO KEY UPDATE → organizations の FOR NO KEY UPDATE の順
    const org = functionSource(code, 'dissolve_org_by_owner').body;
    const orgTableStatements = [...org.matchAll(/\b(?:SELECT|PERFORM)\b[^;]*\bFROM\s+public\.\w+[^;]*;/g)].map((m) => m[0].replace(/\s+/g, ' '));
    expect(orgTableStatements[0]).toBe('PERFORM 1 FROM public.user_profiles WHERE id = auth.uid() FOR NO KEY UPDATE;');
    expect(orgTableStatements[1]).toMatch(/FROM public\.organizations WHERE id = p_organization_id FOR NO KEY UPDATE;$/);
  });

  it('C-6 RAISE するコードはすべて MembershipErrorCode にある', () => {
    const raised = new Set<string>();
    for (const name of ['dissolve_family_by_representative', 'dissolve_org_by_owner']) {
      for (const m of functionSource(code, name).body.matchAll(/RAISE EXCEPTION '([A-Z_]+)'/g)) raised.add(m[1]);
    }
    expect([...raised].sort()).toEqual(
      [
        'NOT_AUTHENTICATED',
        'FAMILY_NOT_FOUND',
        'FAMILY_ALREADY_DISSOLVED',
        'NOT_FAMILY_REPRESENTATIVE',
        'ORG_NOT_FOUND',
        'ORG_ALREADY_DISSOLVED',
        'NOT_ORG_OWNER',
      ].sort(),
    );
    const known = new Set<string>(Object.values(MembershipErrorCode));
    expect([...raised].filter((c) => !known.has(c))).toEqual([]);
  });

  it('C-7 監査は group_dissolved・actor_id = auth.uid()・metadata の鍵は dissolved_by / previous_* / member_count。戻り値の鍵は scope_id / scope_name / dissolved_at / member_user_ids', () => {
    const cases = [
      { name: 'dissolve_family_by_representative', scope: 'family', by: 'representative', prev: 'previous_representative_id' },
      { name: 'dissolve_org_by_owner', scope: 'organization', by: 'owner', prev: 'previous_owner_id' },
    ] as const;
    for (const c of cases) {
      const body = functionSource(code, c.name).body.replace(/\s+/g, ' ');
      expect(body).toContain(
        `INSERT INTO public.membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata) VALUES ('${c.scope}', ${c.scope === 'family' ? 'p_family_id' : 'p_organization_id'}, 'group_dissolved', auth.uid(), NULL,`,
      );
      expect(body).toContain(`'dissolved_by', '${c.by}', '${c.prev}', auth.uid(), 'member_count', v_member_count`);
      expect(body).toMatch(/RETURN pg_catalog\.jsonb_build_object\( 'scope_id', v_\w+\.id, 'scope_name', v_\w+\.name, 'dissolved_at', v_\w+\.dissolved_at, 'member_user_ids', pg_catalog\.to_jsonb\(v_member_ids\) \);/);
    }
  });

  it('C-8 運営の RPC 2 本の判定の部分が 20261017130000 と逐語で同じで、本体は *_dissolve_apply の呼び出し 1 文。監査の metadata に previous_*', () => {
    const baseOrg = linesOf(OPERATOR_BASE_FILE, OPERATOR_ORG_LINES);
    const baseFamily = linesOf(OPERATOR_BASE_FILE, OPERATOR_FAMILY_LINES);
    const org = functionSource(migration, 'operator_force_dissolve_org').whole;
    const family = functionSource(migration, 'operator_force_dissolve_family').whole;

    // 判定の部分 (見出し〜ORG_ALREADY_DISSOLVED の END IF / MFA の END IF) は土台と同じ文字列で始まる
    const orgJudge = baseOrg.slice(0, baseOrg.indexOf("RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED'"));
    const orgJudgeTail = orgJudge.slice(orgJudge.indexOf('BEGIN'));
    expect(org).toContain(orgJudgeTail);
    expect(org).toContain(baseOrg.slice(0, baseOrg.indexOf('DECLARE')));
    expect(org).toContain("RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';");
    const familyJudge = baseFamily.slice(baseFamily.indexOf('BEGIN'), baseFamily.indexOf('  -- LOCK-ORDER (#1310)'));
    expect(family).toContain(familyJudge);
    expect(family).toContain(baseFamily.slice(0, baseFamily.indexOf('DECLARE')));

    // 本体の UPDATE は書かず、後始末の関数の呼び出しが 1 文ずつ
    expect(updateStatements(functionSource(code, 'operator_force_dissolve_org').body)).toEqual([]);
    expect(updateStatements(functionSource(code, 'operator_force_dissolve_family').body)).toEqual([]);
    expect(org.match(/v_org := public\.org_dissolve_apply\(p_organization_id\);/g)).toHaveLength(1);
    expect(family.match(/v_fam := public\.family_dissolve_apply\(p_family_id\);/g)).toHaveLength(1);

    // 監査の action は operator_force_dissolve のまま。metadata に previous_*
    expect(org).toContain("'operator_force_dissolve',");
    expect(org).toContain("'previous_owner_id', v_prev_owner");
    expect(family).toContain("'operator_force_dissolve', NULL,");
    expect(family).toContain("'previous_representative_id', v_prev_rep");
  });

  it('C-9 rollback は利用者の RPC 2 本と後始末 2 本を DROP し、運営の 2 本を 20261017130000 の定義と逐語で戻し、CHECK を外し、NOT NULL は NULL の行が無いときだけ戻す。行を消す文を持たない', () => {
    for (const name of ['dissolve_family_by_representative', 'dissolve_org_by_owner', 'family_dissolve_apply', 'org_dissolve_apply']) {
      expect(rollbackCode).toContain(`DROP FUNCTION IF EXISTS public.${name}(uuid);`);
    }
    expect(rollback).toContain(linesOf(OPERATOR_BASE_FILE, OPERATOR_ORG_LINES));
    expect(rollback).toContain(linesOf(OPERATOR_BASE_FILE, OPERATOR_FAMILY_LINES));
    // 運営の 2 本を戻してから後始末の関数を DROP する
    expect(rollbackCode.indexOf('DROP FUNCTION IF EXISTS public.family_dissolve_apply(uuid);')).toBeGreaterThan(
      rollbackCode.indexOf('CREATE OR REPLACE FUNCTION public.operator_force_dissolve_family('),
    );
    expect(rollbackCode).toContain('ALTER TABLE public.family_groups DROP CONSTRAINT IF EXISTS family_groups_active_has_representative;');
    expect(rollbackCode).toContain('ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_active_has_owner;');
    const compact = rollbackCode.replace(/\s+/g, ' ');
    expect(compact).toContain(
      'IF NOT EXISTS (SELECT 1 FROM public.family_groups WHERE representative_id IS NULL) THEN ALTER TABLE public.family_groups ALTER COLUMN representative_id SET NOT NULL;',
    );
    expect(compact).toContain(
      'IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE owner_id IS NULL) THEN ALTER TABLE public.organizations ALTER COLUMN owner_id SET NOT NULL;',
    );
    expect(rollbackCode).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/i);
    // rollback の UPDATE は運営の RPC の本体 (逐語で戻したもの) の中だけ
    const outsideFunctions = rollbackCode.replace(/AS \$\$[\s\S]*?\$\$;/g, '');
    expect(outsideFunctions).not.toMatch(/\bUPDATE\b/i);
  });

  it("C-10 DISSOLVED_FAMILY_GROUP_RETENTION_DAYS (LEGAL_FACTS の 90) は purge_dissolved_family_groups の c_retention (interval '90 days') と一致する", () => {
    const purge = fs.readFileSync(PURGE_FILE, 'utf-8');
    const retention = /c_retention\s+CONSTANT pg_catalog\.interval := interval '(\d+) days';/.exec(purge);
    expect(retention, 'c_retention の定義が見つからない').not.toBeNull();
    expect(DISSOLVED_FAMILY_GROUP_RETENTION_DAYS).toBe(Number((retention as RegExpExecArray)[1]));
  });

  it('C-11 既に dissolved の行の representative_id / owner_id を NULL にする UPDATE が 1 文ずつあり、WHERE に status = dissolved を持つ', () => {
    const outsideFunctions = code.replace(/AS \$\$[\s\S]*?\$\$;/g, '');
    const updates = updateStatements(outsideFunctions);
    expect(updates).toEqual([
      "UPDATE public.family_groups SET representative_id = NULL WHERE status = 'dissolved' AND representative_id IS NOT NULL;",
      "UPDATE public.organizations SET owner_id = NULL WHERE status = 'dissolved' AND owner_id IS NOT NULL;",
    ]);
  });

  it('C-12 migration の中に、関数の外の DELETE・TRUNCATE が無い', () => {
    const outsideFunctions = code.replace(/AS \$\$[\s\S]*?\$\$;/g, '');
    expect(outsideFunctions).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/i);
  });

  it('C-13 guard_family_groups_privileged は RETURNS trigger・LANGUAGE plpgsql で SECURITY DEFINER も SET search_path も持たず、5 列を守る。rollback は 20251126124224 の定義と逐語で同じ', () => {
    const occurrences = code.match(/CREATE OR REPLACE FUNCTION public\.guard_family_groups_privileged\(\)/g);
    expect(occurrences).toHaveLength(1);
    const { header, body } = functionSource(code, 'guard_family_groups_privileged');
    expect(header).toMatch(/RETURNS trigger/);
    expect(header).toMatch(/LANGUAGE plpgsql/);
    expect(header).not.toMatch(/SECURITY DEFINER/);
    expect(header).not.toMatch(/search_path/i);
    const compact = body.replace(/\s+/g, ' ');
    expect(compact).toContain("IF current_user IN ('authenticated','anon') THEN");
    for (const column of ['representative_id', 'plan_key', 'member_limit', 'status', 'dissolved_at']) {
      expect(compact).toMatch(new RegExp(`NEW\\.${column} IS DISTINCT FROM OLD\\.${column}`));
    }
    expect(compact).toContain("RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';");
    // トリガー・POLICY・GRANT (family_groups の) は作り直さない
    expect(code).not.toMatch(/trg_guard_family_groups_privileged/);
    expect(code).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY/i);
    expect(code).not.toMatch(/ON (TABLE )?public\.family_groups/i);
    expect(rollback).toContain(linesOf(GUARD_BASE_FILE, GUARD_LINES));
    expect(linesOf(GUARD_BASE_FILE, GUARD_LINES).split('\n')).toHaveLength(GUARD_LINES.to - GUARD_LINES.from + 1);
  });
});
