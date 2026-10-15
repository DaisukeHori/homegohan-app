/**
 * billing/01 (課金の核) 段 A: migration *_billing_core.sql とロールバックの SQL の文面の契約テスト (DB は使わない)
 *
 * DB の上での振る舞い (写像・権利の取得・RLS・トリガー) は tests/integration/rls/billing-*.test.ts と
 * tests/integration/security/billing-personal-subscriptions-rls.test.ts が確かめる。ここでは、番号の付け直しや後の migration の
 * 上書きで崩れやすい所を、ファイルの文面だけで確かめる (設計: docs/design/billing/01-billing-core.md §6・§14.1 の 44〜49)。
 *   44. status の CHECK に incomplete を足し、ほかの 7 値を保つ
 *   45. 利用者本人の INSERT / UPDATE のポリシー (user_id = auth.uid() の枝) を外し、SELECT / DELETE のポリシーは触らない
 *   46. DB 関数 3 本は SECURITY DEFINER・search_path が空・EXECUTE は service_role だけ。トリガー関数も SECURITY DEFINER・
 *       search_path が空で、PUBLIC / anon / authenticated から外してある
 *   47. ロールバックは、ベースラインのポリシーと 20261008200700 の特権列ガードの定義をそのまま戻し、migration が足したものを全部消す
 *   48. 関数の本体の外に、既存の行の UPDATE / DELETE が無い
 *   49. 冒頭のコメントに判断の帰属 (「オーナー判断」など) を書かない
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_billing_core';
/** 特権列ガード 2 本を最後に定義していた migration (#1174)。ロールバックの戻す先 */
const GUARD_SOURCE_MIGRATION = `${MIGRATIONS_DIR}/20261008200700_legal_documents_acceptance.sql`;
/** 本番スキーマのスナップショット (personal_subscriptions のポリシーの戻す先) */
const BASELINE_SCHEMA = 'supabase/baseline/prod_schema.sql';

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** `--` から行末までのコメントを除く (この 2 ファイルは文字列の中に `--` を書いていない) */
const stripLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
/** 空白を 1 つに詰める */
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

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

/** ドル引用の関数の本体 ($$ … $$) を空にした SQL (本体の外の文だけを見るため) */
const withoutFunctionBodies = (sql: string): string => sql.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');

/** 文 (`;` 区切り) の一覧。関数の本体は空にしてから切る */
const statementsOutsideBodies = (sql: string): string[] =>
  withoutFunctionBodies(sql)
    .split(';')
    .map((s) => squash(s))
    .filter((s) => s.length > 0);

/** `CREATE OR REPLACE FUNCTION public.<name>(` から本体の終わり (`$$;`) までを取り出す */
function functionDefinition(sql: string, name: string): string {
  const match = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;`,
    'i',
  ).exec(sql);
  if (!match) throw new Error(`${name} の定義が無い`);
  return match[0];
}

/** 関数の定義の頭 (本体の前。LANGUAGE / SECURITY / SET の指定がある部分) */
const functionHeader = (definition: string): string => squash(definition.slice(0, definition.indexOf('$$')));

/** CHECK (status IN (…)) の値の一覧 */
function statusCheckValues(sql: string): string[] {
  const match = /ADD\s+CONSTRAINT\s+personal_subscriptions_status_check\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sql);
  if (!match) throw new Error('personal_subscriptions_status_check の CHECK が無い');
  return match[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
}

/** CREATE POLICY <name> … ; の文 (名前の引用符は問わない) */
function policyStatement(sql: string, name: string): string {
  const match = new RegExp(`CREATE\\s+POLICY\\s+"?${name}"?\\s+ON\\s[^;]*;`, 'i').exec(sql);
  if (!match) throw new Error(`ポリシー ${name} が無い`);
  return match[0];
}

/**
 * ポリシーの式を比べられる形にする: 引用符・括弧・空白を外し、小文字にする。
 * ベースライン (pg_dump の出力) は識別子を "…" で囲み、括弧を多めに付けるので、語の並びで比べる
 */
const policyTokens = (statement: string): string => statement.replace(/["()\s;]/g, '').toLowerCase();

/** 3 本の RPC (EXECUTE は service_role だけ) と、その引数の型の並び */
const BILLING_RPCS = [
  { name: 'billing_claim_stripe_event', signature: 'text, text, jsonb, interval' },
  { name: 'billing_finish_stripe_event', signature: 'text, boolean, text' },
  { name: 'billing_apply_stripe_subscription', signature: 'jsonb, timestamptz, text' },
] as const;
const TRIGGER_FUNCTION = 'billing_family_plan_follow_representative';
const GUARD_FUNCTIONS = ['guard_user_profiles_privileged', 'guard_user_profiles_privileged_on_insert'] as const;

/** 本 migration の前からあった status の 7 値 (baseline の CHECK) */
const PREVIOUS_STATUS_VALUES = ['trialing', 'active', 'paused', 'cancelled', 'expired', 'past_due', 'grace'];

describe('billing/01 段 A: migration とロールバックのファイル', () => {
  it('本 migration はちょうど 1 本で、同じ番号のロールバックがある', () => {
    expect(ours).toHaveLength(1);
    expect(fs.existsSync(path.join(ROOT, ROLLBACK))).toBe(true);
    expect(migrationRaw).toContain(`-- migration: ${ours[0]}`);
    expect(migrationRaw).toContain(`supabase/rollbacks/${ourVersion}${STEM_SUFFIX}.down.sql`);
    expect(rollbackRaw).toContain(`-- rollback: ${ours[0]}`);
  });
});

describe('billing/01 段 A: personal_subscriptions の status と RLS', () => {
  // 44
  it('migration adds incomplete to the status CHECK and keeps the other 7 values', () => {
    const values = statusCheckValues(migration);
    expect([...values].sort()).toEqual([...PREVIOUS_STATUS_VALUES, 'incomplete'].sort());
    expect(values).toHaveLength(PREVIOUS_STATUS_VALUES.length + 1);
    // 置き換え: 古い CHECK を外してから足す
    expect(squash(migration)).toMatch(
      /ALTER TABLE public\.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_status_check;/,
    );
  });

  // 45
  it('migration drops the user_id = auth.uid() branch from INSERT/UPDATE policies and keeps SELECT/DELETE policies', () => {
    const flat = squash(migration);
    expect(flat).toContain('DROP POLICY IF EXISTS personal_subscriptions_insert ON public.personal_subscriptions;');
    expect(flat).toContain('DROP POLICY IF EXISTS personal_subscriptions_update ON public.personal_subscriptions;');
    for (const name of ['personal_subscriptions_insert_admin', 'personal_subscriptions_update_admin']) {
      const statement = squash(policyStatement(migration, name));
      expect(statement, name).not.toMatch(/user_id\s*=\s*auth\.uid\(\)/);
      expect(statement, name).toMatch(/ARRAY\['admin'::text, 'super_admin'::text\] && user_profiles\.roles/);
    }
    expect(squash(policyStatement(migration, 'personal_subscriptions_insert_admin'))).toMatch(/FOR INSERT WITH CHECK/);
    expect(squash(policyStatement(migration, 'personal_subscriptions_update_admin'))).toMatch(/FOR UPDATE USING .* WITH CHECK/);
    // SELECT (本人 + 運営) と DELETE の禁止は触らない
    for (const kept of ['personal_subscriptions_select', 'personal_subscriptions_no_delete']) {
      expect(migration, kept).not.toMatch(new RegExp(`POLICY\\s+(IF\\s+EXISTS\\s+)?"?${kept}"?\\b`, 'i'));
      // 前提: ベースラインに実在する
      expect(read(BASELINE_SCHEMA), kept).toMatch(new RegExp(`CREATE POLICY "${kept}" ON "public"."personal_subscriptions"`));
    }
    // anon の書き込みの権限を外す
    expect(flat).toContain('REVOKE INSERT, UPDATE, DELETE ON public.personal_subscriptions FROM anon;');
  });
});

describe('billing/01 段 A: DB 関数の権限', () => {
  // 46
  it('billing RPC functions are SECURITY DEFINER with search_path = "" and EXECUTE only for service_role; the trigger function billing_family_plan_follow_representative is SECURITY DEFINER with search_path = "" and revoked from PUBLIC/anon/authenticated', () => {
    const flat = squash(migration);
    for (const { name, signature } of BILLING_RPCS) {
      const header = functionHeader(functionDefinition(migration, name));
      expect(header, name).toMatch(/\bSECURITY DEFINER\b/);
      expect(header, name).toMatch(/\bSET search_path = ''/);
      expect(flat, name).toContain(`REVOKE ALL ON FUNCTION public.${name}(${signature}) FROM PUBLIC, anon, authenticated;`);
      const grants = [...flat.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\) TO ([^;]+);`, 'g'))];
      expect(grants.map((g) => [g[1], g[2].trim()]), name).toEqual([[signature, 'service_role']]);
    }
    const trigger = functionDefinition(migration, TRIGGER_FUNCTION);
    const triggerHeader = functionHeader(trigger);
    expect(triggerHeader).toMatch(/RETURNS trigger/);
    expect(triggerHeader).toMatch(/\bSECURITY DEFINER\b/);
    expect(triggerHeader).toMatch(/\bSET search_path = ''/);
    expect(flat).toContain(`REVOKE ALL ON FUNCTION public.${TRIGGER_FUNCTION}() FROM PUBLIC, anon, authenticated;`);
    expect(flat).not.toMatch(new RegExp(`GRANT [^;]* ON FUNCTION public\\.${TRIGGER_FUNCTION}\\(`));
    // トリガーは family_groups の作成と代表者の交代だけに当たる
    expect(flat).toContain(
      `CREATE TRIGGER family_groups_billing_plan_follow_representative BEFORE INSERT OR UPDATE OF representative_id ON public.family_groups FOR EACH ROW EXECUTE FUNCTION public.${TRIGGER_FUNCTION}();`,
    );
    // 特権列ガード 2 本は SECURITY DEFINER にしない (current_user で本人の書き込みを見分けるため)
    for (const guard of GUARD_FUNCTIONS) {
      expect(functionHeader(functionDefinition(migration, guard)), guard).not.toMatch(/SECURITY DEFINER/);
    }
  });
});

describe('billing/01 段 A: ロールバック', () => {
  // 47
  it('rollback restores the baseline policies and the 20261008200700 guard definitions verbatim and drops everything the migration added', () => {
    // 特権列ガード 2 本: 20261008200700 の定義そのまま (plan_key_cached を外す)
    const guardSource = stripLineComments(read(GUARD_SOURCE_MIGRATION));
    for (const guard of GUARD_FUNCTIONS) {
      expect(squash(functionDefinition(rollback, guard)), guard).toBe(squash(functionDefinition(guardSource, guard)));
      expect(functionDefinition(rollback, guard), guard).not.toContain('plan_key_cached');
      // migration 側は plan_key_cached を 1 行足しただけ
      expect(functionDefinition(migration, guard), guard).toContain('plan_key_cached');
    }

    // personal_subscriptions のポリシー 2 本: ベースラインのとおり
    const baseline = read(BASELINE_SCHEMA);
    for (const name of ['personal_subscriptions_insert', 'personal_subscriptions_update']) {
      expect(policyTokens(policyStatement(rollback, name)), name).toBe(policyTokens(policyStatement(baseline, name)));
    }
    expect(squash(rollback)).toContain('GRANT INSERT, UPDATE, DELETE ON public.personal_subscriptions TO anon;');

    // status の CHECK を 7 値に戻す (incomplete の行は expired にしてから)
    expect([...statusCheckValues(rollback)].sort()).toEqual([...PREVIOUS_STATUS_VALUES].sort());
    expect(squash(rollback)).toMatch(/UPDATE public\.personal_subscriptions SET status = 'expired' WHERE status = 'incomplete';/);

    // migration が足した列を全部消す
    const addedColumns = [...migration.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/gi)].map((m) => m[1]);
    expect(addedColumns.sort()).toEqual(
      ['attempt_count', 'billing_interval', 'cancel_at_period_end', 'processing_started_at', 'stripe_status', 'stripe_synced_at'].sort(),
    );
    for (const column of addedColumns) {
      expect(rollback, column).toMatch(new RegExp(`DROP COLUMN IF EXISTS ${column}\\b`));
    }
    // 表・関数・トリガー・ポリシー・制約
    const createdTables = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/gi)].map((m) => m[1]);
    expect(createdTables).toEqual(['billing_customers']);
    for (const table of createdTables) expect(rollback).toMatch(new RegExp(`DROP TABLE IF EXISTS public\\.${table};`));

    for (const { name, signature } of BILLING_RPCS) {
      expect(squash(rollback), name).toContain(`DROP FUNCTION IF EXISTS public.${name}(${signature});`);
    }
    expect(squash(rollback)).toContain(`DROP FUNCTION IF EXISTS public.${TRIGGER_FUNCTION}();`);

    const createdTriggers = [...squash(migration).matchAll(/CREATE TRIGGER (\w+) BEFORE [^;]*? ON public\.(\w+)/g)].map((m) => [m[1], m[2]]);
    expect(createdTriggers.map(([name]) => name).sort()).toEqual(
      ['billing_customers_set_updated_at', 'family_groups_billing_plan_follow_representative', 'personal_subscriptions_set_updated_at'].sort(),
    );
    for (const [name, table] of createdTriggers) {
      // billing_customers の行のトリガーは、表と一緒に消える
      if (table === 'billing_customers') continue;
      expect(squash(rollback), name).toContain(`DROP TRIGGER IF EXISTS ${name} ON public.${table};`);
    }

    const createdPolicies = [...migration.matchAll(/CREATE POLICY\s+(\w+)\s+ON\s+public\.(\w+)/gi)].map((m) => [m[1], m[2]]);
    expect(createdPolicies.map(([name]) => name).sort()).toEqual(
      ['billing_customers_no_access', 'personal_subscriptions_insert_admin', 'personal_subscriptions_update_admin'].sort(),
    );
    for (const [name, table] of createdPolicies) {
      if (table === 'billing_customers') continue;
      expect(squash(rollback), name).toContain(`DROP POLICY IF EXISTS ${name} ON public.${table};`);
    }

    expect(squash(rollback)).toContain(
      'ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_billing_interval_check;',
    );

    // 列コメント: plan_key_cached はベースラインの文に、payload は外す (ベースラインに無い)
    const baselineComment = /COMMENT ON COLUMN "public"\."user_profiles"\."plan_key_cached" IS '([^']*)';/.exec(baseline);
    expect(baselineComment).not.toBeNull();
    expect(rollback).toContain(`COMMENT ON COLUMN public.user_profiles.plan_key_cached IS '${baselineComment![1]}';`);
    expect(baseline).not.toMatch(/COMMENT ON COLUMN "public"\."stripe_webhook_events"\."payload"/);
    expect(squash(rollback)).toContain('COMMENT ON COLUMN public.stripe_webhook_events.payload IS NULL;');
  });
});

describe('billing/01 段 A: 既存の行と文面', () => {
  // 48
  it('migration contains no UPDATE/DELETE of existing rows outside function bodies', () => {
    const statements = statementsOutsideBodies(migration);
    // 番兵: 文の切り出しが空振りしていない (関数の定義・ALTER TABLE を拾えている)
    expect(statements.some((s) => /^CREATE OR REPLACE FUNCTION public\.billing_apply_stripe_subscription/.test(s))).toBe(true);
    expect(statements.some((s) => /^ALTER TABLE public\.personal_subscriptions ADD COLUMN/.test(s))).toBe(true);
    const writes = statements.filter((s) => /^(UPDATE|DELETE|TRUNCATE|MERGE)\b/i.test(s) || /^INSERT\s+INTO\b/i.test(s));
    expect(writes).toEqual([]);
    // 関数の本体の中には写像の UPDATE がある (本体を外さずに見ると当たる = 検査が本体を除いて見ていることの確認)
    expect(migration).toMatch(/UPDATE public\.personal_subscriptions/);
  });

  // 49
  it('migration comment does not attribute decisions (no "オーナー判断")', () => {
    const ATTRIBUTION = /オーナー(?:の)?(?:判断|選択|指示|決定)|ユーザー(?:の)?(?:判断|指示|決定)|発注者/;
    for (const [file, text] of [
      [MIGRATION, migrationRaw],
      [ROLLBACK, rollbackRaw],
    ] as const) {
      const comments = [...text.matchAll(/--([^\n]*)/g)].map((m) => m[1]).join('\n');
      expect(comments, file).not.toMatch(ATTRIBUTION);
    }
    // 方針の出どころは設計書として書く
    expect(migrationRaw).toMatch(/billing\/01/);
  });
});
