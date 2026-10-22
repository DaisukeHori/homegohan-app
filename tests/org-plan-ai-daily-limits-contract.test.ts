/**
 * #1912 段 A の整合ゲートの指摘: アプリが organizations.plan に書ける値のすべてに、AI の 1 日の上限の行 (組織の上限) があること
 * (DB を使わない静的な検査。DB の上の行と判定は tests/integration/rls/ai-plan-feature-caps-rpc.test.ts が確かめる)
 *
 * 背景: billing/03 §6.5 (5a) は「組織の利用者の 1 日の上限は変えない」と定め、20261021100000_billing_paid_plans_iap.sql の (5a) は
 * free を 3 にする前に、組織の plan の値に free の値 (10) を写した。写す先は organizations.plan の既存の値・列の既定 'standard'・
 * plan_type = 'org' の行だけで、アプリが書ける 'premium'・'enterprise' が漏れていた (行の無いプランは free の行 = 3 で判定される)。
 * 20261021110000_org_plan_ai_daily_limits.sql がその 2 つの行を足した。
 *
 * organizations.plan を書く経路は (この migration の時点で) 3 つ: a. 運営の組織の作成 (service_role)・b. 組織の設定 (owner / admin の JWT)・
 * c. owner / admin の JWT で PostgREST から直接 UPDATE (RLS organizations_update_admin。アプリの Zod を通らない)。
 * a・b はアプリの Zod が ORG_PLAN_VALUES に限り、b・c は同じ migration のトリガー guard_organizations_plan_value が
 * ORG_PLAN_VALUES に限った (c で有料の plan_key や行の無い値を書けないようにする)。
 * そのあと #1912 (組織のプランの段階は運営だけが変える) で、b は plan を受け取らなくなり (400)、トリガー関数は
 * 20261022170000_org_plan_operator_only.sql が「ログインした利用者と anon はどの値へも変えられない」形に作り直した。
 * 運営の書き手に PATCH /api/admin/organizations/{id} (service_role) が加わった。
 *
 * ここで確かめること:
 *   1. アプリの書き手 (運営の組織の作成・運営のプランの変更・運営の画面の選択肢) が、どれも src/lib/org-plans.ts の
 *      ORG_PLAN_VALUES を使い、別の一覧を持たない。組織の設定は plan を書かない。9 種の OrgPlanKeySchema (書き手が使っていない) を書き手に使わせない
 *   2. ORG_PLAN_DEFAULT は organizations.plan の列の既定と同じ
 *   3. ORG_PLAN_VALUES のすべての値に、migration が ai_daily_limits の行を作り、その値は組織の上限 (10) である
 *      (値の一覧はコードの定義 ORG_PLAN_VALUES から読む。値を足したら、同じ PR で行を足す migration も要る)
 *   4. 関数の本体の外で ai_daily_limits を UPDATE / DELETE する migration は free の行だけを触る (組織の行を後から変えない)
 *   5. 戻し口は、トリガーとトリガー関数を消し、足した行のうち運営が画面で変えていない (updated_by IS NULL) ものだけを消す
 *   6. 本 migration のトリガー関数が authenticated / anon に許した plan の値は ORG_PLAN_VALUES と同じ集合で、NULL を拒み、
 *      organizations の BEFORE UPDATE OF plan に付く。最後の定義は 20261022170000 (どの値へも変えられない)。
 *      ほかの migration はそのトリガー・関数を消さない
 *      (DB の上の挙動は tests/integration/rls/ai-plan-feature-caps-rpc.test.ts が owner / admin の JWT で確かめる)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_PLAN_DEFAULT, ORG_PLAN_VALUES } from '@/lib/org-plans';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const BASELINE_SCHEMA = 'supabase/baseline/prod_schema.sql';
/** ai_daily_limits を作り、free の既定の行を入れた migration */
const DAILY_LIMITS_ORIGIN = `${MIGRATIONS_DIR}/20261011020000_ai_daily_limits.sql`;
/** free を 3 にする前に、組織の plan の値に free の値を写した migration ((5a)) */
const PAID_PLANS_MIGRATION = `${MIGRATIONS_DIR}/20261021100000_billing_paid_plans_iap.sql`;
/** 漏れた組織の plan の値に行を足した migration と戻し口 */
const OURS = '20261021110000_org_plan_ai_daily_limits';
const OUR_MIGRATION = `${MIGRATIONS_DIR}/${OURS}.sql`;
const OUR_ROLLBACK = `${ROLLBACKS_DIR}/${OURS}.down.sql`;

/** owner / admin の JWT による organizations.plan の直接の UPDATE を ORG_PLAN_VALUES に限るトリガー関数とトリガー (本 migration) */
const PLAN_GUARD_FUNCTION = 'guard_organizations_plan_value';
const PLAN_GUARD_TRIGGER = 'trg_guard_organizations_plan_value';
/** トリガー関数を「ログインした利用者と anon はどの値へも変えられない」形に作り直した migration (#1912) */
const OPERATOR_ONLY_MIGRATION = '20261022170000_org_plan_operator_only.sql';

/** 組織の利用者の 1 日の上限 (20261011020000 の free の既定の値。(5a) が組織の plan の値に写した値。設計 §6.5 (5a) で変えない) */
const ORG_DAILY_LIMIT = 10;

/** organizations.plan の書き手 (アプリのコード)。ORG_PLAN_VALUES を使うこと */
const WRITER_FILES = {
  adminRoute: 'src/app/api/admin/organizations/route.ts',
  /** 運営の組織のプランの変更 (#1912: 組織のプランの段階は運営だけが変える) */
  adminPlanChange: 'src/app/api/admin/organizations/[id]/route.ts',
  adminManager: 'src/app/admin/organizations/OrganizationsManager.tsx',
  orgSettings: 'src/lib/org-settings-api.ts',
} as const;
const ORG_PLANS_MODULE = 'src/lib/org-plans.ts';
/** 書き手が使っていない 9 種の plan_key の定義 (書き手に使わせない) */
const UNUSED_ORG_PLAN_SCHEMA_FILE = 'src/schemas/membership/organization.ts';

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** `--` から行末までのコメントを除く (ここで読む SQL の文の部分は文字列の中に `--` を書いていない) */
const stripSqlLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
/** 空白を 1 つに詰める */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** ドル引用の本体 ($$ … $$) を空にする (関数の本体の外の文だけを見るため) */
const withoutBodies = (sql: string): string => sql.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');
/** TS / TSX の `//` と `/* … *\/` のコメントを除く (ここで読むファイルは文字列の中に `//` を書いていない。URL は無い) */
const stripTsComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const MIGRATION_FILE = /^\d{14}_.+\.sql$/;
const migrationFiles = fs
  .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
  .filter((name) => MIGRATION_FILE.test(name))
  .sort();

/** migration の文 (関数の本体の外・コメントを除く・空白を詰める) */
const statementsOf = (relative: string): string[] =>
  withoutBodies(stripSqlLineComments(read(relative)))
    .split(';')
    .map(squash)
    .filter((statement) => statement.length > 0);

/** src の下の .ts / .tsx (node_modules は無い) */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(relative));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(relative);
  }
  return out;
}

/** `INSERT INTO public.ai_daily_limits (plan_key, daily_limit) VALUES ('k', n), …` の行 (plan_key → daily_limit) */
function valuesRowsOf(statement: string): Map<string, number> {
  const rows = new Map<string, number>();
  const head = 'INSERT INTO public.ai_daily_limits (plan_key, daily_limit) VALUES ';
  if (!statement.startsWith(head)) return rows;
  for (const match of statement.slice(head.length).matchAll(/\('([a-z0-9_]+)', (\d+)\)/g)) {
    rows.set(match[1], Number(match[2]));
  }
  return rows;
}

describe('#1912 段 A の整合ゲートの指摘: organizations.plan に書ける値と AI の 1 日の上限の行', () => {
  it('ORG_PLAN_VALUES is the list the app writes to organizations.plan: standard, premium and enterprise', () => {
    // 値を変えるときは、ai_daily_limits の行を足す migration と、このテストの期待を同じ PR で直す
    expect([...ORG_PLAN_VALUES]).toEqual(['standard', 'premium', 'enterprise']);
    expect(new Set(ORG_PLAN_VALUES).size).toBe(ORG_PLAN_VALUES.length);
  });

  it('every app writer of organizations.plan (admin create, admin plan change, admin screen) uses ORG_PLAN_VALUES, the org settings path does not write it, and no other file under src spells an organization plan list', () => {
    const route = squash(stripTsComments(read(WRITER_FILES.adminRoute)));
    expect(route).toContain("import { ORG_PLAN_DEFAULT, ORG_PLAN_VALUES } from '@/lib/org-plans';");
    // 一覧の検索 (OrgSearchSchema) と作成 (OrgCreateSchema) の 2 つ
    expect(route.match(/plan: z\.enum\(ORG_PLAN_VALUES\)/g)).toHaveLength(2);
    expect(route).toContain('plan: z.enum(ORG_PLAN_VALUES).optional().default(ORG_PLAN_DEFAULT),');
    expect(route).toContain('.insert({ name, plan, owner_id: effectiveOwnerId })');

    const manager = squash(stripTsComments(read(WRITER_FILES.adminManager)));
    expect(manager).toContain('const PLANS = ORG_PLAN_VALUES;');

    // 運営の組織のプランの変更 (PATCH /api/admin/organizations/{id}。service_role)
    const planChange = squash(stripTsComments(read(WRITER_FILES.adminPlanChange)));
    expect(planChange).toContain("import { ORG_PLAN_VALUES } from '@/lib/org-plans';");
    expect(planChange).toContain('plan: z.enum(ORG_PLAN_VALUES),');
    expect(planChange).toContain('.update({ plan, updated_at: new Date().toISOString() })');

    // 組織の設定 (PUT /api/org/settings) は plan を書かない (#1912: 本文に plan があれば z.never で 400。行にも入れない)
    const settings = squash(stripTsComments(read(WRITER_FILES.orgSettings)));
    expect(settings).not.toMatch(/plan: z\.enum/);
    expect(settings).toContain('plan: z.never({ message: ORG_SETTINGS_PLAN_OPERATOR_ONLY_MESSAGE }).optional(),');
    expect(settings).not.toMatch(/row\.plan\b/);

    // 組織のプランの値の文字列 ('premium' / 'enterprise') を書くのは ORG_PLAN_VALUES の定義と、使われていない 9 種の定義だけ
    // (別の一覧が増えると、その値に ai_daily_limits の行があるかをここで見られなくなる)
    const spelling = /['"](premium|enterprise)['"]/;
    const offenders = sourceFiles('src')
      .filter((file) => file !== ORG_PLANS_MODULE && file !== UNUSED_ORG_PLAN_SCHEMA_FILE)
      .filter((file) => spelling.test(stripTsComments(read(file))));
    expect(offenders).toEqual([]);
  });

  it('the 9 key OrgPlanKeySchema (and CreateOrganizationBodySchema) is not used by any file under src, so it cannot write a value without a row', () => {
    const users = sourceFiles('src')
      .filter((file) => file !== UNUSED_ORG_PLAN_SCHEMA_FILE)
      .filter((file) => /\b(OrgPlanKeySchema|CreateOrganizationBodySchema|OrgPlanKey)\b/.test(stripTsComments(read(file))));
    expect(users).toEqual([]);
  });

  it('ORG_PLAN_DEFAULT equals the column default of organizations.plan and no migration changes that default', () => {
    const baseline = read(BASELINE_SCHEMA);
    const tableAt = baseline.indexOf('CREATE TABLE IF NOT EXISTS "public"."organizations" (');
    expect(tableAt).toBeGreaterThan(-1);
    const table = baseline.slice(tableAt, baseline.indexOf(');', tableAt));
    expect(table).toContain(`"plan" "text" DEFAULT '${ORG_PLAN_DEFAULT}'::"text"`);
    for (const file of migrationFiles) {
      const changesDefault = statementsOf(`${MIGRATIONS_DIR}/${file}`).some(
        (statement) => /ALTER TABLE (ONLY )?"?public"?\."?organizations"?/i.test(statement) && /ALTER COLUMN "?plan"? (SET|DROP) DEFAULT/i.test(statement),
      );
      expect(changesDefault, file).toBe(false);
    }
  });

  it('every value in ORG_PLAN_VALUES gets an ai_daily_limits row from the migrations, and its value is the organization limit', () => {
    // free の既定の値 (= (5a) が組織の plan の値に写した値) が組織の上限
    const origin = statementsOf(DAILY_LIMITS_ORIGIN);
    const originRows = origin.map(valuesRowsOf).find((rows) => rows.has('free'));
    expect(originRows?.get('free')).toBe(ORG_DAILY_LIMIT);

    // (5a): 列の既定 'standard' に free の値を写す (free を書き換える前。順序は tests/billing-paid-plans-migration-contract.test.ts の 106)
    const copy = statementsOf(PAID_PLANS_MIGRATION).find((statement) =>
      statement.startsWith('INSERT INTO public.ai_daily_limits (plan_key, daily_limit) SELECT k.plan_key, f.daily_limit'),
    );
    expect(copy).toBeDefined();
    expect(copy).toContain(`SELECT '${ORG_PLAN_DEFAULT}' AS plan_key`);
    expect(copy).toContain("CROSS JOIN (SELECT l.daily_limit FROM public.ai_daily_limits AS l WHERE l.plan_key = 'free') AS f");

    // 値を書いた行 (VALUES)。同じ plan_key を 2 つの migration が書いていない (ON CONFLICT DO NOTHING で後が負けるので値が読めなくなる)
    const literalRows = new Map<string, { value: number; file: string }>();
    for (const file of migrationFiles) {
      for (const statement of statementsOf(`${MIGRATIONS_DIR}/${file}`)) {
        for (const [planKey, value] of valuesRowsOf(statement)) {
          expect(literalRows.has(planKey), `${planKey} を ${literalRows.get(planKey)?.file} と ${file} が書いている`).toBe(false);
          literalRows.set(planKey, { value, file });
        }
      }
    }

    const missing: string[] = [];
    for (const plan of ORG_PLAN_VALUES) {
      if (plan === ORG_PLAN_DEFAULT) continue; // (5a) が free の値 (ORG_DAILY_LIMIT) を写す (上で確かめた)
      const row = literalRows.get(plan);
      if (!row) {
        missing.push(plan);
        continue;
      }
      expect(row.value, plan).toBe(ORG_DAILY_LIMIT);
    }
    expect(missing, 'ai_daily_limits に行の無い organizations.plan の値').toEqual([]);

    // 漏れた 2 つを足したのは本 migration で、ON CONFLICT DO NOTHING (運営が画面で決めた値は上書きしない)
    const ours = statementsOf(OUR_MIGRATION).filter((statement) => statement.includes('ai_daily_limits'));
    expect(ours).toEqual([
      `INSERT INTO public.ai_daily_limits (plan_key, daily_limit) VALUES ('premium', ${ORG_DAILY_LIMIT}), ('enterprise', ${ORG_DAILY_LIMIT}) ON CONFLICT (plan_key) DO NOTHING`,
    ]);
  });

  it('outside function bodies, migrations UPDATE or DELETE only the free row of ai_daily_limits (the organization rows keep their value)', () => {
    const touching: string[] = [];
    for (const file of migrationFiles) {
      for (const statement of statementsOf(`${MIGRATIONS_DIR}/${file}`)) {
        if (/^(UPDATE public\.ai_daily_limits|DELETE FROM public\.ai_daily_limits)\b/.test(statement)) touching.push(`${file}: ${statement}`);
      }
    }
    expect(touching.length).toBeGreaterThan(0);
    for (const entry of touching) expect(entry).toMatch(/ WHERE plan_key = 'free'$/);
  });

  it('the first definition of the plan value trigger function (this migration) let authenticated / anon change organizations.plan only to ORG_PLAN_VALUES (rejecting NULL); the latest definition (20261022170000) rejects every change by them; the trigger fires before UPDATE OF plan, and no migration drops them', () => {
    const head = `CREATE OR REPLACE FUNCTION public.${PLAN_GUARD_FUNCTION}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$`;
    const definers = migrationFiles.filter((file) => squash(stripSqlLineComments(read(`${MIGRATIONS_DIR}/${file}`))).includes(head));
    expect(definers[0], '最初の定義は本 migration').toBe(`${OURS}.sql`);
    // いま効いているのは最後の定義: #1912 の「組織のプランの段階は運営だけが変える」で、ログインした利用者と anon は
    // どの値へも変えられない (本体の逐語と戻し口は tests/org-plan-operator-only-migration-contract.test.ts が見る)
    expect(definers[definers.length - 1], '最後の定義').toBe(OPERATOR_ONLY_MIGRATION);
    const flat = squash(stripSqlLineComments(read(`${MIGRATIONS_DIR}/${OURS}.sql`)));
    const at = flat.indexOf(head);
    const body = flat.slice(at + head.length, flat.indexOf('END $$', at));

    // 止めるのはログインした利用者と anon が plan を変えるときだけ (service_role・SECURITY DEFINER の中・plan を変えない UPDATE は通す)
    expect(body).toContain("IF current_user IN ('authenticated', 'anon') AND NEW.plan IS DISTINCT FROM OLD.plan THEN");
    // 許す値の集合 = ORG_PLAN_VALUES (順序も同じ)。NULL は行が無く free で判定されるので拒む
    const allowed = body.match(/IF NEW\.plan IS NULL OR NEW\.plan NOT IN \(([^)]*)\) THEN RAISE EXCEPTION 'ORG_PLAN_NOT_ALLOWED' USING ERRCODE = '42501'; END IF;/);
    expect(allowed, '許す値の条件').not.toBeNull();
    const allowedValues = [...(allowed?.[1] ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1]);
    expect(allowedValues).toEqual([...ORG_PLAN_VALUES]);
    expect(body).toContain('RETURN NEW;');

    const statements = statementsOf(OUR_MIGRATION);
    expect(statements).toContain(`REVOKE ALL ON FUNCTION public.${PLAN_GUARD_FUNCTION}() FROM PUBLIC, anon, authenticated, service_role`);
    expect(statements).toContain(
      `CREATE OR REPLACE TRIGGER ${PLAN_GUARD_TRIGGER} BEFORE UPDATE OF plan ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.${PLAN_GUARD_FUNCTION}()`,
    );

    // migration がトリガー・関数を消すと、ログインした利用者の書き込みがまた値を限られなくなる (消すのは戻し口だけ)
    const dropping = migrationFiles.filter((file) =>
      statementsOf(`${MIGRATIONS_DIR}/${file}`).some(
        (statement) => /^DROP (TRIGGER|FUNCTION)\b/i.test(statement) && (statement.includes(PLAN_GUARD_FUNCTION) || statement.includes(PLAN_GUARD_TRIGGER)),
      ),
    );
    expect(dropping).toEqual([]);
  });

  it('the rollback drops the plan value trigger and its function, and deletes only the rows the migration added that the operator has not changed (updated_by IS NULL)', () => {
    const statements = statementsOf(OUR_ROLLBACK);
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '10s'",
      `DROP TRIGGER IF EXISTS ${PLAN_GUARD_TRIGGER} ON public.organizations`,
      `DROP FUNCTION IF EXISTS public.${PLAN_GUARD_FUNCTION}()`,
      "DELETE FROM public.ai_daily_limits AS l WHERE l.updated_by IS NULL AND l.plan_key IN ('premium', 'enterprise')",
    ]);
    // 戻す行の集合は、足した行の集合と同じ
    const added = statementsOf(OUR_MIGRATION).map(valuesRowsOf).flatMap((rows) => [...rows.keys()]);
    expect(added.sort()).toEqual(['enterprise', 'premium']);
  });
});
