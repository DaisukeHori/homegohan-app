/**
 * #1173 (#1713 段 A): migration *_parental_consent_and_birth_date.sql (と、そのロールバック) のソース走査 contract テスト (DB は使わない)
 * 設計書 docs/design/cross/14-parental-consent.md §6.13 の C (T-MIG1〜T-MIG5)。
 *
 * 本物の DB での振る舞いは tests/integration/security/parental-consent.test.ts と legal-documents-acceptance.test.ts が確かめる。
 * ここでは、番号の付け直しや後の migration の上書き、shared の定数とのずれで崩れやすい所を、ファイルの文面だけで確かめる。
 *   T-MIG1 本 migration が作り直す関数・CHECK を最後に定義し、ロールバックが対になる
 *   T-MIG2 SQL の数値 (18 / 13 / 120 / 100 / 512 / 20) が shared の定数と一致する
 *   T-MIG3 database.types.ts (2 本) に新しい表・列・RPC の引数が入っている
 *   T-MIG4 昇格 2 本と accept_legal_documents の IF の順番
 *   T-MIG5 18 歳未満の本人の役割を断る 4 関数は、土台の本文に IF を 1 つ足しただけ。ロールバックは土台の本文に戻す
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADULT_AGE_YEARS,
  BIRTH_DATE_MAX_AGE_YEARS,
  COPPA_AGE_YEARS,
  LEGAL_VERSION_MAX_LENGTH,
  LEGAL_VERSION_PATTERN,
  PARENTAL_CONSENT_VERSION_PATTERN,
  SIGNED_NAME_MAX_LENGTH,
} from '@homegohan/shared';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_parental_consent_and_birth_date';
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;
/** UA を切る長さの正本 (POST /api/legal/accept の MAX_USER_AGENT_LENGTH。accept_legal_documents と同じ値) */
const ACCEPT_ROUTE = 'src/app/api/legal/accept/route.ts';

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** `--` から行末までのコメントを除く (この走査の対象の関数の本文は文字列の中に `--` を書いていない) */
const stripLineComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
/** 空白を 1 つに詰める */
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const migrationFiles = fs
  .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
  .filter((name) => MIGRATION_FILE.test(name))
  .sort();
const ours = migrationFiles.filter((name) => name.endsWith(`${STEM_SUFFIX}.sql`));
const ourVersion = ours[0]?.slice(0, 14) ?? '';
const MIGRATION = `${MIGRATIONS_DIR}/${ours[0]}`;
const ROLLBACK = `${ROLLBACKS_DIR}/${ourVersion}${STEM_SUFFIX}.down.sql`;
const migrationRaw = read(MIGRATION);
const rollbackRaw = read(ROLLBACK);
const migration = stripLineComments(migrationRaw);
const rollback = stripLineComments(rollbackRaw);

/** `CREATE OR REPLACE FUNCTION <name>(` の見出し (引用符つきの書き方も拾う) */
const definesPattern = (fn: string): RegExp =>
  new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:"?public"?\\.)?"?${fn}"?\\s*\\(`, 'i');

/** 関数の本文 ($$ の直後から END $$ の手前まで) を、行コメントを除いて空白を詰めて返す */
function bodyOf(code: string, fn: string): string {
  const match = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:"?public"?\\.)?"?${fn}"?\\s*\\([\\s\\S]*?\\$\\$([\\s\\S]*?)(?:END\\s+)?\\$\\$;`,
    'i',
  ).exec(stripLineComments(code));
  if (!match) throw new Error(`${fn} の定義が無い`);
  return squash(match[1]);
}

/** 本 migration より前で、その関数を最後に定義した migration (土台) */
function baseDefinerOf(fn: string): string {
  const before = migrationFiles.filter((name) => name < ours[0]);
  const definers = before.filter((name) => definesPattern(fn).test(stripLineComments(read(`${MIGRATIONS_DIR}/${name}`))));
  const last = definers[definers.length - 1];
  if (!last) throw new Error(`${fn} を定義する migration が無い`);
  return last;
}

/** 本 migration が作り直す関数 (§6.4 の 8・9・10・11・12) */
const REDEFINED_FUNCTIONS = [
  'add_family_child',
  'accept_legal_documents',
  'request_child_promotion',
  'accept_child_promotion',
  'create_family_group',
  'accept_family_invite',
  'accept_family_representative_transfer',
  'accept_org_owner_transfer',
  'guard_user_profiles_privileged',
  'guard_user_profiles_privileged_on_insert',
  'guard_family_members_privileged',
] as const;

/** 本 migration の後にその関数を作り直した migration の名前の後半 (version の 14 桁を除く)。billing/03 §6.6 が家族プランの門を足して create_family_group を作り直す */
const LATER_REDEFINER_SUFFIXES: Readonly<Partial<Record<(typeof REDEFINED_FUNCTIONS)[number], readonly string[]>>> = {
  create_family_group: ['_billing_paid_plans_iap.sql'],
  // 20261022140000: 解散と同時の承諾のロックと判定し直し (MINOR_ACCOUNT_NOT_ALLOWED の IF は BEGIN の直後のまま。tests/org-transfer-toctou-migration-contract.test.ts)
  accept_org_owner_transfer: ['_org_transfer_toctou.sql'],
};

/** 18 歳未満の本人の役割を断る IF (§6.4 の 12)。行コメントを除いて空白を詰めた形 */
const MINOR_IF = "IF public.caller_is_minor_jst() THEN RAISE EXCEPTION 'MINOR_ACCOUNT_NOT_ALLOWED' USING ERRCODE = 'P0001'; END IF;";
const NOT_AUTHENTICATED_IF = "IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001'; END IF;";
/** IF を NOT_AUTHENTICATED の IF の直後に置く 2 本と、BEGIN の直後に置く 2 本 */
const MINOR_ROLE_FUNCTIONS = [
  { fn: 'create_family_group', after: `BEGIN ${NOT_AUTHENTICATED_IF} ` },
  { fn: 'accept_family_invite', after: `BEGIN ${NOT_AUTHENTICATED_IF} ` },
  { fn: 'accept_family_representative_transfer', after: 'BEGIN ' },
  { fn: 'accept_org_owner_transfer', after: 'BEGIN ' },
] as const;

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('#1173 migration とロールバックのファイル (T-MIG1)', () => {
  it('本 migration はちょうど 1 本で、同じ番号のロールバックがあり、冒頭の参照が実在する', () => {
    expect(ours).toHaveLength(1);
    expect(fs.existsSync(path.join(ROOT, ROLLBACK))).toBe(true);
    expect(migrationRaw.split('\n')[0]).toBe(`-- migration: ${ours[0]}`);
    expect(rollbackRaw.split('\n')[0]).toBe(`-- rollback: ${ours[0]}`);
    // 本文の戻し口の参照は自分の 1 本だけ
    const rollbackRefs = [...migrationRaw.matchAll(/supabase\/rollbacks\/[\w.-]+/g)].map((m) => m[0]);
    expect(new Set(rollbackRefs)).toEqual(new Set([ROLLBACK]));
    // 冒頭のコメントが名指しする migration・テストのファイルが実在する
    const header = migrationRaw.split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const [name] of header.matchAll(/\b20\d{12}_[a-z0-9_]+\.sql\b/g)) {
      expect(migrationFiles, name).toContain(name);
    }
    for (const [file] of header.matchAll(/\btests\/[\w/.-]+\.test\.ts\b/g)) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });

  it.each(REDEFINED_FUNCTIONS)('%s を本 migration が作り直し、その後に作り直した migration は LATER_REDEFINER_SUFFIXES のものだけで、ロールバックが同じ関数を定義し直す', (fn) => {
    const definers = migrationFiles.filter((name) => definesPattern(fn).test(stripLineComments(read(`${MIGRATIONS_DIR}/${name}`))));
    expect(definers).toContain(ours[0]);
    expect(definers.filter((name) => name > ours[0]).map((name) => name.slice(ourVersion.length))).toEqual(LATER_REDEFINER_SUFFIXES[fn] ?? []);
    expect(rollback).toMatch(definesPattern(fn));
  });

  it('membership_audit_action_check を最後に定義する migration が本 migration で、parental_consent_* の 2 値を足し、ロールバックは 26 値に戻す', () => {
    const definers = migrationFiles.filter((name) =>
      /CONSTRAINT\s+"?membership_audit_action_check"?\s+CHECK/i.test(stripLineComments(read(`${MIGRATIONS_DIR}/${name}`))),
    );
    expect(definers[definers.length - 1]).toBe(ours[0]);
    const values = (sql: string): string[] => {
      const match = /ADD CONSTRAINT membership_audit_action_check CHECK \(action = ANY \(ARRAY\[([^\]]*)\]/.exec(squash(sql));
      if (!match) throw new Error('membership_audit_action_check が無い');
      return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    };
    const baseline = read(`${MIGRATIONS_DIR}/${definers[definers.length - 2]}`);
    const baselineMatch = /CONSTRAINT "membership_audit_action_check" CHECK \(\("action" = ANY \(ARRAY\[([^\]]*)\]/.exec(baseline);
    if (!baselineMatch) throw new Error('土台の membership_audit_action_check が無い');
    const previous = [...baselineMatch[1].matchAll(/'([a-z_]+)'::"text"/g)].map((m) => m[1]);
    expect(previous).toHaveLength(26);
    expect(values(migration)).toEqual([...previous, 'parental_consent_recorded', 'parental_consent_revoked']);
    expect(values(rollback)).toEqual(previous);
  });

  it('ロールバックは本 migration が足した表・列・関数・トリガーを消し、旧 signature の 2 本を作り直す', () => {
    const flat = squash(rollback);
    expect(flat).toContain('DROP TABLE IF EXISTS public.parental_consents;');
    expect(flat).toContain('ALTER TABLE public.family_members DROP COLUMN IF EXISTS birth_date;');
    expect(flat).toContain('ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS birth_date;');
    expect(flat).toContain('ALTER TABLE public.family_members DROP CONSTRAINT IF EXISTS family_members_child_birth_date_required;');
    expect(flat).toContain('DROP INDEX IF EXISTS public.idx_family_members_child_birth_date;');
    for (const signature of [
      'caller_is_minor_jst()',
      'revoke_parental_consent_on_member_delete()',
      'revoke_parental_consent_on_member_inactive()',
      'legal_minor_has_guardian_path()',
      'parental_consent_active(uuid)',
      'age_years_jst(date)',
      'accept_legal_documents(text, text, inet, text, date)',
      'add_family_child(uuid, text, jsonb, date, text, text, boolean, inet, text)',
    ]) {
      expect(flat, signature).toContain(`DROP FUNCTION IF EXISTS public.${signature};`);
    }
    for (const trigger of ['trg_family_members_revoke_parental_consent', 'trg_family_members_revoke_parental_consent_on_delete']) {
      expect(flat, trigger).toContain(`DROP TRIGGER IF EXISTS ${trigger} ON public.family_members;`);
    }
    // 旧 signature に戻した 2 本は、土台の定義と同じ本文 + 同じ ACL
    for (const fn of ['accept_legal_documents', 'add_family_child'] as const) {
      expect(bodyOf(rollbackRaw, fn), fn).toBe(bodyOf(read(`${MIGRATIONS_DIR}/${baseDefinerOf(fn)}`), fn));
    }
    expect(flat).toContain('GRANT EXECUTE ON FUNCTION public.accept_legal_documents(text, text, inet, text) TO authenticated;');
    expect(flat).toContain('GRANT EXECUTE ON FUNCTION public.add_family_child(uuid, text, jsonb) TO authenticated, service_role;');
    // ガード 3 本・昇格 2 本も土台の本文に戻す
    for (const fn of [
      'guard_user_profiles_privileged',
      'guard_user_profiles_privileged_on_insert',
      'guard_family_members_privileged',
      'request_child_promotion',
      'accept_child_promotion',
    ] as const) {
      expect(bodyOf(rollbackRaw, fn), fn).toBe(bodyOf(read(`${MIGRATIONS_DIR}/${baseDefinerOf(fn)}`), fn));
    }
  });

  it('特権列ガード 3 本は、土台の本文に birth_date の 1 行を足しただけ', () => {
    const cases = [
      { fn: 'guard_user_profiles_privileged', line: 'OR NEW.birth_date IS DISTINCT FROM OLD.birth_date ' },
      { fn: 'guard_user_profiles_privileged_on_insert', line: 'OR NEW.birth_date IS NOT NULL ' },
      { fn: 'guard_family_members_privileged', line: 'OR NEW.birth_date IS DISTINCT FROM OLD.birth_date ' },
    ] as const;
    for (const { fn, line } of cases) {
      const now = bodyOf(migrationRaw, fn);
      expect(countOf(now, line), fn).toBe(1);
      expect(now.replace(line, ''), fn).toBe(bodyOf(read(`${MIGRATIONS_DIR}/${baseDefinerOf(fn)}`), fn));
    }
  });
});

describe('#1173 SQL の数値と shared の定数 (T-MIG2)', () => {
  it('SQL の数値 (18 / 13 / 120 / 100 / 512 / 20) が shared の定数と一致する (ADULT_AGE_YEARS 等を import して文字列で突き合わせる)', () => {
    const flat = squash(migration);
    // 18 (ADULT_AGE_YEARS): add_family_child・accept_legal_documents・昇格 2 本・caller_is_minor_jst の境
    expect(countOf(flat, `v_age < ${ADULT_AGE_YEARS}`)).toBe(4);
    expect(countOf(flat, `public.age_years_jst(v_signer_birth) < ${ADULT_AGE_YEARS}`)).toBe(1);
    expect(countOf(flat, `public.age_years_jst(v_member.birth_date) < ${ADULT_AGE_YEARS} AND NOT public.parental_consent_active`)).toBe(2);
    expect(countOf(flat, `public.age_years_jst(up.birth_date) < ${ADULT_AGE_YEARS}`)).toBe(1);
    expect(flat).toContain(`CHECK (child_age_at_signing BETWEEN 0 AND ${ADULT_AGE_YEARS - 1})`);
    // 13 (COPPA_AGE_YEARS): accept_legal_documents と昇格 2 本
    expect(countOf(flat, `v_age < ${COPPA_AGE_YEARS}`)).toBe(1);
    expect(countOf(flat, `public.age_years_jst(v_member.birth_date) < ${COPPA_AGE_YEARS}`)).toBe(2);
    // 120 (BIRTH_DATE_MAX_AGE_YEARS): add_family_child と accept_legal_documents
    expect(countOf(flat, `INTERVAL '${BIRTH_DATE_MAX_AGE_YEARS} years'`)).toBe(2);
    // 100 (SIGNED_NAME_MAX_LENGTH): 表の CHECK と add_family_child
    expect(flat).toContain(`CHECK (length(signed_name) BETWEEN 1 AND ${SIGNED_NAME_MAX_LENGTH})`);
    expect(flat).toContain(`length(v_signed_name) > ${SIGNED_NAME_MAX_LENGTH}`);
    // 512 (POST /api/legal/accept の MAX_USER_AGENT_LENGTH と同じ)
    const uaMatch = /const MAX_USER_AGENT_LENGTH = (\d+);/.exec(read(ACCEPT_ROUTE));
    if (!uaMatch) throw new Error('MAX_USER_AGENT_LENGTH が無い');
    expect(countOf(flat, `left(p_user_agent, ${uaMatch[1]})`)).toBe(2);
    // 20 (版の形。LEGAL_VERSION_PATTERN / PARENTAL_CONSENT_VERSION_PATTERN と同じ)
    expect(PARENTAL_CONSENT_VERSION_PATTERN.source).toBe(LEGAL_VERSION_PATTERN.source);
    expect(LEGAL_VERSION_PATTERN.source).toContain(`{1,${LEGAL_VERSION_MAX_LENGTH}}`);
    const patterns = [...flat.matchAll(/'(\^\[0-9A-Za-z\._-\]\{1,\d+\}\$)'/g)].map((m) => m[1]);
    expect(patterns.length).toBe(4);
    for (const pattern of patterns) expect(pattern).toBe(PARENTAL_CONSENT_VERSION_PATTERN.source);
    expect(flat).toContain(`consent_version varchar(${LEGAL_VERSION_MAX_LENGTH}) NOT NULL`);
  });
});

describe('#1173 database.types.ts (T-MIG3)', () => {
  it.each(TYPE_FILES)('%s に parental_consents と birth_date 列 (user_profiles / family_members) と新しい RPC の引数が入っている', (file) => {
    const types = read(file);
    const section = (start: string, end: string): string => {
      const from = types.indexOf(start);
      if (from < 0) throw new Error(`${start} が無い`);
      const to = types.indexOf(end, from + start.length);
      return types.slice(from, to < 0 ? undefined : to);
    };
    // 表の Row の型 (Insert / Update の前まで)
    const rowOf = (table: string): string => section(`      ${table}: {\n        Row: {`, '        Insert: {');
    expect(rowOf('parental_consents')).toMatch(/consent_version: string\n/);
    expect(rowOf('parental_consents')).toMatch(/family_member_id: string \| null\n/);
    expect(rowOf('parental_consents')).toMatch(/child_age_at_signing: number\n/);
    expect(rowOf('user_profiles')).toMatch(/\n {10}birth_date: string \| null\n/);
    expect(rowOf('family_members')).toMatch(/\n {10}birth_date: string \| null\n/);
    // RPC の引数
    const argsOf = (fn: string): string => section(`      ${fn}: {\n        Args:`, '        Returns:');
    const addChild = argsOf('add_family_child');
    for (const arg of ['p_birth_date: string', 'p_consent_version?: string', 'p_signed_name?: string', 'p_guardian_attested?: boolean', 'p_ip?: unknown', 'p_user_agent?: string']) {
      expect(addChild, arg).toContain(arg);
    }
    expect(argsOf('accept_legal_documents')).toContain('p_birth_date?: string');
    for (const fn of ['age_years_jst', 'parental_consent_active', 'legal_minor_has_guardian_path', 'caller_is_minor_jst']) {
      expect(types, fn).toMatch(new RegExp(`\\n {6}${fn}: \\{\\s*Args:`));
    }
    // トリガー関数は型に出ない
    expect(types).not.toContain('revoke_parental_consent_on_member_inactive');
    expect(types).not.toContain('revoke_parental_consent_on_member_delete');
  });
});

describe('#1173 IF の順番 (T-MIG4)', () => {
  it('本 migration の request_child_promotion と accept_child_promotion の本文で、IF v_member.birth_date IS NULL → CHILD_BIRTH_DATE_REQUIRED、< 13 → PROMOTION_UNDER_COPPA_AGE、PARENTAL_CONSENT_REQUIRED の 3 つの IF がこの順にあり、3 つとも ALREADY_PROMOTED (request は PROMOTION_MEMBER_UNAVAILABLE) の IF の後・最初の INSERT / UPDATE の前にある。本 migration の accept_legal_documents の本文で、v_age < 13 の IF が legal_minor_has_guardian_path() を呼ぶ IF の前にあり、どちらも INSERT INTO public.user_profiles の前にある', () => {
    const cases = [
      { fn: 'request_child_promotion', anchor: "RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE'" },
      { fn: 'accept_child_promotion', anchor: "RAISE EXCEPTION 'ALREADY_PROMOTED'" },
    ] as const;
    for (const { fn, anchor } of cases) {
      const body = bodyOf(migrationRaw, fn);
      const anchorAt = body.lastIndexOf(anchor);
      const required = body.indexOf("IF v_member.birth_date IS NULL THEN RAISE EXCEPTION 'CHILD_BIRTH_DATE_REQUIRED'");
      const coppa = body.indexOf(`IF public.age_years_jst(v_member.birth_date) < ${COPPA_AGE_YEARS} THEN RAISE EXCEPTION 'PROMOTION_UNDER_COPPA_AGE'`);
      const consent = body.indexOf(
        `IF public.age_years_jst(v_member.birth_date) < ${ADULT_AGE_YEARS} AND NOT public.parental_consent_active(v_member.id) THEN RAISE EXCEPTION 'PARENTAL_CONSENT_REQUIRED'`,
      );
      const firstWrite = Math.min(
        ...[/\bINSERT INTO\b/, /\bUPDATE (?!OF\b)\w+ SET\b/]
          .map((re) => body.search(re))
          .filter((at) => at >= 0),
      );
      expect(anchorAt, fn).toBeGreaterThan(0);
      expect(required, fn).toBeGreaterThan(anchorAt);
      expect(coppa, fn).toBeGreaterThan(required);
      expect(consent, fn).toBeGreaterThan(coppa);
      expect(firstWrite, fn).toBeGreaterThan(consent);
      // 3 つの IF は 1 回ずつ
      expect(countOf(body, "'CHILD_BIRTH_DATE_REQUIRED'"), fn).toBe(1);
      expect(countOf(body, "'PROMOTION_UNDER_COPPA_AGE'"), fn).toBe(1);
      expect(countOf(body, "'PARENTAL_CONSENT_REQUIRED'"), fn).toBe(1);
    }
    // 承諾は子供の行の生年月日を本人のプロフィールへ写す (上書き)
    expect(bodyOf(migrationRaw, 'accept_child_promotion')).toContain(
      'ON CONFLICT (id) DO UPDATE SET family_id = EXCLUDED.family_id, birth_date = EXCLUDED.birth_date;',
    );

    const legal = bodyOf(migrationRaw, 'accept_legal_documents');
    const under13 = legal.indexOf(`IF v_age < ${COPPA_AGE_YEARS} THEN RAISE EXCEPTION 'LEGAL_MINOR_SELF_SIGNUP_REFUSED'`);
    const guardianPath = legal.indexOf(
      `IF v_age < ${ADULT_AGE_YEARS} AND NOT public.legal_minor_has_guardian_path() THEN RAISE EXCEPTION 'LEGAL_MINOR_SELF_SIGNUP_REFUSED'`,
    );
    const profileInsert = legal.indexOf('INSERT INTO public.user_profiles');
    expect(under13).toBeGreaterThan(0);
    expect(guardianPath).toBeGreaterThan(under13);
    expect(profileInsert).toBeGreaterThan(guardianPath);
  });
});

describe('#1173 18 歳未満の本人の家族・組織の役割 (T-MIG5)', () => {
  it.each(MINOR_ROLE_FUNCTIONS)('$fn: 本文に MINOR_ACCOUNT_NOT_ALLOWED の IF がちょうど 1 つ決まった位置にあり、それを除くと土台の本文と一致する。ロールバックは土台の本文に戻す', ({ fn, after }) => {
    const base = bodyOf(read(`${MIGRATIONS_DIR}/${baseDefinerOf(fn)}`), fn);
    const now = bodyOf(migrationRaw, fn);
    expect(countOf(now, MINOR_IF)).toBe(1);
    // 位置: BEGIN の直後 (create_family_group / accept_family_invite は NOT_AUTHENTICATED の IF の直後)
    expect(now.indexOf(`${after}${MINOR_IF}`)).toBe(now.indexOf('BEGIN '));
    expect(now.replace(`${MINOR_IF} `, '')).toBe(base);
    expect(bodyOf(rollbackRaw, fn)).toBe(base);
  });

  it('create_family_group の土台は #1678 の定義 (normalize_profile_name の式つき) で、本 migration と戻し口は normalize_profile_name を定義しない', () => {
    expect(baseDefinerOf('create_family_group')).toMatch(/_rpc_profile_name_placeholder\.sql$/);
    expect(bodyOf(migrationRaw, 'create_family_group')).toContain('public.normalize_profile_name(nickname)');
    expect(migration).not.toMatch(definesPattern('normalize_profile_name'));
    expect(rollback).not.toMatch(definesPattern('normalize_profile_name'));
  });

  it('caller_is_minor_jst() は 18 歳 (ADULT_AGE_YEARS) の境で age_years_jst を使い、どのロールにも開けない', () => {
    const definition = squash(
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.caller_is_minor_jst\\(\\)[\\s\\S]*?\\$\\$;`).exec(migration)?.[0] ?? '',
    );
    expect(definition).toContain(`public.age_years_jst(up.birth_date) < ${ADULT_AGE_YEARS}`);
    expect(definition).not.toMatch(/SECURITY DEFINER/i);
    expect(squash(migration)).toContain(
      'REVOKE ALL ON FUNCTION public.caller_is_minor_jst() FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(squash(migration)).not.toMatch(new RegExp(`GRANT [^;]* ON FUNCTION public\\.${escapeRegExp('caller_is_minor_jst()')}`));
  });
});
