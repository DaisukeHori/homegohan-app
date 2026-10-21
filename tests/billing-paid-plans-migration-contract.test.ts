/**
 * billing/03 (有料プランの販売) 段 A: migration *_billing_paid_plans_iap.sql とロールバックの SQL の文面の契約テスト (DB は使わない)
 *
 * DB の上での振る舞い (ストアの契約の写像・RevenueCat のイベントの claim / finish・AI のプラン × 機能の上限・家族の門・
 * plan_store_products の RLS) は tests/integration/rls/billing-apply-store-subscription-rpc.test.ts・
 * billing-revenuecat-events-claim-rpc.test.ts・ai-plan-feature-caps-rpc.test.ts と tests/integration/security/family-plan-gate.test.ts・
 * plan-store-products-rls.test.ts が確かめる。ここでは、番号の付け直しや後の migration の上書きで崩れやすい所を、ファイルの文面だけで
 * 確かめる (設計: docs/design/billing/03-paid-plans-and-iap.md §6・§14.2 の 60〜65・100・106)。
 *   60. 価格の UPDATE は 3 行 (pro / family_basic / family_pro) だけで、決めた価格・無料体験・表示名を入れ、stripe_* の列に触れない
 *   61. plan_store_products (主キー (store, product_id)・offered と部分 UNIQUE)・revenuecat_webhook_events・ai_plan_feature_caps の
 *       定義と RLS と権限
 *   62. 新設の関数 5 本とトリガー関数は SECURITY DEFINER・search_path が空。EXECUTE は service_role だけ (トリガー関数は誰にも付けない)
 *   63. 手動付与の 2 関数とプロシージャの M 行の述語に iap_store IS NULL がある。billing_manual_subscription_sync_after_end は作り直さない
 *   64. ロールバックは、作り直した関数を土台の migration の定義に逐語で戻し、migration が足したものを全部消す
 *   65. 関数の本体の外の UPDATE / DELETE は、3 行の価格と ai_daily_limits の free の行だけ
 *  100. ai_plan_feature_caps の feature の CHECK は AI_PLAN_CAPPED_FEATURES と同じ 4 つで、consume_ai_usage_at は
 *       上限に数えない機能の枝 (c_unmetered) より前に ai_plan_feature_caps を見る
 *  106. free を 3 にする前に、組織の plan の値 (organizations.plan・standard・plan_type = org の行) に free の値を写し
 *       (free と有料の 3 つは除く)、ロールバックはその行のうち updated_by IS NULL のものだけを消す
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_billing_paid_plans_iap';

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** `--` から行末までのコメントを除く (この 2 ファイルは文字列の中に `--` を書いていない。下の番兵が確かめる) */
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

/** ドル引用の本体 ($$ … $$) を空にした SQL (本体の外の文だけを見るため) */
const withoutBodies = (sql: string): string => sql.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');

/** 文 (`;` 区切り) の一覧。本体は空にしてから切る */
const statementsOutsideBodies = (sql: string): string[] =>
  withoutBodies(sql)
    .split(';')
    .map((s) => squash(s))
    .filter((s) => s.length > 0);

/** 名前の書き方 (public.name / "public"."name") */
const qualified = (name: string): string => `(?:public\\.${name}|"public"\\."${name}")`;

/** `CREATE OR REPLACE <FUNCTION|PROCEDURE> public.<name>(` から本体の終わり (`$$;`) までを取り出す (コメントは残したまま) */
function definitionOf(sql: string, kind: 'FUNCTION' | 'PROCEDURE', name: string): string {
  const match = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+${kind}\\s+${qualified(name)}\\s*\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;`, 'i').exec(sql);
  if (!match) throw new Error(`${name} の定義が無い`);
  return match[0];
}

/** 定義の頭 (本体の前。LANGUAGE / SECURITY / SET の指定がある部分) */
const headerOf = (def: string): string => squash(def.slice(0, def.indexOf('$$')));
/** 定義の本体 ($$ と $$ の間) */
const bodyOf = (def: string): string => def.slice(def.indexOf('$$') + 2, def.lastIndexOf('$$'));

/** 本 migration より前で、その関数を最後に定義した migration (土台) */
function baseDefinerOf(kind: 'FUNCTION' | 'PROCEDURE', name: string): string {
  const pattern = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+${kind}\\s+${qualified(name)}\\s*\\(`, 'i');
  const definers = migrationFiles.filter((file) => file < ours[0] && pattern.test(stripLineComments(read(`${MIGRATIONS_DIR}/${file}`))));
  const last = definers[definers.length - 1];
  if (!last) throw new Error(`${name} を定義する migration が無い`);
  return last;
}

/** 新設の関数 (EXECUTE は service_role だけ) と、その引数の型の並び */
const NEW_FUNCTIONS = [
  { name: 'billing_claim_revenuecat_event', signature: 'text, text, jsonb, interval' },
  { name: 'billing_finish_revenuecat_event', signature: 'text, boolean, text' },
  { name: 'billing_apply_store_subscription', signature: 'jsonb, timestamptz, text' },
  { name: 'ai_plan_feature_daily_cap', signature: 'uuid, text' },
  { name: 'billing_has_live_family_plan', signature: 'uuid' },
] as const;
/** 新設のトリガー関数 (EXECUTE は誰にも付けない) */
const TRIGGER_FUNCTION = 'family_members_billing_plan_gate';

/** 作り直す既存の関数・プロシージャ (土台の migration の定義に差分を入れたもの。ロールバックは土台の定義に逐語で戻す) */
const REDEFINED = [
  { kind: 'FUNCTION', name: 'consume_ai_usage_at' },
  { kind: 'FUNCTION', name: 'consume_ai_usage_capped_at' },
  { kind: 'FUNCTION', name: 'create_family_group' },
  { kind: 'FUNCTION', name: 'billing_revoke_manual_subscription' },
  { kind: 'FUNCTION', name: 'billing_expire_manual_subscription_for_user' },
  { kind: 'PROCEDURE', name: 'billing_expire_manual_subscriptions' },
] as const;

/**
 * ai_plan_feature_caps に行を持てる機能 (設計 §8.8 の AI_PLAN_CAPPED_FEATURES。段 B が supabase/functions/_shared/ai-daily-limit.ts に
 * 足す名前と同じ並び。段 B の PR で、この写しをその export の import に置き換える)
 */
const AI_PLAN_CAPPED_FEATURES = ['menu_generation_ultimate', 'menu_generation', 'image_generation', 'meal_image_auto'] as const;

/** 決めた価格 (設計 §0.4・§6.2。税込の円) */
const PRICES = [
  { planKey: 'pro', monthly: 580, yearly: 5800, displayName: '個人 Pro', maxMembers: null },
  { planKey: 'family_basic', monthly: 980, yearly: 9800, displayName: '家族 Basic', maxMembers: 4 },
  { planKey: 'family_pro', monthly: 1480, yearly: 14800, displayName: '家族 Pro', maxMembers: 8 },
] as const;
/** 無料体験の日数 (設計 §0.4) */
const TRIAL_DAYS = 7;
/** ロールバックで戻す前の価格と表示名 (本番の行の旧い値。設計 §6.8 の (i)) */
const OLD_PRICES = [
  { planKey: 'pro', monthly: 980, yearly: 9800, displayName: 'Pro' },
  { planKey: 'family_basic', monthly: 1480, yearly: 14800, displayName: 'Family Basic' },
  { planKey: 'family_pro', monthly: 2480, yearly: 24800, displayName: 'Family Pro' },
] as const;
/** 1 日の上限の確定値 (設計 §0.5 の Q-2) と、ロールバックで戻す free の値 */
const FREE_DAILY_LIMIT = 3;
const OLD_FREE_DAILY_LIMIT = 10;
const PAID_DAILY_LIMITS = "('pro', 30), ('family_basic', 30), ('family_pro', 50)";

describe('billing/03 段 A: migration とロールバックのファイル', () => {
  it('exactly one migration ends with _billing_paid_plans_iap.sql, the same-numbered rollback exists, and the headers name each other', () => {
    expect(ours).toHaveLength(1);
    expect(fs.existsSync(path.join(ROOT, ROLLBACK))).toBe(true);
    expect(migrationRaw.split('\n', 1)[0]).toBe(`-- migration: ${ours[0]}`);
    expect(rollbackRaw.split('\n', 1)[0]).toBe(`-- rollback: ${ours[0]}`);
    const rollbackRefs = [...migrationRaw.matchAll(/supabase\/rollbacks\/[\w.-]+/g)].map((m) => m[0]);
    expect(new Set(rollbackRefs)).toEqual(new Set([ROLLBACK]));
    // 冒頭のコメントが名指しする migration は実在する
    const header = migrationRaw.split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const [name] of header.matchAll(/\b20\d{12}_[a-z0-9_]+\.sql\b/g)) {
      expect(migrationFiles, name).toContain(name);
    }
    // 番兵: コメントを除く処理が文字列の中の `--` を壊していない (2 ファイルの文字列に `--` が無い)
    for (const [label, sql] of [['migration', withoutBodies(migrationRaw)], ['rollback', withoutBodies(rollbackRaw)]] as const) {
      expect([...sql.matchAll(/'[^'\n]*'/g)].filter((m) => m[0].includes('--')), label).toEqual([]);
    }
  });

  it('the migration starts with SET LOCAL lock_timeout before any other statement', () => {
    expect(statementsOutsideBodies(migration)[0]).toBe("SET LOCAL lock_timeout = '10s'");
  });
});

describe('billing/03 段 A: 価格 (§6.2)', () => {
  // 60
  it('migration updates exactly the 3 plan rows with the decided prices, trial days and display names, and touches no stripe_* column', () => {
    const updates = statementsOutsideBodies(migration).filter((s) => /^UPDATE public\.subscription_plans\b/.test(s));
    expect(updates.map((s) => /WHERE plan_key = '(\w+)'$/.exec(s)?.[1])).toEqual(PRICES.map((p) => p.planKey));
    for (const [index, price] of PRICES.entries()) {
      const statement = updates[index];
      expect(statement, price.planKey).toContain(`monthly_price_jpy = ${price.monthly},`);
      expect(statement, price.planKey).toContain(`yearly_price_jpy = ${price.yearly},`);
      expect(statement, price.planKey).toContain(`trial_days = ${TRIAL_DAYS},`);
      expect(statement, price.planKey).toContain(`display_name = '${price.displayName}',`);
      if (price.maxMembers === null) expect(statement, price.planKey).not.toContain('max_members');
      else expect(statement, price.planKey).toContain(`max_members = ${price.maxMembers},`);
      expect(statement, price.planKey).not.toMatch(/stripe_/);
    }
    // stripe_* の列はどこでも書かない (Price の登録は販売開始の合図。§17)
    expect(statementsOutsideBodies(migration).filter((s) => /^UPDATE\b/.test(s) && /stripe_/.test(s))).toEqual([]);
  });
});

describe('billing/03 段 A: 新設の表と RLS と権限 (§6.3・§6.5)', () => {
  // 61
  it('migration creates plan_store_products (primary key (store, product_id), offered with the partial unique index idx_plan_store_products_offered) / revenuecat_webhook_events / ai_plan_feature_caps with RLS and the documented grants', () => {
    const flat = squash(migration);
    // plan_store_products
    expect(flat).toContain('CREATE TABLE IF NOT EXISTS public.plan_store_products (');
    expect(flat).toContain('CONSTRAINT plan_store_products_pkey PRIMARY KEY (store, product_id)');
    expect(flat).toContain("CONSTRAINT plan_store_products_store_check CHECK (store IN ('app_store', 'play_store'))");
    expect(flat).toContain("CONSTRAINT plan_store_products_interval_check CHECK (billing_interval IN ('month', 'year'))");
    expect(flat).toContain("CONSTRAINT plan_store_products_product_id_not_blank CHECK (btrim(product_id) <> '')");
    expect(flat).toContain('offered boolean NOT NULL DEFAULT true');
    expect(flat).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_store_products_offered ON public.plan_store_products (plan_key, store, billing_interval) WHERE offered;');
    expect(flat).toContain('ALTER TABLE public.plan_store_products ENABLE ROW LEVEL SECURITY;');
    expect(flat).toContain('CREATE POLICY plan_store_products_select_public ON public.plan_store_products FOR SELECT USING');
    // 書くのは super_admin だけ。運営ロールの条件の項に operator_mfa_satisfied() を AND で付け、TO authenticated (cross/12 §11.4)
    const mutate = /CREATE POLICY plan_store_products_mutate_super_admin ON public\.plan_store_products TO authenticated USING \((.*?)\) WITH CHECK \((.*?)\);/.exec(flat);
    expect(mutate).not.toBeNull();
    for (const clause of [mutate![1], mutate![2]]) {
      expect(clause).toContain("'super_admin' = ANY (user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())");
    }
    expect(flat).toContain('REVOKE ALL ON public.plan_store_products FROM PUBLIC, anon, authenticated, service_role;');
    expect(flat).toContain('GRANT SELECT ON public.plan_store_products TO anon, authenticated;');
    expect(flat).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_store_products TO service_role;');
    expect(flat).toContain('GRANT INSERT, UPDATE, DELETE ON public.plan_store_products TO authenticated;');
    // revenuecat_webhook_events: service_role だけ (RLS のポリシーは誰も通さない)
    expect(flat).toContain('CREATE TABLE IF NOT EXISTS public.revenuecat_webhook_events (');
    expect(flat).toContain("CONSTRAINT revenuecat_webhook_events_status_check CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed'))");
    expect(flat).toContain('ALTER TABLE public.revenuecat_webhook_events ENABLE ROW LEVEL SECURITY;');
    expect(flat).toContain('CREATE POLICY revenuecat_webhook_events_no_access ON public.revenuecat_webhook_events USING (false) WITH CHECK (false);');
    expect(flat).toContain('REVOKE ALL ON public.revenuecat_webhook_events FROM PUBLIC, anon, authenticated;');
    expect(flat).toContain('GRANT SELECT, INSERT, UPDATE ON public.revenuecat_webhook_events TO service_role;');
    // ai_plan_feature_caps: service_role だけ (ポリシーなし)
    expect(flat).toContain('CREATE TABLE IF NOT EXISTS public.ai_plan_feature_caps (');
    expect(flat).toContain('CONSTRAINT ai_plan_feature_caps_pkey PRIMARY KEY (plan_key, feature)');
    expect(flat).toContain('CONSTRAINT ai_plan_feature_caps_daily_cap_nonneg CHECK (daily_cap IS NULL OR daily_cap >= 0)');
    expect(flat).toContain('updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL');
    expect(flat).toContain('ALTER TABLE public.ai_plan_feature_caps ENABLE ROW LEVEL SECURITY;');
    expect(flat).toContain('REVOKE ALL ON public.ai_plan_feature_caps FROM PUBLIC, anon, authenticated, service_role;');
    expect(flat).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_plan_feature_caps TO service_role;');
    expect(flat).not.toMatch(/CREATE POLICY \w+ ON public\.ai_plan_feature_caps/);
    // ストアの列と制約 (§6.4)
    for (const column of ['iap_store varchar(20)', 'iap_product_id varchar(255)', 'iap_synced_at timestamptz', 'iap_is_sandbox boolean NOT NULL DEFAULT false']) {
      expect(flat).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(flat).toContain(
      'CHECK ((iap_store IS NULL AND iap_product_id IS NULL) OR (iap_store IS NOT NULL AND iap_product_id IS NOT NULL AND stripe_subscription_id IS NULL))',
    );
    expect(flat).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_subscriptions_iap_product ON public.personal_subscriptions (user_id, iap_store, iap_product_id) WHERE iap_store IS NOT NULL;');
  });
});

describe('billing/03 段 A: DB 関数の権限 (§6.3〜§6.6)', () => {
  // 62
  it('billing_apply_store_subscription, claim / finish, billing_has_live_family_plan, ai_plan_feature_daily_cap and the family gate trigger are SECURITY DEFINER with empty search_path and EXECUTE only for service_role', () => {
    const flat = squash(migration);
    for (const { name, signature } of NEW_FUNCTIONS) {
      const header = headerOf(definitionOf(migration, 'FUNCTION', name));
      expect(header, name).toMatch(/\bSECURITY DEFINER\b/);
      expect(header, name).toMatch(/\bSET search_path = ''/);
      expect(flat, name).toContain(`REVOKE ALL ON FUNCTION public.${name}(${signature}) FROM PUBLIC, anon, authenticated;`);
      const grants = [...flat.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\) TO ([^;]+);`, 'g'))];
      expect(grants.map((g) => [g[1], g[2].trim()]), name).toEqual([[signature, 'service_role']]);
    }
    // トリガー関数: 誰にも EXECUTE を付けない (BEFORE INSERT のトリガーだけが呼ぶ)
    const trigger = headerOf(definitionOf(migration, 'FUNCTION', TRIGGER_FUNCTION));
    expect(trigger).toMatch(/RETURNS trigger/);
    expect(trigger).toMatch(/\bSECURITY DEFINER\b/);
    expect(trigger).toMatch(/\bSET search_path = ''/);
    expect(flat).toContain(`REVOKE ALL ON FUNCTION public.${TRIGGER_FUNCTION}() FROM PUBLIC, anon, authenticated;`);
    expect(flat).not.toMatch(new RegExp(`GRANT [^;]* ON FUNCTION public\\.${TRIGGER_FUNCTION}\\(`));
    // メンバーの追加の門は BEFORE INSERT だけ (子供の昇格 = UPDATE には付けない。§6.6・Q-4)
    expect(flat).toContain(
      `CREATE TRIGGER ${TRIGGER_FUNCTION} BEFORE INSERT ON public.family_members FOR EACH ROW EXECUTE FUNCTION public.${TRIGGER_FUNCTION}();`,
    );
    // 本 migration の GRANT EXECUTE の先は service_role だけ (作り直した関数の ACL は CREATE OR REPLACE が残す)
    const executeGrantees = [...flat.matchAll(/GRANT EXECUTE ON (?:FUNCTION|PROCEDURE) [^;]*? TO ([^;]+);/g)].map((m) => m[1].trim());
    expect(new Set(executeGrantees)).toEqual(new Set(['service_role']));
  });

  it('create_family_group adds the FAMILY_PLAN_REQUIRED gate right after the ALREADY_IN_FAMILY check and is otherwise the base definition verbatim', () => {
    const base = definitionOf(read(`${MIGRATIONS_DIR}/${baseDefinerOf('FUNCTION', 'create_family_group')}`), 'FUNCTION', 'create_family_group');
    const ours = definitionOf(migrationRaw, 'FUNCTION', 'create_family_group');
    const gate = squash(stripLineComments(ours)).match(
      /RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001'; END IF; (IF NOT public\.billing_has_live_family_plan\(auth\.uid\(\)\) THEN RAISE EXCEPTION 'FAMILY_PLAN_REQUIRED' USING ERRCODE = 'P0001'; END IF;)/,
    );
    expect(gate).not.toBeNull();
    expect(squash(stripLineComments(ours)).replace(` ${gate![1]}`, '')).toBe(squash(stripLineComments(base)));
  });
});

describe('billing/03 段 A: 手動付与の述語 (§6.7)', () => {
  // 63
  it('billing_revoke_manual_subscription, billing_expire_manual_subscription_for_user and the PROCEDURE billing_expire_manual_subscriptions select M rows with stripe_subscription_id IS NULL AND iap_store IS NULL, and billing_manual_subscription_sync_after_end is not redefined', () => {
    for (const { kind, name } of [
      { kind: 'FUNCTION', name: 'billing_revoke_manual_subscription' },
      { kind: 'FUNCTION', name: 'billing_expire_manual_subscription_for_user' },
      { kind: 'PROCEDURE', name: 'billing_expire_manual_subscriptions' },
    ] as const) {
      const ours = definitionOf(migrationRaw, kind, name);
      const body = squash(stripLineComments(bodyOf(ours)));
      expect(body, name).toMatch(/\bs\.stripe_subscription_id IS NULL AND s\.iap_store IS NULL\b/);
      // 述語を足したほかは土台 (20261017230000) の逐語
      const base = definitionOf(read(`${MIGRATIONS_DIR}/${baseDefinerOf(kind, name)}`), kind, name);
      expect(squash(ours).replace(' AND s.iap_store IS NULL', ''), name).toBe(squash(base));
    }
    expect(migration).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.billing_manual_subscription_sync_after_end/);
    expect(migration).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.billing_grant_manual_subscription/);
    // PROCEDURE の権限は土台と同じ (誰にも EXECUTE を付けない)
    expect(squash(migration)).toContain('REVOKE ALL ON PROCEDURE public.billing_expire_manual_subscriptions() FROM PUBLIC, anon, authenticated, service_role;');
  });
});

describe('billing/03 段 A: ロールバック (§6.8)', () => {
  // 64
  it('rollback restores create_family_group, the 2 manual-grant functions, the PROCEDURE billing_expire_manual_subscriptions and the AI functions verbatim from their source migrations and drops everything the migration added (including ai_plan_feature_daily_cap)', () => {
    for (const { kind, name } of REDEFINED) {
      const base = definitionOf(read(`${MIGRATIONS_DIR}/${baseDefinerOf(kind, name)}`), kind, name);
      expect(definitionOf(rollbackRaw, kind, name), name).toBe(base);
    }
    const flat = squash(rollback);
    const drops = [
      'DROP TRIGGER IF EXISTS family_members_billing_plan_gate ON public.family_members;',
      'DROP FUNCTION IF EXISTS public.family_members_billing_plan_gate();',
      'DROP FUNCTION IF EXISTS public.billing_has_live_family_plan(uuid);',
      'DROP FUNCTION IF EXISTS public.ai_plan_feature_daily_cap(uuid, text);',
      'DROP TABLE IF EXISTS public.ai_plan_feature_caps;',
      'DROP FUNCTION IF EXISTS public.billing_apply_store_subscription(jsonb, timestamptz, text);',
      'DROP FUNCTION IF EXISTS public.billing_claim_revenuecat_event(text, text, jsonb, interval);',
      'DROP FUNCTION IF EXISTS public.billing_finish_revenuecat_event(text, boolean, text);',
      'DROP INDEX IF EXISTS public.idx_personal_subscriptions_iap_product;',
      'ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_iap_pair_check;',
      'ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_iap_store_check;',
      'DROP COLUMN IF EXISTS iap_store',
      'DROP COLUMN IF EXISTS iap_product_id',
      'DROP COLUMN IF EXISTS iap_synced_at',
      'DROP COLUMN IF EXISTS iap_is_sandbox',
      'DROP TABLE IF EXISTS public.revenuecat_webhook_events;',
      'DROP TABLE IF EXISTS public.plan_store_products;',
    ];
    for (const drop of drops) expect(flat, drop).toContain(drop);
    // トリガー → トリガー関数、create_family_group を戻してから billing_has_live_family_plan、AI の関数を戻してから ai_plan_feature_caps
    expect(flat.indexOf(drops[0])).toBeLessThan(flat.indexOf(drops[1]));
    expect(flat.search(/CREATE OR REPLACE FUNCTION "public"\."create_family_group"/)).toBeLessThan(flat.indexOf(drops[2]));
    expect(flat.search(/CREATE OR REPLACE FUNCTION public\.consume_ai_usage_at\(/)).toBeLessThan(flat.indexOf(drops[4]));
    expect(flat.indexOf(drops[3])).toBeLessThan(flat.indexOf(drops[4]));
    // 1 日の上限の行と価格を戻す
    expect(flat).toContain(`UPDATE public.ai_daily_limits SET daily_limit = ${OLD_FREE_DAILY_LIMIT}, updated_at = now() WHERE plan_key = 'free';`);
    expect(flat).toContain("DELETE FROM public.ai_daily_limits WHERE plan_key IN ('pro', 'family_basic', 'family_pro');");
    for (const price of OLD_PRICES) {
      expect(flat, price.planKey).toMatch(
        new RegExp(
          `UPDATE public\\.subscription_plans SET monthly_price_jpy = ${price.monthly}, yearly_price_jpy = ${price.yearly}, display_name = '${price.displayName}', updated_at = now\\(\\) WHERE plan_key = '${price.planKey}';`,
        ),
      );
    }
    // ロールバックが消す・戻す行は、migration が足した・変えた行だけ (利用者の行に触れない)
    const writes = statementsOutsideBodies(rollback).filter((s) => /^(UPDATE|DELETE|TRUNCATE|INSERT)\b/i.test(s));
    expect(writes.map((s) => /^(?:UPDATE|DELETE FROM) public\.(\w+)/.exec(s)?.[1])).toEqual([
      'ai_daily_limits',
      'ai_daily_limits',
      'ai_daily_limits',
      'subscription_plans',
      'subscription_plans',
      'subscription_plans',
    ]);
  });
});

describe('billing/03 段 A: 本体の外の書き込み (§6.1)', () => {
  // 65
  it('no UPDATE / DELETE outside function bodies except the 3 plan rows and the free ai_daily_limits row', () => {
    const statements = statementsOutsideBodies(migration);
    // 番兵: 文の切り出しが空振りしていない
    expect(statements.some((s) => /^CREATE OR REPLACE FUNCTION public\.billing_apply_store_subscription/.test(s))).toBe(true);
    const writes = statements.filter((s) => /^(UPDATE|DELETE|TRUNCATE|MERGE)\b/i.test(s));
    expect(writes).toEqual([
      ...PRICES.map((p) => expect.stringMatching(new RegExp(`^UPDATE public\\.subscription_plans SET .* WHERE plan_key = '${p.planKey}'$`))),
      `UPDATE public.ai_daily_limits SET daily_limit = ${FREE_DAILY_LIMIT}, updated_at = now() WHERE plan_key = 'free'`,
    ]);
    // INSERT は ai_daily_limits と ai_plan_feature_caps の既定の行だけ (どれも ON CONFLICT で、運営が変えた値を上書きしない)
    const inserts = statements.filter((s) => /^INSERT\b/i.test(s));
    expect(inserts.map((s) => /^INSERT INTO public\.(\w+)/.exec(s)?.[1])).toEqual(['ai_daily_limits', 'ai_daily_limits', 'ai_plan_feature_caps']);
    for (const insert of inserts) expect(insert).toMatch(/ON CONFLICT \([\w, ]+\) DO NOTHING$/);
    expect(squash(migration)).toContain(`INSERT INTO public.ai_daily_limits (plan_key, daily_limit) VALUES ${PAID_DAILY_LIMITS} ON CONFLICT (plan_key) DO NOTHING;`);
  });

  it('migration comment does not attribute decisions', () => {
    const ATTRIBUTION = /オーナー(?:の)?(?:判断|選択|指示|決定)|ユーザー(?:の)?(?:判断|指示|決定)|発注者/;
    for (const [file, raw] of [
      [MIGRATION, migrationRaw],
      [ROLLBACK, rollbackRaw],
    ] as const) {
      const comments = raw.split('\n').filter((line) => line.trimStart().startsWith('--')).join('\n');
      expect(comments, file).not.toMatch(ATTRIBUTION);
    }
  });
});

describe('billing/03 段 A: AI の線引き (§6.5)', () => {
  // 100
  it('the ai_plan_feature_caps feature CHECK lists exactly AI_PLAN_CAPPED_FEATURES and consume_ai_usage_at checks ai_plan_feature_caps before the c_unmetered branch', () => {
    const check = /CONSTRAINT ai_plan_feature_caps_feature_check CHECK \(feature IN \(([^)]*)\)\)/.exec(squash(migration));
    expect(check).not.toBeNull();
    expect(check![1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''))).toEqual([...AI_PLAN_CAPPED_FEATURES]);
    // 既定の行の機能は、どれも CHECK の 4 つの中
    const seeded = /INSERT INTO public\.ai_plan_feature_caps \(plan_key, feature, daily_cap\) VALUES (.*?) ON CONFLICT/.exec(squash(migration));
    expect(seeded).not.toBeNull();
    const rows = [...seeded![1].matchAll(/\('(\w+)', '(\w+)', (\d+)\)/g)].map((m) => [m[1], m[2], Number(m[3])] as const);
    expect(rows).toEqual([
      ['free', 'menu_generation_ultimate', 0],
      ['free', 'image_generation', 0],
      ['free', 'meal_image_auto', 0],
      ['free', 'menu_generation', 3],
      ['pro', 'menu_generation_ultimate', 2],
      ['pro', 'menu_generation', 10],
      ['family_basic', 'menu_generation_ultimate', 2],
      ['family_basic', 'menu_generation', 10],
      ['family_pro', 'menu_generation_ultimate', 3],
      ['family_pro', 'menu_generation', 15],
    ]);
    for (const [, feature] of rows) expect(AI_PLAN_CAPPED_FEATURES as readonly string[]).toContain(feature);

    // consume_ai_usage_at: ロック → プラン × 機能の行 → 上限に数えない機能の枝 → 1 日の上限。プランは 1 回だけ読む
    const body = stripLineComments(bodyOf(definitionOf(migrationRaw, 'FUNCTION', 'consume_ai_usage_at')));
    const lockAt = body.search(/pg_advisory_xact_lock\(/);
    const planAt = body.search(/v_plan := public\.get_effective_plan\(p_user_id\);/);
    const capsAt = body.search(/FROM public\.ai_plan_feature_caps AS c WHERE c\.plan_key = v_plan AND c\.feature = p_feature/);
    const unmeteredAt = body.search(/IF p_feature = ANY \(c_unmetered\) THEN/);
    const dailyAt = body.search(/FROM public\.ai_daily_limits AS l WHERE l\.plan_key = v_plan/);
    expect(lockAt).toBeGreaterThan(-1);
    expect(planAt).toBeGreaterThan(lockAt);
    expect(capsAt).toBeGreaterThan(planAt);
    expect(unmeteredAt).toBeGreaterThan(capsAt);
    expect(dailyAt).toBeGreaterThan(unmeteredAt);
    expect(body.match(/public\.get_effective_plan\(/g)).toHaveLength(1);
    // 止めたときは metered: true・capped_feature・plan_locked (0 = そのプランでは使えない)
    expect(squash(body)).toContain(
      "'allowed', false, 'metered', true, 'plan', v_plan, 'limit', v_feature_cap, 'used', v_feature_used, 'usage_date', v_date, 'capped_feature', p_feature, 'plan_locked', (v_feature_cap = 0)",
    );
    // 差分を入れたほかは土台 (consume_ai_usage_at の最後の定義) の逐語: 足した行を除けば土台と同じ
    const base = definitionOf(read(`${MIGRATIONS_DIR}/${baseDefinerOf('FUNCTION', 'consume_ai_usage_at')}`), 'FUNCTION', 'consume_ai_usage_at');
    const baseFlat = squash(stripLineComments(base));
    const oursFlat = squash(stripLineComments(definitionOf(migrationRaw, 'FUNCTION', 'consume_ai_usage_at')));
    const added = /v_plan := public\.get_effective_plan\(p_user_id\); SELECT c\.daily_cap INTO v_feature_cap .*? END IF; END IF; /.exec(oursFlat);
    expect(added).not.toBeNull();
    expect(
      oursFlat.replace(' v_feature_cap INTEGER; v_feature_used INTEGER;', '').replace(added![0], ''),
    ).toBe(baseFlat.replace('v_plan := public.get_effective_plan(p_user_id); ', ''));
  });

  // 106
  it('migration copies the free daily_limit to the organization plan keys (organizations.plan, standard, plan_type org) excluding free and the 3 paid keys before it updates free, and the rollback deletes only those rows with updated_by IS NULL', () => {
    const flat = squash(migration);
    const copyAt = flat.indexOf('INSERT INTO public.ai_daily_limits (plan_key, daily_limit) SELECT k.plan_key, f.daily_limit');
    const freeAt = flat.indexOf(`UPDATE public.ai_daily_limits SET daily_limit = ${FREE_DAILY_LIMIT}, updated_at = now() WHERE plan_key = 'free';`);
    expect(copyAt).toBeGreaterThan(-1);
    expect(freeAt).toBeGreaterThan(copyAt);
    const copy = flat.slice(copyAt, flat.indexOf(';', copyAt) + 1);
    const sources = [
      "SELECT o.plan AS plan_key FROM public.organizations AS o WHERE o.plan IS NOT NULL AND btrim(o.plan) <> ''",
      "SELECT 'standard' AS plan_key",
      "SELECT p.plan_key FROM public.subscription_plans AS p WHERE p.plan_type = 'org'",
    ];
    for (const source of sources) expect(copy, source).toContain(source);
    expect(copy).toContain("CROSS JOIN (SELECT l.daily_limit FROM public.ai_daily_limits AS l WHERE l.plan_key = 'free') AS f");
    expect(copy).toContain("WHERE k.plan_key NOT IN ('free', 'pro', 'family_basic', 'family_pro') ON CONFLICT (plan_key) DO NOTHING;");

    // ロールバック: 同じ選び方の行のうち updated_by IS NULL のものだけを消す
    const rb = squash(rollback);
    const deleteAt = rb.indexOf('DELETE FROM public.ai_daily_limits AS l WHERE l.updated_by IS NULL');
    expect(deleteAt).toBeGreaterThan(-1);
    const deletion = rb.slice(deleteAt, rb.indexOf(';', deleteAt) + 1);
    expect(deletion).toContain("AND l.plan_key NOT IN ('free', 'pro', 'family_basic', 'family_pro')");
    for (const source of sources) expect(deletion, source).toContain(source);
  });
});
