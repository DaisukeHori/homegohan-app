/**
 * #1125 (B) 解散した家族のグループの物理削除 (migration 20261018010000_purge_dissolved_family_groups.sql・設計 operator/11 §5.4・§11.3) の結合テスト
 *
 * public.purge_dissolved_family_groups(p_dry_run) の、実際の動き (消える範囲・CASCADE・上限・同意の記録・監査ログ・権限・ジョブの登録・rollback) を確かめる。
 * 書き方の取り決めは tests/purge-dissolved-family-groups-contract.test.ts。
 *
 * 確かめること (it の頭の記号は設計 §11.3 の記号):
 *   A-1: 解散から 91 日のグループが消え、CASCADE で members / invites / promotion_requests が消える。89 日・active・dissolved_at が NULL のグループは残る。
 *        membership_audit と user_profiles は残る
 *   A-2: 監査ログに system.family.dissolved_purge が actor NULL・target_type cron_job・severity info で 1 行。0 件の回は書かない
 *   A-3: 501 件あれば古い順に 500 件。remaining_count = 1
 *   A-4: parental_consents を持つグループは消えず skipped_with_consents_count に数える。それだけが 90 日を過ぎた回は監査ログを書かず (P-27)、
 *        ほかのグループを消した回は監査ログの skipped_with_consents_count に載る (P-20)
 *   A-5: family_groups を ON DELETE RESTRICT で参照する一時の表と行があると、関数は 23503 で失敗し、1 件も消えず監査ログも増えない (P-25・S-21)
 *   B-1: dry run は何も消さず件数だけ返す (監査ログも書かない)
 *   C-1: anon / authenticated は 42501。service_role は呼べる
 *   C-2: ジョブ purge-dissolved-family-groups が 1 つ登録されている (40 18 * * *・command が決めたとおり)
 *   C-3: family_groups を参照する外部キーは 5 本 (invites / members / promotion_requests / parental_consents = CASCADE、user_profiles = SET NULL)
 *   D-1: rollback でジョブと関数が消え (family_groups の行・監査ログは残り)、もう一度 migration を流すと戻る (何度流しても同じ。ジョブは 1 つのまま)
 *
 * この関数は DB 全体の「解散から 90 日を過ぎたグループ」を消す。このテストは自分が入れた行を名前の印 (TAG) で見分け、
 * 始める前にローカル DB に別の候補が残っていないことを確かめる (残っていたら件数の突き合わせが成り立たないので、明示して止める)。
 * 時刻の計算は DB の時計 (now()) で行う (テストを流す機械の時計とずれても境界が動かない)。このテストが作った行は、終わりに必ず消す。
 *
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。本番には接続しない。
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/purge-dissolved-family-groups.test.ts
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VERSION = '20261018010000';
const NAME = 'purge_dissolved_family_groups';
const MIGRATION_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`), 'utf8');
const ROLLBACK_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/rollbacks/${VERSION}_${NAME}.down.sql`), 'utf8');

const JOB_NAME = 'purge-dissolved-family-groups';
const JOB_SCHEDULE = '40 18 * * *';
const JOB_COMMAND = 'SELECT public.purge_dissolved_family_groups(false);';
const ACTION_TYPE = 'system.family.dissolved_purge';
/** 保存期間 (日)。設計 §0.4 Q-1 の確認の結果 = 90 日 */
const RETENTION_DAYS = 90;
/** 1 回の実行で消す上限 (設計 §5.4.1) */
const BATCH_LIMIT = 500;
/** 上限を確かめるために作るグループの数 (上限 + 1) */
const OVER_LIMIT_COUNT = BATCH_LIMIT + 1;
const PERMISSION_DENIED_SQLSTATE = '42501';
const FOREIGN_KEY_VIOLATION_SQLSTATE = '23503';
/** PostgREST が RPC の関数を見つけられないときのコード (migration を流した直後のスキーマキャッシュの更新待ち) */
const SCHEMA_CACHE_MISS_CODE = 'PGRST202';
const SCHEMA_CACHE_RETRIES = 20;
const SCHEMA_CACHE_RETRY_DELAY_MS = 500;
const LONG_TIMEOUT_MS = 180_000;
/** 解散からの経過日数 (境界の内側と外側) */
const DAYS_OVER = RETENTION_DAYS + 1;
const DAYS_UNDER = RETENTION_DAYS - 1;
/** A-3 で作る 501 件の dissolved_at の起点。ほかの行より確実に古い日付 (古い順に消えることを確かめる) */
const OLDEST_BASE = '2001-01-01 00:00:00+00';

const RUN = randomBytes(4).toString('hex');
/** このテストが入れたグループの名前の頭 (family_groups.name は 60 文字まで) */
const TAG = `t1125c-${RUN}`;
const PASSWORD = `Pw-${RUN}-Aa1!`;

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}
const sr = client(serviceKey);
const anon = client(anonKey);

/** ローカルスタックの postgres-meta で SQL を流す (テストの準備・確認・migration の実行にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

/** 本番の migration と同じ postgres ロールで流す (このリクエストの中だけ) */
function asPostgres<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return pgQuery<T>(`SET LOCAL ROLE postgres;\n${sql}`);
}

/** SQL の文字列リテラルにする (テストが決めた固定の文字列だけを渡す) */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** migration を流した直後は、PostgREST が関数を見つけられない (PGRST202) ことがある。その場合だけ、最大 10 秒待ってやり直す */
async function withSchemaCacheRetry<T extends { error: PostgrestError | null }>(call: () => PromiseLike<T>): Promise<T> {
  let last = await call();
  for (let attempt = 0; attempt < SCHEMA_CACHE_RETRIES && last.error?.code === SCHEMA_CACHE_MISS_CODE; attempt += 1) {
    await sleep(SCHEMA_CACHE_RETRY_DELAY_MS);
    last = await call();
  }
  return last;
}

interface PurgeRow {
  purge_count: number;
  remaining_count: number;
  skipped_with_consents_count: number;
  dry_run: boolean;
}

/** 関数を service_role で呼び、1 行の戻り値を返す (エラーなら投げる) */
async function purge(dryRun: boolean): Promise<PurgeRow> {
  const { data, error } = await withSchemaCacheRetry(() => sr.rpc('purge_dissolved_family_groups', { p_dry_run: dryRun }));
  if (error) throw new Error(`purge_dissolved_family_groups(${dryRun}): ${error.code} ${error.message}`);
  const rows = data as PurgeRow[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

// ---------------------------------------------------------------
// 準備: 利用者 (代表者) とグループ
// ---------------------------------------------------------------
let representativeId = '';
let representativeEmail = '';

async function createRepresentative(): Promise<void> {
  representativeEmail = `${TAG}@homegohan.test`;
  const { data, error } = await sr.auth.admin.createUser({ email: representativeEmail, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  representativeId = data.user.id;
}

interface SeedOptions {
  /** 名前の後ろに付ける印 */
  label: string;
  status: 'active' | 'dissolved';
  /** 解散してからの日数 (DB の now() からの差)。null なら dissolved_at を入れない */
  dissolvedDaysAgo: number | null;
  /** メンバー 3 人 (代表者 + 子供 2)・招待 1 件・昇格リクエスト 1 件・membership_audit 1 行を付ける */
  withDependents?: boolean;
  /** 保護者の同意の記録 (取り消し済みの行) を 1 行付ける */
  withConsent?: boolean;
}

interface SeededGroup {
  id: string;
  childMemberIds: string[];
}

const seededGroupIds: string[] = [];

async function seedGroup(options: SeedOptions): Promise<SeededGroup> {
  const dissolvedAt = options.dissolvedDaysAgo === null ? 'NULL' : `now() - interval '${options.dissolvedDaysAgo} days'`;
  const rows = await asPostgres<{ id: string }>(`
    INSERT INTO public.family_groups (name, representative_id, status, dissolved_at)
    VALUES (${lit(`${TAG}-${options.label}`)}, ${lit(representativeId)}, ${lit(options.status)}, ${dissolvedAt})
    RETURNING id;
  `);
  const id = rows[0].id;
  seededGroupIds.push(id);
  if (options.status === 'active') {
    // billing/03 §6.6: active で plan_key = free のグループには代表者以外のメンバーを足せない (family_members_billing_plan_gate)。
    // グループの INSERT ではトリガーが代表者の契約から plan_key を決める (契約が無いので free) ので、メンバーを足す前に家族プランにする
    await asPostgres(`UPDATE public.family_groups SET plan_key = 'family_basic' WHERE id = ${lit(id)};`);
  }
  const childMemberIds: string[] = [];
  if (options.withDependents || options.withConsent) {
    // 解散の RPC (operator_force_dissolve_family) が残す形: メンバーは全員 left
    await asPostgres(`
      INSERT INTO public.family_members (family_id, user_id, role, status)
      VALUES (${lit(id)}, ${lit(representativeId)}, 'representative', 'left');
    `);
    const children = await asPostgres<{ id: string }>(`
      INSERT INTO public.family_members (family_id, user_id, role, status, display_name, child_profile, birth_date)
      VALUES (${lit(id)}, NULL, 'child', 'left', 'こども1', '{}'::jsonb, date '2018-04-01'),
             (${lit(id)}, NULL, 'child', 'left', 'こども2', '{}'::jsonb, date '2019-05-02')
      RETURNING id;
    `);
    childMemberIds.push(...children.map((row) => row.id));
  }
  if (options.withDependents) {
    await asPostgres(`
      INSERT INTO public.family_invites (family_id, email, token, expires_at, invited_by)
      VALUES (${lit(id)}, ${lit(`${TAG}-invite@homegohan.test`)}, ${lit(`${TAG}-${options.label}-invite-token`)}, now() + interval '7 days', ${lit(representativeId)});
      INSERT INTO public.family_promotion_requests (family_id, member_id, email, token, requested_by)
      VALUES (${lit(id)}, ${lit(childMemberIds[0])}, ${lit(`${TAG}-promo@homegohan.test`)}, ${lit(`${TAG}-${options.label}-promo-token`)}, ${lit(representativeId)});
      INSERT INTO public.membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
      VALUES ('family', ${lit(id)}, 'group_dissolved', ${lit(representativeId)}, NULL, ${lit(JSON.stringify({ tag: TAG }))}::jsonb);
    `);
  }
  if (options.withConsent) {
    // 取り消し済みの同意の記録 (revoked_at と revoked_reason は対)。行があるだけで、グループは候補から外れる
    await asPostgres(`
      INSERT INTO public.parental_consents
        (family_member_id, family_id, parent_user_id, signed_name, guardian_attested, consent_version, child_birth_date, child_age_at_signing, revoked_at, revoked_reason)
      VALUES (${lit(childMemberIds[0])}, ${lit(id)}, ${lit(representativeId)}, ${lit(`${TAG}-署名`)}, true, '1.0', date '2018-04-01', 7, now(), 'member_left');
    `);
  }
  return { id, childMemberIds };
}

interface Counts {
  groups: number;
  members: number;
  invites: number;
  promotions: number;
  consents: number;
  membershipAudit: number;
}

/** 指定したグループに紐づく行の数 */
async function countsOf(groupIds: string[]): Promise<Counts> {
  if (groupIds.length === 0) return { groups: 0, members: 0, invites: 0, promotions: 0, consents: 0, membershipAudit: 0 };
  const list = groupIds.map(lit).join(', ');
  const rows = await asPostgres<Counts>(`
    SELECT (SELECT count(*)::int FROM public.family_groups WHERE id IN (${list})) AS groups,
           (SELECT count(*)::int FROM public.family_members WHERE family_id IN (${list})) AS members,
           (SELECT count(*)::int FROM public.family_invites WHERE family_id IN (${list})) AS invites,
           (SELECT count(*)::int FROM public.family_promotion_requests WHERE family_id IN (${list})) AS promotions,
           (SELECT count(*)::int FROM public.parental_consents WHERE family_id IN (${list})) AS consents,
           (SELECT count(*)::int FROM public.membership_audit WHERE scope = 'family' AND scope_id IN (${list})) AS "membershipAudit";
  `);
  return rows[0];
}

interface AuditRow {
  actor_id: string | null;
  action_type: string;
  target_type: string | null;
  severity: string;
  details: { purge_count: number; remaining_count: number; skipped_with_consents_count: number; retention_days: number };
}

async function dbNow(): Promise<string> {
  const rows = await asPostgres<{ now: string }>(`SELECT clock_timestamp()::text AS now;`);
  return rows[0].now;
}

/** since (DB の時計) より後に書かれた、この関数の監査ログ。古い順 */
async function auditSince(since: string): Promise<AuditRow[]> {
  return asPostgres<AuditRow>(`
    SELECT actor_id, action_type, target_type, severity, details
      FROM public.admin_audit_logs
     WHERE action_type = ${lit(ACTION_TYPE)} AND created_at > ${lit(since)}::timestamptz
     ORDER BY created_at ASC;
  `);
}

/** 全期間の、この関数の監査ログの行数 (増減の比較用) */
async function auditTotal(): Promise<number> {
  const rows = await asPostgres<{ n: number }>(`SELECT count(*)::int AS n FROM public.admin_audit_logs WHERE action_type = ${lit(ACTION_TYPE)};`);
  return rows[0].n;
}

async function deleteSeededGroups(): Promise<void> {
  // 名前の印で消す (前の実行の残りも含む)。CASCADE で members / invites / promotion_requests / parental_consents も消える
  await asPostgres(`
    DELETE FROM public.membership_audit WHERE scope = 'family' AND metadata->>'tag' LIKE ${lit('t1125c-%')};
    DELETE FROM public.family_groups WHERE name LIKE ${lit('t1125c-%')};
  `);
  seededGroupIds.length = 0;
}

async function deleteTestAudit(since: string): Promise<void> {
  await asPostgres(`DELETE FROM public.admin_audit_logs WHERE action_type = ${lit(ACTION_TYPE)} AND created_at > ${lit(since)}::timestamptz;`);
}

let testStartedAt = '';

beforeAll(async () => {
  testStartedAt = await dbNow();
  await deleteSeededGroups();
  await createRepresentative();
  // 別の候補 (解散から 90 日を過ぎたグループ) がローカルの DB に残っていると、件数の突き合わせが成り立たない
  const leftover = await purge(true);
  if (leftover.purge_count !== 0 || leftover.skipped_with_consents_count !== 0) {
    throw new Error(
      `ローカル DB に解散から ${RETENTION_DAYS} 日を過ぎたグループが残っています (purge_count=${leftover.purge_count}, skipped=${leftover.skipped_with_consents_count})。` +
        'supabase db reset してから流してください。',
    );
  }
}, LONG_TIMEOUT_MS);

afterAll(async () => {
  await deleteSeededGroups();
  await asPostgres(`DROP TABLE IF EXISTS public.${restrictTableName()};`);
  if (testStartedAt) await deleteTestAudit(testStartedAt);
  if (representativeId) await sr.auth.admin.deleteUser(representativeId); // user_profiles は CASCADE
}, LONG_TIMEOUT_MS);

function restrictTableName(): string {
  return `t1125c_restrict_${RUN}`;
}

// ---------------------------------------------------------------
// A. 動き
// ---------------------------------------------------------------
describe('#1125 (B) A. purge_dissolved_family_groups の動き', () => {
  it(
    'A-1: 解散から 91 日のグループが消え、CASCADE で members / invites / promotion_requests が消える。89 日・active・dissolved_at が NULL は残る。membership_audit と利用者は残る',
    async () => {
      const over = await seedGroup({ label: 'a1-over', status: 'dissolved', dissolvedDaysAgo: DAYS_OVER, withDependents: true });
      const under = await seedGroup({ label: 'a1-under', status: 'dissolved', dissolvedDaysAgo: DAYS_UNDER, withDependents: true });
      const active = await seedGroup({ label: 'a1-active', status: 'active', dissolvedDaysAgo: null, withDependents: true });
      const noTimestamp = await seedGroup({ label: 'a1-no-dissolved-at', status: 'dissolved', dissolvedDaysAgo: null, withDependents: true });

      expect(await countsOf([over.id])).toEqual({ groups: 1, members: 3, invites: 1, promotions: 1, consents: 0, membershipAudit: 1 });

      const result = await purge(false);
      expect(result).toEqual({ purge_count: 1, remaining_count: 0, skipped_with_consents_count: 0, dry_run: false });

      // 消えたもの: グループと、CASCADE で members 3・invites 1・promotion_requests 1。membership_audit (scope_id に外部キーが無い) は残る
      expect(await countsOf([over.id])).toEqual({ groups: 0, members: 0, invites: 0, promotions: 0, consents: 0, membershipAudit: 1 });
      // 残るもの: 89 日・active・dissolved_at が NULL のグループは、子の行ごとそのまま
      for (const kept of [under, active, noTimestamp]) {
        expect(await countsOf([kept.id])).toEqual({ groups: 1, members: 3, invites: 1, promotions: 1, consents: 0, membershipAudit: 1 });
      }
      // 利用者 (代表者) の行は残る
      const profile = await asPostgres<{ n: number }>(`SELECT count(*)::int AS n FROM auth.users WHERE id = ${lit(representativeId)};`);
      expect(profile[0].n).toBe(1);

      await deleteSeededGroups();
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'A-2: 監査ログに system.family.dissolved_purge が actor NULL・target_type cron_job・severity info で 1 行。0 件の回は書かない',
    async () => {
      await seedGroup({ label: 'a2-1', status: 'dissolved', dissolvedDaysAgo: DAYS_OVER });
      await seedGroup({ label: 'a2-2', status: 'dissolved', dissolvedDaysAgo: DAYS_OVER + 5 });
      const since = await dbNow();

      const result = await purge(false);
      expect(result).toEqual({ purge_count: 2, remaining_count: 0, skipped_with_consents_count: 0, dry_run: false });
      const audits = await auditSince(since);
      expect(audits).toHaveLength(1);
      expect(audits[0].actor_id).toBeNull();
      expect(audits[0].action_type).toBe(ACTION_TYPE);
      expect(audits[0].target_type).toBe('cron_job');
      expect(audits[0].severity).toBe('info');
      expect(audits[0].details).toEqual({ purge_count: 2, remaining_count: 0, skipped_with_consents_count: 0, retention_days: RETENTION_DAYS });

      // 候補が 0 件の回 (消えるものが無い): 戻り値は 0 件で、監査ログは増えない
      const before = await auditTotal();
      const idle = await purge(false);
      expect(idle).toEqual({ purge_count: 0, remaining_count: 0, skipped_with_consents_count: 0, dry_run: false });
      expect(await auditTotal()).toBe(before);

      await deleteSeededGroups();
    },
    LONG_TIMEOUT_MS,
  );

  it(
    `A-3: ${OVER_LIMIT_COUNT} 件あれば古い順に ${BATCH_LIMIT} 件。remaining_count = 1`,
    async () => {
      // 解散の日時がすべて違う 501 件を、1 回の INSERT で作る (OLDEST_BASE から 1 分ずつ新しい)。最も新しい 1 件だけが残るはず
      const rows = await asPostgres<{ id: string; minute_offset: number }>(`
        INSERT INTO public.family_groups (name, representative_id, status, dissolved_at)
        SELECT ${lit(`${TAG}-a3-`)} || n, ${lit(representativeId)}, 'dissolved', ${lit(OLDEST_BASE)}::timestamptz + (n * interval '1 minute')
          FROM generate_series(1, ${OVER_LIMIT_COUNT}) AS n
        RETURNING id, (extract(epoch FROM dissolved_at - ${lit(OLDEST_BASE)}::timestamptz) / 60)::int AS minute_offset;
      `);
      expect(rows).toHaveLength(OVER_LIMIT_COUNT);
      const newest = rows.find((row) => row.minute_offset === OVER_LIMIT_COUNT);
      expect(newest).toBeDefined();

      const dry = await purge(true);
      expect(dry.purge_count).toBe(OVER_LIMIT_COUNT);
      const since = await dbNow();
      const result = await purge(false);
      expect(result).toEqual({ purge_count: BATCH_LIMIT, remaining_count: 1, skipped_with_consents_count: 0, dry_run: false });

      const left = await asPostgres<{ id: string }>(`SELECT id FROM public.family_groups WHERE name LIKE ${lit(`${TAG}-a3-%`)};`);
      expect(left.map((row) => row.id)).toEqual([newest?.id]);
      const audits = await auditSince(since);
      expect(audits).toHaveLength(1);
      expect(audits[0].details).toEqual({ purge_count: BATCH_LIMIT, remaining_count: 1, skipped_with_consents_count: 0, retention_days: RETENTION_DAYS });

      // 翌日の回で残りの 1 件が消える
      expect(await purge(false)).toEqual({ purge_count: 1, remaining_count: 0, skipped_with_consents_count: 0, dry_run: false });
      await deleteSeededGroups();
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'A-4: parental_consents を持つグループは消えず skipped_with_consents_count に数える。それだけが 90 日を過ぎた回は監査ログを書かず、ほかのグループを消した回は監査ログに載る',
    async () => {
      const consent = await seedGroup({ label: 'a4-consent', status: 'dissolved', dissolvedDaysAgo: DAYS_OVER, withConsent: true });

      // 同意の記録を持つグループだけが 90 日を過ぎた回 (P-27): 何も消さず、監査ログも書かない。dry run も同じ数を返す
      expect(await purge(true)).toEqual({ purge_count: 0, remaining_count: 0, skipped_with_consents_count: 1, dry_run: true });
      const totalBefore = await auditTotal();
      expect(await purge(false)).toEqual({ purge_count: 0, remaining_count: 0, skipped_with_consents_count: 1, dry_run: false });
      expect(await auditTotal()).toBe(totalBefore);
      expect((await countsOf([consent.id])).groups).toBe(1);
      expect((await countsOf([consent.id])).consents).toBe(1);

      // ほかに消えるグループがある回 (P-20): 同意の記録を持つグループは残り、消した回の監査ログに残した数が載る
      const plain = await seedGroup({ label: 'a4-plain', status: 'dissolved', dissolvedDaysAgo: DAYS_OVER, withDependents: true });
      const since = await dbNow();
      expect(await purge(false)).toEqual({ purge_count: 1, remaining_count: 0, skipped_with_consents_count: 1, dry_run: false });
      expect(await countsOf([plain.id])).toMatchObject({ groups: 0, members: 0, invites: 0, promotions: 0 });
      expect(await countsOf([consent.id])).toMatchObject({ groups: 1, members: 3, consents: 1 });
      const audits = await auditSince(since);
      expect(audits).toHaveLength(1);
      expect(audits[0].details).toEqual({ purge_count: 1, remaining_count: 0, skipped_with_consents_count: 1, retention_days: RETENTION_DAYS });

      await deleteSeededGroups();
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'A-5: family_groups を ON DELETE RESTRICT で参照する一時の表と行を作ると、関数は 23503 で失敗し、1 件も消えず監査ログも増えない',
    async () => {
      const blocked = await seedGroup({ label: 'a5-blocked', status: 'dissolved', dissolvedDaysAgo: DAYS_OVER });
      const other = await seedGroup({ label: 'a5-other', status: 'dissolved', dissolvedDaysAgo: DAYS_OVER + 10 });
      const table = restrictTableName();
      await asPostgres(`
        CREATE TABLE public.${table} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          family_id uuid NOT NULL REFERENCES public.family_groups (id) ON DELETE RESTRICT
        );
        INSERT INTO public.${table} (family_id) VALUES (${lit(blocked.id)});
      `);
      try {
        const totalBefore = await auditTotal();
        const { data, error } = await withSchemaCacheRetry(() => sr.rpc('purge_dissolved_family_groups', { p_dry_run: false }));
        expect(data).toBeNull();
        expect(error?.code).toBe(FOREIGN_KEY_VIOLATION_SQLSTATE);
        // 取引ごと巻き戻る: ブロックされたグループも、ほかの候補も消えていない。監査ログも書かれていない
        expect((await countsOf([blocked.id, other.id])).groups).toBe(2);
        expect(await auditTotal()).toBe(totalBefore);
      } finally {
        await asPostgres(`DROP TABLE IF EXISTS public.${table};`);
      }
      // 参照が無くなれば、次の回で消える
      expect(await purge(false)).toEqual({ purge_count: 2, remaining_count: 0, skipped_with_consents_count: 0, dry_run: false });
      await deleteSeededGroups();
    },
    LONG_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------
// B. dry run
// ---------------------------------------------------------------
describe('#1125 (B) B. dry run', () => {
  it(
    'B-1: dry run は何も消さず、件数だけ返す。監査ログも書かない',
    async () => {
      const over = await seedGroup({ label: 'b1-over', status: 'dissolved', dissolvedDaysAgo: DAYS_OVER, withDependents: true });
      const consent = await seedGroup({ label: 'b1-consent', status: 'dissolved', dissolvedDaysAgo: DAYS_OVER, withConsent: true });
      const totalBefore = await auditTotal();

      expect(await purge(true)).toEqual({ purge_count: 1, remaining_count: 0, skipped_with_consents_count: 1, dry_run: true });
      expect(await countsOf([over.id])).toEqual({ groups: 1, members: 3, invites: 1, promotions: 1, consents: 0, membershipAudit: 1 });
      expect((await countsOf([consent.id])).groups).toBe(1);
      expect(await auditTotal()).toBe(totalBefore);

      await deleteSeededGroups();
    },
    LONG_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------
// C. 権限・ジョブ・外部キー
// ---------------------------------------------------------------
describe('#1125 (B) C. 権限・ジョブ・外部キー', () => {
  it('C-1: anon / authenticated は 42501。service_role は呼べる', async () => {
    const anonResult = await withSchemaCacheRetry(() => anon.rpc('purge_dissolved_family_groups', { p_dry_run: true }));
    expect(anonResult.error?.code).toBe(PERMISSION_DENIED_SQLSTATE);

    const signIn = await client(anonKey).auth.signInWithPassword({ email: representativeEmail, password: PASSWORD });
    if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
    const authed = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${signIn.data.session.access_token}` } },
      realtime: { transport: ws as unknown as typeof WebSocket },
    });
    const authedResult = await withSchemaCacheRetry(() => authed.rpc('purge_dissolved_family_groups', { p_dry_run: true }));
    expect(authedResult.error?.code).toBe(PERMISSION_DENIED_SQLSTATE);

    const privileges = await pgQuery<{ role: string; allowed: boolean }>(`
      SELECT r AS role, has_function_privilege(r, 'public.purge_dissolved_family_groups(boolean)'::regprocedure, 'EXECUTE') AS allowed
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'postgres']) AS r
       ORDER BY r;
    `);
    expect(Object.fromEntries(privileges.map((row) => [row.role, row.allowed]))).toEqual({ anon: false, authenticated: false, service_role: true, postgres: true });
    // PUBLIC にも付いていない (anon / authenticated が PUBLIC 経由で持つことは、上の has_function_privilege が false で確かめている)
    const publicAcl = await pgQuery<{ acl: string | null }>(`SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'public.purge_dissolved_family_groups(boolean)'::regprocedure;`);
    expect(publicAcl[0].acl ?? '').not.toMatch(/(^|[{,])=X/);

    const ok = await withSchemaCacheRetry(() => sr.rpc('purge_dissolved_family_groups', { p_dry_run: true }));
    expect(ok.error).toBeNull();
  });

  it('C-2: ジョブ purge-dissolved-family-groups が 1 つ登録されている (40 18 * * *・command が決めたとおり)。この関数を呼ぶジョブはほかに無い', async () => {
    const jobs = await asPostgres<{ jobname: string; schedule: string; command: string; active: boolean }>(`
      SELECT jobname, schedule, command, active FROM cron.job
       WHERE jobname = ${lit(JOB_NAME)} OR command ~* '[[:<:]]purge_dissolved_family_groups[[:>:]]';
    `);
    expect(jobs).toEqual([{ jobname: JOB_NAME, schedule: JOB_SCHEDULE, command: JOB_COMMAND, active: true }]);
  });

  it('C-3: family_groups を参照する外部キーは 5 本 (invites / members / promotion_requests / parental_consents = CASCADE、user_profiles = SET NULL)。増えたら設計 §5.4.2 の表と契約テストを直す', async () => {
    const fks = await pgQuery<{ referencing: string; action: string }>(`
      SELECT (SELECT c.relname::text FROM pg_class AS c WHERE c.oid = conrelid) AS referencing,
             CASE confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'r' THEN 'RESTRICT' WHEN 'a' THEN 'NO ACTION' WHEN 'd' THEN 'SET DEFAULT' END AS action
        FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'public.family_groups'::regclass
         AND (SELECT c.relname::text FROM pg_class AS c WHERE c.oid = conrelid) NOT LIKE ${lit('t1125c\\_restrict\\_%')}
       ORDER BY 1;
    `);
    expect(fks).toEqual([
      { referencing: 'family_invites', action: 'CASCADE' },
      { referencing: 'family_members', action: 'CASCADE' },
      { referencing: 'family_promotion_requests', action: 'CASCADE' },
      { referencing: 'parental_consents', action: 'CASCADE' },
      { referencing: 'user_profiles', action: 'SET NULL' },
    ]);
  });
});

// ---------------------------------------------------------------
// D. rollback
// ---------------------------------------------------------------
describe('#1125 (B) D-1. rollback でジョブと関数が消え、もう一度 migration を流すと戻る', () => {
  it(
    'rollback: ジョブと関数が消える。family_groups の行・監査ログは残る。何度流しても同じ',
    async () => {
      const kept = await seedGroup({ label: 'd1-kept', status: 'dissolved', dissolvedDaysAgo: DAYS_UNDER });
      const auditBefore = await auditTotal();

      await asPostgres(ROLLBACK_SQL);
      await asPostgres(ROLLBACK_SQL); // 冪等

      const gone = await pgQuery<{ present: boolean }>(`SELECT to_regprocedure('public.purge_dissolved_family_groups(boolean)') IS NOT NULL AS present;`);
      expect(gone[0].present).toBe(false);
      const jobs = await asPostgres<{ n: number }>(`
        SELECT count(*)::int AS n FROM cron.job WHERE jobname = ${lit(JOB_NAME)} OR command ~* '[[:<:]]purge_dissolved_family_groups[[:>:]]';
      `);
      expect(jobs[0].n).toBe(0);
      // 触れないもの
      expect((await countsOf([kept.id])).groups).toBe(1);
      expect(await auditTotal()).toBe(auditBefore);
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'rollback のあとにもう一度 migration を流すと戻り (何度流しても同じ)、権限も元のとおり。ジョブは 1 つのまま',
    async () => {
      await asPostgres(MIGRATION_SQL);
      await asPostgres(MIGRATION_SQL); // 冪等

      const privileges = await pgQuery<{ role: string; allowed: boolean }>(`
        SELECT r AS role, has_function_privilege(r, 'public.purge_dissolved_family_groups(boolean)'::regprocedure, 'EXECUTE') AS allowed
          FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r ORDER BY r;
      `);
      expect(Object.fromEntries(privileges.map((row) => [row.role, row.allowed]))).toEqual({ anon: false, authenticated: false, service_role: true });
      const jobs = await asPostgres<{ jobname: string; schedule: string; command: string }>(`
        SELECT jobname, schedule, command FROM cron.job WHERE jobname = ${lit(JOB_NAME)} OR command ~* '[[:<:]]purge_dissolved_family_groups[[:>:]]';
      `);
      expect(jobs).toEqual([{ jobname: JOB_NAME, schedule: JOB_SCHEDULE, command: JOB_COMMAND }]);
      // 89 日のグループは消えず、関数は呼べる
      const dry = await purge(true);
      expect(dry.dry_run).toBe(true);
      expect(dry.purge_count).toBe(0);
      await deleteSeededGroups();
    },
    LONG_TIMEOUT_MS,
  );
});
