/**
 * billing/02 (手動のプラン付与) 段 A: migration *_billing_manual_plan_grant.sql とロールバックの SQL の文面の契約テスト (DB は使わない)
 *
 * DB の上での振る舞い (付与・取り消し・期限切れ・家族への反映・権限・競合) は tests/integration/rls/billing-manual-grant-rpc.test.ts と
 * tests/integration/security/billing-manual-grant-cron.test.ts が確かめる。ここでは、番号の付け直しや後の migration の上書きで
 * 崩れやすい所を、ファイルの文面だけで確かめる (設計: docs/design/billing/02-manual-plan-grant.md §6・§13.1 の 25〜33・56)。
 *   25. migration とロールバックが 1 本ずつ対になり、1 行目の見出しが互いを指す
 *   26. 関数 4 本は SECURITY DEFINER・search_path が空・EXECUTE は付与 / 取り消し / 1 人分の期限切れの 3 本だけ service_role
 *   27. 関数・プロシージャ・cron のジョブの新設だけ (表・ポリシー・トリガー・索引に触れない)
 *   28. 関数・プロシージャの本体の外に、既存の行の UPDATE / DELETE / INSERT が無い
 *   29. cron のジョブ expire-manual-plan-grants の登録の形
 *   30. ロールバックはジョブ → プロシージャ → 関数の順に消し、行は消さない
 *   31. 付与の関数の入口の検査 (付与できないプラン・業務エラー 5 種)
 *   32. ロックの順 (advisory → 契約の行 → family_groups → user_profiles。利用者は 1 人だけ)
 *   33. 冒頭のコメントに判断の帰属を書かない
 *   56. プロシージャは SECURITY INVOKER・SET 句なし・利用者ごとに COMMIT する
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_billing_manual_plan_grant';
/** 本冊のジョブの名前・時刻・command (§6.4 の (6)) */
const JOB_NAME = 'expire-manual-plan-grants';
const JOB_SCHEDULE = '11 15 * * *';
const JOB_COMMAND = 'CALL public.billing_expire_manual_subscriptions();';

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

/** ドル引用の本体 ($$ … $$) を空にした SQL (本体の外の文だけを見るため) */
const withoutBodies = (sql: string): string => sql.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');

/** 文 (`;` 区切り) の一覧。本体は空にしてから切る */
const statementsOutsideBodies = (sql: string): string[] =>
  withoutBodies(sql)
    .split(';')
    .map((s) => squash(s))
    .filter((s) => s.length > 0);

/** `CREATE OR REPLACE <FUNCTION|PROCEDURE> public.<name>(` から本体の終わり (`$$;`) までを取り出す */
function definition(sql: string, kind: 'FUNCTION' | 'PROCEDURE', name: string): string {
  const match = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+${kind}\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;`,
    'i',
  ).exec(sql);
  if (!match) throw new Error(`${name} の定義が無い`);
  return match[0];
}

/** 定義の頭 (本体の前。LANGUAGE / SECURITY / SET の指定がある部分) */
const headerOf = (def: string): string => squash(def.slice(0, def.indexOf('$$')));
/** 定義の本体 ($$ と $$ の間) */
const bodyOf = (def: string): string => {
  const start = def.indexOf('$$') + 2;
  return def.slice(start, def.lastIndexOf('$$'));
};

/** 関数 4 本 (EXECUTE の付け方つき)。signature は引数の型の並び */
const FUNCTIONS = [
  { name: 'billing_grant_manual_subscription', signature: 'uuid, text, timestamptz', service: true },
  { name: 'billing_revoke_manual_subscription', signature: 'uuid', service: true },
  { name: 'billing_expire_manual_subscription_for_user', signature: 'uuid', service: true },
  { name: 'billing_manual_subscription_sync_after_end', signature: 'uuid, text', service: false },
] as const;
const PROCEDURE = 'billing_expire_manual_subscriptions';

/** 契約の行・family_groups・user_profiles を書く 3 本の関数 (利用者 1 人分の鍵と行を取る) */
const LOCKING_FUNCTIONS = [
  'billing_grant_manual_subscription',
  'billing_revoke_manual_subscription',
  'billing_expire_manual_subscription_for_user',
] as const;

const ADVISORY_LOCK = "PERFORM pg_advisory_xact_lock(hashtext('billing-user:' || p_user_id::text));";

describe('billing/02 段 A: migration とロールバックのファイル', () => {
  // 25
  it('exactly one migration ends with _billing_manual_plan_grant.sql and the same-numbered rollback exists; headers name each other (-- migration: / -- rollback:)', () => {
    expect(ours).toHaveLength(1);
    expect(fs.existsSync(path.join(ROOT, ROLLBACK))).toBe(true);
    expect(migrationRaw.split('\n', 1)[0]).toBe(`-- migration: ${ours[0]}`);
    expect(migrationRaw).toContain(`supabase/rollbacks/${ourVersion}${STEM_SUFFIX}.down.sql`);
    expect(rollbackRaw.split('\n', 1)[0]).toBe(`-- rollback: ${ours[0]}`);
  });
});

describe('billing/02 段 A: DB 関数の権限と中身の範囲', () => {
  // 26
  it('migration creates the 4 functions as SECURITY DEFINER with search_path = "", revokes PUBLIC/anon/authenticated, grants EXECUTE to service_role for grant/revoke/expire_for_user only, and grants nothing on billing_manual_subscription_sync_after_end (service_role revoked too)', () => {
    const flat = squash(migration);
    const created = [...flat.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(FUNCTIONS.map((f) => f.name).sort());
    for (const { name, signature, service } of FUNCTIONS) {
      const header = headerOf(definition(migration, 'FUNCTION', name));
      expect(header, name).toMatch(/\bSECURITY DEFINER\b/);
      expect(header, name).toMatch(/\bSET search_path = ''/);
      const grants = [...flat.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\) TO ([^;]+);`, 'g'))];
      if (service) {
        expect(flat, name).toContain(`REVOKE ALL ON FUNCTION public.${name}(${signature}) FROM PUBLIC, anon, authenticated;`);
        expect(grants.map((g) => [g[1], g[2].trim()]), name).toEqual([[signature, 'service_role']]);
      } else {
        // 内部の関数: service_role からも外し、誰にも付けない (所有者 postgres = SECURITY DEFINER の 3・4 の中からだけ)
        expect(flat, name).toContain(`REVOKE ALL ON FUNCTION public.${name}(${signature}) FROM PUBLIC, anon, authenticated, service_role;`);
        expect(grants, name).toEqual([]);
      }
    }
    // 本 migration が GRANT する先は service_role だけ (3 本)
    expect([...flat.matchAll(/\bGRANT [^;]*? TO ([^;]+);/g)].map((m) => m[1].trim())).toEqual(['service_role', 'service_role', 'service_role']);
  });

  // 27
  it('migration contains no CREATE TABLE / ALTER TABLE / CREATE POLICY / DROP POLICY / CREATE TRIGGER / CREATE INDEX (functions, the procedure and the cron job only)', () => {
    const flat = squash(migration);
    const forbidden = [
      /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\b/i,
      /\bALTER\s+TABLE\b/i,
      /\bCREATE\s+POLICY\b/i,
      /\bDROP\s+POLICY\b/i,
      /\bCREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b/i,
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
      /\bDROP\s+(?:TABLE|TRIGGER|INDEX)\b/i,
    ];
    for (const pattern of forbidden) {
      expect(flat, String(pattern)).not.toMatch(pattern);
    }
    // 番兵: 検査が空振りしていない (新設するものは拾えている)
    expect(flat).toMatch(/CREATE OR REPLACE FUNCTION public\.billing_grant_manual_subscription\(/);
    expect(flat).toMatch(/CREATE OR REPLACE PROCEDURE public\.billing_expire_manual_subscriptions\(\)/);
    expect(flat).toContain('cron.schedule(');
  });

  // 28
  it('migration contains no UPDATE/DELETE of existing rows outside function and procedure bodies', () => {
    const statements = statementsOutsideBodies(migration);
    // 番兵: 文の切り出しが空振りしていない (関数・プロシージャの定義を拾えている)
    expect(statements.some((s) => /^CREATE OR REPLACE FUNCTION public\.billing_grant_manual_subscription/.test(s))).toBe(true);
    expect(statements.some((s) => /^CREATE OR REPLACE PROCEDURE public\.billing_expire_manual_subscriptions/.test(s))).toBe(true);
    const writes = statements.filter((s) => /^(UPDATE|DELETE|TRUNCATE|MERGE)\b/i.test(s) || /^INSERT\s+INTO\b/i.test(s));
    expect(writes).toEqual([]);
    // 本体の中には書き込みがある (本体を外して見ていることの確認)
    expect(migration).toMatch(/INSERT INTO public\.personal_subscriptions/);
    expect(migration).toMatch(/UPDATE public\.personal_subscriptions/);
  });
});

describe('billing/02 段 A: pg_cron のジョブ', () => {
  // 29
  it('cron job expire-manual-plan-grants is scheduled at 11 15 * * * with the single statement CALL public.billing_expire_manual_subscriptions();, guarded by to_regclass(cron.job), unscheduling the same name first', () => {
    const flat = squash(migration);
    const schedules = [...flat.matchAll(/cron\.schedule\(\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\s*\)/g)].map((m) => [m[1], m[2], m[3]]);
    expect(schedules).toEqual([[JOB_NAME, JOB_SCHEDULE, JOB_COMMAND]]);
    // command は CALL の 1 文だけ (ほかの文と並べるとトランザクションのブロックになり、プロシージャの COMMIT が 2D000 になる)
    expect(JOB_COMMAND.match(/;/g)).toHaveLength(1);
    // pg_cron が無い DB では登録を飛ばす
    const guard = flat.indexOf("IF to_regclass('cron.job') IS NULL THEN");
    const unschedule = flat.indexOf(`PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = '${JOB_NAME}';`);
    const schedule = flat.indexOf('PERFORM cron.schedule(');
    expect(guard).toBeGreaterThan(-1);
    expect(unschedule).toBeGreaterThan(guard);
    expect(schedule).toBeGreaterThan(unschedule);
    expect(flat.slice(guard, unschedule)).toMatch(/RAISE NOTICE '[^']*'; RETURN; END IF;/);
    // ジョブの登録は DO ブロックの中だけ (cron. の呼び出しはほかに無い)
    expect(statementsOutsideBodies(migration).some((s) => /cron\./.test(s))).toBe(false);
  });
});

describe('billing/02 段 A: ロールバック', () => {
  // 30
  it('rollback unschedules the job, drops the procedure and the 4 functions (procedure before the functions it calls); it does not DELETE rows', () => {
    const flat = squash(rollback);
    const unschedule = flat.indexOf(`PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = '${JOB_NAME}';`);
    expect(flat).toContain("IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;");
    const dropProcedure = flat.indexOf(`DROP PROCEDURE IF EXISTS public.${PROCEDURE}();`);
    const drops = FUNCTIONS.map(({ name, signature }) => flat.indexOf(`DROP FUNCTION IF EXISTS public.${name}(${signature});`));
    expect(unschedule).toBeGreaterThan(-1);
    expect(dropProcedure).toBeGreaterThan(unschedule);
    for (const [index, position] of drops.entries()) {
      expect(position, FUNCTIONS[index].name).toBeGreaterThan(dropProcedure);
    }
    // 呼ぶ側 (取り消し・1 人分の期限切れ) が、呼ばれる側 (billing_manual_subscription_sync_after_end) より先に消える
    const syncPosition = drops[FUNCTIONS.findIndex((f) => f.name === 'billing_manual_subscription_sync_after_end')];
    for (const caller of ['billing_revoke_manual_subscription', 'billing_expire_manual_subscription_for_user']) {
      expect(drops[FUNCTIONS.findIndex((f) => f.name === caller)], caller).toBeLessThan(syncPosition);
    }
    // 消すものはこれだけ・行は消さない
    expect([...flat.matchAll(/\bDROP\s+(\w+)/g)].map((m) => m[1])).toEqual(['PROCEDURE', 'FUNCTION', 'FUNCTION', 'FUNCTION', 'FUNCTION']);
    expect(flat).not.toMatch(/\b(?:DELETE\s+FROM|TRUNCATE|UPDATE\s+public\.)/i);
  });
});

describe('billing/02 段 A: 付与の入口の検査と業務エラー', () => {
  // 31
  it('grant function rejects free / org / non-public (private, draft, deprecated) plans (the same table as isGrantablePlan) and raises BILL_UNKNOWN_USER, BILL_PLAN_NOT_GRANTABLE, BILL_MANUAL_EXPIRES_AT_PAST, BILL_LIVE_ROW_CONFLICT; revoke raises BILL_MANUAL_ROW_NOT_FOUND', () => {
    const grant = squash(bodyOf(definition(migration, 'FUNCTION', 'billing_grant_manual_subscription')));
    // 付与できるプランの条件: 無い / free / plan_type が personal・family 以外 / status が public 以外 → すべて BILL_PLAN_NOT_GRANTABLE
    expect(grant).toContain(
      "IF v_plan.id IS NULL OR v_plan.plan_key = 'free' OR v_plan.plan_type NOT IN ('personal', 'family') OR v_plan.status <> 'public' THEN RAISE EXCEPTION 'BILL_PLAN_NOT_GRANTABLE' USING ERRCODE = 'P0001', DETAIL = p_plan_key; END IF;",
    );
    // 設計の表 (§8.1 isGrantablePlan と同じ) の行を、同じ条件の写しに当てる
    type PlanRow = { plan_key: string; plan_type: string; status: string };
    const grantable = (row: PlanRow | null): boolean =>
      row !== null && row.plan_key !== 'free' && ['personal', 'family'].includes(row.plan_type) && row.status === 'public';
    const table: Array<[string, PlanRow | null, boolean]> = [
      ['pro', { plan_key: 'pro', plan_type: 'personal', status: 'public' }, true],
      ['family_basic', { plan_key: 'family_basic', plan_type: 'family', status: 'public' }, true],
      ['family_pro', { plan_key: 'family_pro', plan_type: 'family', status: 'public' }, true],
      ['free', { plan_key: 'free', plan_type: 'personal', status: 'public' }, false],
      ['org_standard', { plan_key: 'org_standard', plan_type: 'org', status: 'public' }, false],
      ['family_addon', { plan_key: 'family_addon', plan_type: 'family', status: 'private' }, false],
      ['draft', { plan_key: 'x_draft', plan_type: 'personal', status: 'draft' }, false],
      ['deprecated', { plan_key: 'x_deprecated', plan_type: 'personal', status: 'deprecated' }, false],
      ['unknown', null, false],
    ];
    expect(table.map(([, row]) => grantable(row))).toEqual(table.map(([, , expected]) => expected));

    // 業務エラーは P0001 + DETAIL
    const raises = (body: string): string[] =>
      [...body.matchAll(/RAISE EXCEPTION '(\w+)' USING ERRCODE = '(\w+)'(?:, DETAIL = ([^;]+))?;/g)].map(
        (m) => `${m[1]}|${m[2]}|${m[3] ?? ''}`,
      );
    expect(raises(grant)).toEqual([
      'BILL_MANUAL_EXPIRES_AT_PAST|P0001|p_expires_at::text',
      'BILL_UNKNOWN_USER|P0001|p_user_id::text',
      'BILL_PLAN_NOT_GRANTABLE|P0001|p_plan_key',
      'BILL_LIVE_ROW_CONFLICT|P0001|v_other_live::text',
    ]);
    // 引数の不足は 22023
    expect(grant).toContain("RAISE EXCEPTION 'billing_grant_manual_subscription: p_user_id / p_plan_key are required' USING ERRCODE = '22023';");
    // 利用者は auth.users と user_profiles の両方にあること (退会済み・プロフィール未作成は BILL_UNKNOWN_USER。§6.2 の 1.)。
    // user_profiles.id は auth.users を参照するので、auth.users の側を外しても DB の上の結果は変わらない — 文面で守る
    expect(grant).toContain(
      "IF NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = p_user_id) OR NOT EXISTS (SELECT 1 FROM public.user_profiles AS p WHERE p.id = p_user_id) THEN RAISE EXCEPTION 'BILL_UNKNOWN_USER'",
    );
    // 検査の順: 期限 → 利用者 → プラン → ロック → live の衝突 → INSERT
    const order = [
      'BILL_MANUAL_EXPIRES_AT_PAST',
      'BILL_UNKNOWN_USER',
      'BILL_PLAN_NOT_GRANTABLE',
      ADVISORY_LOCK,
      'BILL_LIVE_ROW_CONFLICT',
      'INSERT INTO public.personal_subscriptions',
    ].map((token) => grant.indexOf(token));
    expect(order.every((position) => position > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 期限は now() より後
    expect(grant).toContain('IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN');
    // 行の列の規則 (§4.1): stripe_* / trial_* / notes は書かない
    expect(grant).toContain(
      "INSERT INTO public.personal_subscriptions (user_id, plan_key, status, starts_at, current_period_start, current_period_end) VALUES (p_user_id, p_plan_key, 'active', now(), now(), p_expires_at)",
    );

    const revoke = squash(bodyOf(definition(migration, 'FUNCTION', 'billing_revoke_manual_subscription')));
    expect(raises(revoke)).toEqual(['BILL_MANUAL_ROW_NOT_FOUND|P0001|p_user_id::text']);
    // 取り消し・1 人分の期限切れも、引数の不足は 22023 (振る舞いは結合テスト 42・43 が見る)
    expect(revoke).toContain("IF p_user_id IS NULL THEN RAISE EXCEPTION 'billing_revoke_manual_subscription: p_user_id is required' USING ERRCODE = '22023';");
    expect(squash(bodyOf(definition(migration, 'FUNCTION', 'billing_expire_manual_subscription_for_user')))).toContain(
      "IF p_user_id IS NULL THEN RAISE EXCEPTION 'billing_expire_manual_subscription_for_user: p_user_id is required' USING ERRCODE = '22023';",
    );
    // 取り消し・期限切れは由来が M の live な行だけ (S 行に触れない)
    expect(revoke).toContain('s.stripe_subscription_id IS NULL');
    expect(squash(bodyOf(definition(migration, 'FUNCTION', 'billing_expire_manual_subscription_for_user')))).toContain(
      's.stripe_subscription_id IS NULL',
    );
  });
});

describe('billing/02 段 A: ロックの順', () => {
  // 32
  it('lock order in grant/revoke/expire_for_user: advisory billing-user of p_user_id only → personal_subscriptions (FOR NO KEY UPDATE) → family_groups → user_profiles; no function loops over users; the audit INSERT in expire_for_user uses system.billing.manual_grant_expired with actor_id NULL', () => {
    for (const name of LOCKING_FUNCTIONS) {
      const body = squash(bodyOf(definition(migration, 'FUNCTION', name)));
      // 鍵は p_user_id の 1 つだけ
      expect(body.split('pg_advisory_xact_lock').length - 1, name).toBe(1);
      expect(body, name).toContain(ADVISORY_LOCK);
      // 利用者をまたぐループが無い
      expect(body, name).not.toMatch(/\bFOR\s+\w+\s+IN\b/i);
      expect(body, name).not.toMatch(/\bLOOP\b/i);
      // 鍵 → 契約の行 (FOR NO KEY UPDATE)
      const lock = body.indexOf(ADVISORY_LOCK);
      const rowLock = body.indexOf('FOR NO KEY UPDATE');
      expect(rowLock, name).toBeGreaterThan(lock);
      expect(body.split('FOR NO KEY UPDATE').length - 1, name).toBe(1);
    }

    // 付与: 行のロック → INSERT → family_groups の UPDATE → user_profiles の UPDATE
    const grant = squash(bodyOf(definition(migration, 'FUNCTION', 'billing_grant_manual_subscription')));
    const grantOrder = [
      'FOR NO KEY UPDATE',
      'INSERT INTO public.personal_subscriptions',
      'UPDATE public.family_groups',
      'UPDATE public.user_profiles',
    ].map((token) => grant.indexOf(token));
    expect(grantOrder.every((position) => position > -1)).toBe(true);
    expect([...grantOrder].sort((a, b) => a - b)).toEqual(grantOrder);
    expect(grant).not.toContain('FOR UPDATE');
    // その family_groups の UPDATE は、家族プランのときだけ・代表者の active なグループだけ・値が変わるときだけ (写像 (9) の 10. と同じ式)。
    // 振る舞いは結合テスト 41 が見る (個人プランの付与でグループが変わらない・max_members 25 / NULL で 20 / 4)。ここは文面の崩れを先に捕まえる。
    // 値が変わるときだけの条件 (同じ値なら family_groups の行をロックしない = 写像と同じ) は、行の値を変えないので結合テストの結果に出ない — 文面で守る
    expect(grant).toContain(
      "IF v_plan.plan_type = 'family' THEN v_member_limit := LEAST(COALESCE(v_plan.max_members, c_default_member_limit), c_max_member_limit); UPDATE public.family_groups AS g SET plan_key = p_plan_key, member_limit = v_member_limit WHERE g.representative_id = p_user_id AND g.status = 'active' AND (g.plan_key IS DISTINCT FROM p_plan_key OR g.member_limit IS DISTINCT FROM v_member_limit); END IF;",
    );

    // 取り消し・期限切れ: 行の UPDATE の後、内部の同期 (family_groups → user_profiles) を呼ぶ
    for (const name of ['billing_revoke_manual_subscription', 'billing_expire_manual_subscription_for_user'] as const) {
      const body = squash(bodyOf(definition(migration, 'FUNCTION', name)));
      const update = body.indexOf('UPDATE public.personal_subscriptions');
      const sync = body.indexOf('PERFORM public.billing_manual_subscription_sync_after_end(p_user_id, v_row.plan_key);');
      expect(update, name).toBeGreaterThan(body.indexOf('FOR NO KEY UPDATE'));
      expect(sync, name).toBeGreaterThan(update);
    }
    // 内部の同期は family_groups を user_profiles より先に書き、鍵を取らない
    const sync = squash(bodyOf(definition(migration, 'FUNCTION', 'billing_manual_subscription_sync_after_end')));
    expect(sync.indexOf('UPDATE public.family_groups')).toBeGreaterThan(-1);
    expect(sync.indexOf('UPDATE public.user_profiles')).toBeGreaterThan(sync.indexOf('UPDATE public.family_groups'));
    expect(sync).not.toContain('pg_advisory_xact_lock');

    // 書き込みは対象の利用者 1 人分だけ: 関数ごとの UPDATE の全部を文面で並べる (これ以外の UPDATE は無い)。どれも WHERE で対象を名指しする
    // (契約の行 = 鍵の後で読んだ行の id・family_groups = p_user_id が代表者のグループ・user_profiles = p_user_id の行)。
    // plan_key_cached の式の SELECT も p_user_id の live な行だけから選ぶ (写像 (9) の 10. と同じ式)。
    // WHERE を外すと全員の行が書き換わる。振る舞いは結合テスト 41 (ほかの利用者の断言)・39 (非 live な後の行) が見る。ここは文面の崩れを先に捕まえる
    const PLAN_KEY_CACHED_UPDATE =
      "UPDATE public.user_profiles AS p SET plan_key_cached = ( SELECT s.plan_key FROM public.personal_subscriptions AS s WHERE s.user_id = p_user_id AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace') ORDER BY s.created_at DESC, s.id LIMIT 1) WHERE p.id = p_user_id";
    const UPDATES_BY_FUNCTION: Record<(typeof FUNCTIONS)[number]['name'], string[]> = {
      billing_grant_manual_subscription: [
        "UPDATE public.family_groups AS g SET plan_key = p_plan_key, member_limit = v_member_limit WHERE g.representative_id = p_user_id AND g.status = 'active' AND (g.plan_key IS DISTINCT FROM p_plan_key OR g.member_limit IS DISTINCT FROM v_member_limit)",
        PLAN_KEY_CACHED_UPDATE,
      ],
      billing_manual_subscription_sync_after_end: [
        "UPDATE public.family_groups AS g SET plan_key = 'free', member_limit = c_default_member_limit WHERE g.representative_id = p_user_id AND g.status = 'active' AND g.plan_key = p_plan_key AND NOT EXISTS ( SELECT 1 FROM public.personal_subscriptions AS s WHERE s.user_id = p_user_id AND s.plan_key = p_plan_key AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace'))",
        PLAN_KEY_CACHED_UPDATE,
      ],
      billing_revoke_manual_subscription: [
        "UPDATE public.personal_subscriptions SET status = 'cancelled', cancelled_at = now(), cancel_at = NULL WHERE id = v_row.id",
      ],
      billing_expire_manual_subscription_for_user: ["UPDATE public.personal_subscriptions SET status = 'expired' WHERE id = v_row.id"],
    };
    /** 本体の UPDATE 文 (`UPDATE public.` から `;` の手前まで)。FOR NO KEY UPDATE は `UPDATE public.` で始まらないので拾わない */
    const updatesOf = (body: string): string[] =>
      body.split(';').flatMap((piece) => {
        const position = piece.indexOf('UPDATE public.');
        return position < 0 ? [] : [squash(piece.slice(position))];
      });
    for (const { name } of FUNCTIONS) {
      expect(updatesOf(squash(bodyOf(definition(migration, 'FUNCTION', name)))), name).toEqual(UPDATES_BY_FUNCTION[name]);
    }
    // 番兵: 切り出しが空振りしていない (WHERE の無い UPDATE を足すと、上の一覧と食い違う)
    expect(updatesOf('BEGIN UPDATE public.t SET a = 1; SELECT 1 FOR NO KEY UPDATE; UPDATE public.u SET b = 2 WHERE c = 3; END')).toEqual([
      'UPDATE public.t SET a = 1',
      'UPDATE public.u SET b = 2 WHERE c = 3',
    ]);
    // プロシージャは行を書かない (1 人分の関数を呼ぶだけ)
    expect(updatesOf(squash(bodyOf(definition(migration, 'PROCEDURE', PROCEDURE))))).toEqual([]);

    // 期限切れの監査: system.* と actor_id NULL (SECURITY DEFINER だけが書ける。#1736)
    const expire = squash(bodyOf(definition(migration, 'FUNCTION', 'billing_expire_manual_subscription_for_user')));
    expect(expire).toContain(
      "INSERT INTO public.admin_audit_logs (actor_id, action_type, target_id, target_type, severity, details) VALUES (NULL, 'system.billing.manual_grant_expired', p_user_id, 'user', 'info',",
    );
    // 期限を過ぎた live な行だけ (期限なし = NULL は対象外)
    expect(expire).toContain('AND s.current_period_end IS NOT NULL AND s.current_period_end <= now()');
    // 監査は付与・取り消しの関数の中では書かない (route が admin.billing.manual_grant / manual_revoke を書く)
    expect(squash(bodyOf(definition(migration, 'FUNCTION', 'billing_revoke_manual_subscription')))).not.toContain('admin_audit_logs');
    expect(grant).not.toContain('admin_audit_logs');
  });

  // 33
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
    expect(migrationRaw).toMatch(/billing\/02/);
  });
});

describe('billing/02 段 A: 期限切れのプロシージャ', () => {
  // 56
  it('the procedure billing_expire_manual_subscriptions is LANGUAGE plpgsql with neither SECURITY DEFINER nor a SET clause (it COMMITs), qualifies names with public., loops over the due users ORDER BY user_id calling billing_expire_manual_subscription_for_user once per user and COMMITs right after each call, and revokes EXECUTE from PUBLIC/anon/authenticated/service_role', () => {
    const def = definition(migration, 'PROCEDURE', PROCEDURE);
    const header = headerOf(def);
    // SECURITY DEFINER と SET 句 (SET search_path など) の付いたプロシージャは COMMIT できない (2D000)
    expect(header).toMatch(/\bLANGUAGE plpgsql\b/);
    expect(header).not.toMatch(/\bSECURITY\b/i);
    expect(header).not.toMatch(/\bSET\b/i);
    const body = squash(bodyOf(def));
    // 本体の名前は public. で修飾する (search_path を固定しないので)
    const relations = [...body.matchAll(/\b(?:FROM|JOIN|PERFORM)\s+([\w.]+)/g)].map((m) => m[1]);
    expect(relations.length).toBeGreaterThan(0);
    for (const relation of relations) expect(relation, relation).toMatch(/^public\./);
    // 期限を過ぎた利用者を user_id の順に 1 人ずつ、1 人分の関数を呼んで直後に COMMIT
    expect(body).toMatch(
      /FOR v_target IN SELECT DISTINCT s\.user_id FROM public\.personal_subscriptions AS s WHERE .* ORDER BY s\.user_id LOOP/,
    );
    expect(body).toContain('s.stripe_subscription_id IS NULL');
    // live な行だけ (1 人分の関数も鍵の後で同じ条件を見直すので、外しても DB の上の結果は変わらず、毎日の呼び出しが増えるだけ — 文面で守る)
    expect(body).toContain("AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')");
    expect(body).toContain('s.current_period_end IS NOT NULL AND s.current_period_end <= now()');
    expect(body).toContain('PERFORM public.billing_expire_manual_subscription_for_user(v_target.user_id); COMMIT; END LOOP;');
    expect(body.split('COMMIT').length - 1).toBe(1);
    expect(body.split('billing_expire_manual_subscription_for_user').length - 1).toBe(1);
    // EXECUTE は誰にも付けない (所有者 postgres = pg_cron だけ)
    const flat = squash(migration);
    expect(flat).toContain(`REVOKE ALL ON PROCEDURE public.${PROCEDURE}() FROM PUBLIC, anon, authenticated, service_role;`);
    expect(flat).not.toMatch(new RegExp(`GRANT [^;]* ON PROCEDURE public\\.${PROCEDURE}\\(`));
    // プロシージャはこの 1 本だけ
    expect([...flat.matchAll(/CREATE OR REPLACE PROCEDURE public\.(\w+)\(/g)].map((m) => m[1])).toEqual([PROCEDURE]);
  });
});
