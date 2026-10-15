/**
 * #1136 Push 通知の送信待ち (push_outbox) の DB 側の部品の回帰テスト (実 DB)
 *   public.push_outbox / RPC 8 本 / トリガー weekly_menu_requests_enqueue_push
 *   (supabase/migrations/20261016237000_push_outbox.sql。設計 docs/design/mobile/06-push-send.md §5・§7・§10)
 *
 * 期待する挙動:
 *   - 表と RPC 8 本は service_role だけが使える。anon / authenticated は 42501
 *   - enqueue_push_notification: 利用者の端末の行ごとに 1 行。端末が無ければ 0。dedupe_key ('<出来事>:<token>') で 2 回目は 0。
 *       token の長さが 1..256 を外れる端末の行は飛ばし、同じ利用者のほかの端末には積む (R-24)
 *   - claim_push_outbox: 同時に何本来ても同じ行は 1 本だけ (SKIP LOCKED + リース)
 *   - complete / fail / defer / record_push_receipt: 取った worker の行だけを動かす (別の worker では false / 'ignored')
 *   - fail_push_outbox: retryable かつ回数が残っていれば queued に戻し、そうでなければ dead
 *   - defer_push_outbox: attempts を増やさずに次の時刻だけを動かす
 *   - claim_push_receipts / record_push_receipt: 送ってから時間のたった sent の行を取り、結果を残す (NULL = まだ無い)
 *   - cleanup_push_outbox: 24 時間を超えたリースの無い queued を expired の dead にし、sent は 7 日・dead は 30 日で消す
 *   - 端末の行の削除・退会で送信待ちの行も消える (FK の CASCADE。S-11・S-12)
 *   - トリガー: 2 日以上の target_slots の行が completed / failed になったときだけ積む。中止・止まった行の印・1 日以下・
 *       target_slots の無い行には積まない。同じ依頼で 2 通作らない。登録の失敗で weekly_menu_requests の更新を止めない (R-02)
 *
 * 段 B (worker) の部品 (createOutboxStore().loadEligibility) の結合の確認は、段 B で src/lib/push/outbox-store.ts と一緒に足す。
 *
 * claim_push_outbox / claim_push_receipts は表の全体から古い順に取るので、このテストの行は next_attempt_at / sent_at を
 * 2000 年にして先頭に来るようにし、取る件数を自分の行の数にする。行は利用者の削除 (CASCADE) で片付ける。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/push-outbox.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import ws from 'ws';

// ---------------------------------------------------------------
// 環境変数 / クライアント
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);

// ---------------------------------------------------------------
// 定数 (設計 §5・§6.1 の値)
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = 'TestPass!2026-push-outbox';
/** RPC を直接呼ぶテストで使う種類 (worker の一覧には無い。行は利用者の削除で消える) */
const TEST_KIND = 'rls_1136_push_outbox';
/** token の長さの上限 (push_outbox.expo_push_token の CHECK・enqueue の c_max_token_chars) */
const MAX_TOKEN_CHARS = 256;
/** payload の上限 (バイト) */
const MAX_PAYLOAD_BYTES = 2048;
/** 取った行のリース (秒)。worker の PUSH_OUTBOX_LEASE_SECONDS と同じ */
const LEASE_SECONDS = 120;
/** 試行の上限の既定 (PUSH_OUTBOX_MAX_ATTEMPTS) */
const MAX_ATTEMPTS = 3;
/** 1 回目の失敗のあとの待ち (秒) */
const FIRST_RETRY_SECONDS = 60;
/** receipt を確かめるまでの待ち (秒。PUSH_RECEIPT_CHECK_DELAY_SECONDS) */
const RECEIPT_MIN_AGE_SECONDS = 900;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
/** 時刻の比較の許容 (DB とテストの機械の時計のずれと、要求の往復の時間) */
const CLOCK_TOLERANCE_MS = 30 * SECOND;

/** 古い順に取る claim の先頭に来るよう、自分の行を 2000 年にする。1 行ごとに 1 秒ずらして順を固定する */
let oldSeq = 0;
const oldTimestamp = () => new Date(Date.UTC(2000, 0, 1, 0, 0, oldSeq++)).toISOString();

// ---------------------------------------------------------------
// 利用者・端末の行
// ---------------------------------------------------------------
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<string> {
  const email = `rls-1136-push-${TS}-${label}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  return data.user.id;
}

const tokenFor = (label: string) => `ExponentPushToken[rls1136-${TS}-${label}]`;

/** 端末の行を service_role で作る (アプリの upsert と同じ列)。行の id を返す */
async function addDevice(userId: string, token: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('user_push_tokens')
    .insert({ user_id: userId, expo_push_token: token, platform: 'ios' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`user_push_tokens insert: ${error?.message}`);
  return data.id as string;
}

interface OutboxRow {
  id: string;
  status: 'queued' | 'sent' | 'dead';
  kind: string;
  user_id: string;
  push_token_id: string;
  expo_push_token: string;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  attempts: number;
  next_attempt_at: string;
  lease_expires_at: string | null;
  worker_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_status_code: number | null;
  sent_at: string | null;
  receipt_id: string | null;
  receipt_checked_at: string | null;
  receipt_status: string | null;
  receipt_error: string | null;
  dead_at: string | null;
  created_at: string;
}

async function rowsOf(userId: string): Promise<OutboxRow[]> {
  const { data, error } = await srAdmin.from('push_outbox').select('*').eq('user_id', userId).order('created_at');
  if (error) throw new Error(`select push_outbox: ${error.message}`);
  return (data ?? []) as OutboxRow[];
}

async function rowById(id: string): Promise<OutboxRow | null> {
  const { data, error } = await srAdmin.from('push_outbox').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`select push_outbox ${id}: ${error.message}`);
  return (data ?? null) as OutboxRow | null;
}

async function updateRows(ids: string[], patch: Record<string, unknown>) {
  const { error } = await srAdmin.from('push_outbox').update(patch).in('id', ids);
  if (error) throw new Error(`update push_outbox: ${error.message}`);
}

// ---------------------------------------------------------------
// RPC
// ---------------------------------------------------------------
async function enqueue(
  userId: string,
  dedupeKey: string | null,
  payload: Record<string, unknown> = { request_id: 'x' },
  who: SupabaseClient = srAdmin,
) {
  return who.rpc('enqueue_push_notification', {
    p_user_id: userId,
    p_kind: TEST_KIND,
    p_payload: payload,
    ...(dedupeKey === null ? {} : { p_dedupe_key: dedupeKey }),
  });
}

async function enqueueCount(userId: string, dedupeKey: string | null): Promise<number> {
  const { data, error } = await enqueue(userId, dedupeKey);
  if (error) throw new Error(`enqueue_push_notification: ${error.message}`);
  return data as number;
}

async function claim(workerId: string, limit: number, who: SupabaseClient = srAdmin) {
  return who.rpc('claim_push_outbox', { p_worker_id: workerId, p_limit: limit, p_lease_seconds: LEASE_SECONDS });
}

async function claimRows(workerId: string, limit: number): Promise<OutboxRow[]> {
  const { data, error } = await claim(workerId, limit);
  if (error) throw new Error(`claim_push_outbox: ${error.message}`);
  return (data ?? []) as OutboxRow[];
}

async function complete(id: string, workerId: string, receiptId: string, who: SupabaseClient = srAdmin) {
  return who.rpc('complete_push_outbox', { p_id: id, p_worker_id: workerId, p_receipt_id: receiptId });
}

interface FailArgs {
  retryable: boolean;
  maxAttempts?: number;
  retryAfterSeconds?: number;
  code?: string;
  statusCode?: number | null;
}

async function fail(id: string, workerId: string, args: FailArgs, who: SupabaseClient = srAdmin) {
  return who.rpc('fail_push_outbox', {
    p_id: id,
    p_worker_id: workerId,
    p_error_code: args.code ?? 'expo_http_error',
    p_error_message: 'test failure',
    p_status_code: args.statusCode === undefined ? 503 : args.statusCode,
    p_retryable: args.retryable,
    p_max_attempts: args.maxAttempts ?? MAX_ATTEMPTS,
    p_retry_after_seconds: args.retryAfterSeconds ?? FIRST_RETRY_SECONDS,
  });
}

async function defer(id: string, workerId: string, until: string, who: SupabaseClient = srAdmin) {
  return who.rpc('defer_push_outbox', { p_id: id, p_worker_id: workerId, p_until: until });
}

async function claimReceipts(workerId: string, limit: number, who: SupabaseClient = srAdmin) {
  return who.rpc('claim_push_receipts', {
    p_worker_id: workerId,
    p_limit: limit,
    p_min_age_seconds: RECEIPT_MIN_AGE_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
  });
}

async function recordReceipt(
  id: string,
  workerId: string,
  status: 'ok' | 'error' | 'missing' | null,
  receiptError: string | null,
  who: SupabaseClient = srAdmin,
) {
  return who.rpc('record_push_receipt', { p_id: id, p_worker_id: workerId, p_status: status, p_error: receiptError });
}

async function cleanup(who: SupabaseClient = srAdmin) {
  return who.rpc('cleanup_push_outbox');
}

/** 42501 (permission denied)。PostgREST は表も関数も、権限が無ければこのコードで返す */
function expectPermissionDenied(result: { error: { code?: string; message?: string } | null }) {
  expect(result.error, '権限エラーになるはず').not.toBeNull();
  expect(result.error?.code).toBe('42501');
}

/**
 * 2000 年にした行の id。テストごとに消す (リースの切れた行・確認していない sent の行が、あとのテストの claim の先頭に来ないように)
 */
const seededIds: string[] = [];

/** 利用者に端末を 1 つ足し、送信待ちを 1 行積んで、claim の先頭に来るようにする。行を返す */
async function seedQueued(userId: string, label: string): Promise<OutboxRow> {
  await addDevice(userId, tokenFor(label));
  expect(await enqueueCount(userId, `seed:${label}`)).toBe(1);
  const row = (await rowsOf(userId)).find((r) => r.dedupe_key === `seed:${label}:${tokenFor(label)}`);
  if (!row) throw new Error(`seed row ${label} not found`);
  await updateRows([row.id], { next_attempt_at: oldTimestamp() });
  seededIds.push(row.id);
  return row;
}

/** seedQueued した行を worker で取る (取れたことも確かめる) */
async function seedClaimed(userId: string, label: string, workerId: string): Promise<OutboxRow> {
  const row = await seedQueued(userId, label);
  const claimed = await claimRows(workerId, 1);
  expect(claimed.map((r) => r.id)).toEqual([row.id]);
  return claimed[0];
}

// ---------------------------------------------------------------
// weekly_menu_requests (トリガー)
// ---------------------------------------------------------------
/** 異なる日付 n 日 × 3 食の target_slots */
function slotsForDays(days: number, mealsPerDay = 3): Array<Record<string, string>> {
  const meals = ['breakfast', 'lunch', 'dinner'].slice(0, mealsPerDay);
  const slots: Array<Record<string, string>> = [];
  for (let d = 0; d < days; d++) {
    const date = `2026-10-${String(19 + d).padStart(2, '0')}`;
    for (const mealType of meals) slots.push({ date, mealType });
  }
  return slots;
}

interface RequestSeed {
  status?: string;
  targetSlots?: unknown;
  mode?: string | null;
  attemptCount?: number;
  createdAt?: string;
}

async function insertRequest(userId: string, seed: RequestSeed): Promise<string> {
  const { data, error } = await srAdmin
    .from('weekly_menu_requests')
    .insert({
      user_id: userId,
      start_date: '2026-10-19',
      mode: seed.mode === undefined ? 'v5' : seed.mode,
      status: seed.status ?? 'processing',
      target_slots: seed.targetSlots === undefined ? null : seed.targetSlots,
      attempt_count: seed.attemptCount ?? 0,
      ...(seed.createdAt ? { created_at: seed.createdAt } : {}),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`weekly_menu_requests insert: ${error?.message}`);
  return data.id as string;
}

async function setRequestStatus(id: string, status: string, errorMessage: string | null = null) {
  return srAdmin.from('weekly_menu_requests').update({ status, error_message: errorMessage }).eq('id', id);
}

async function rowsForRequest(userId: string, requestId: string): Promise<OutboxRow[]> {
  return (await rowsOf(userId)).filter((r) => r.payload?.request_id === requestId);
}

// ---------------------------------------------------------------
// 共通の利用者
// ---------------------------------------------------------------
let deniedUserId: string;
let deniedUserJwt: string;

beforeAll(async () => {
  deniedUserId = await newUser('denied');
  const session = await client(anonKey).auth.signInWithPassword({
    email: `rls-1136-push-${TS}-denied@homegohan.test`,
    password: PASSWORD,
  });
  if (session.error || !session.data.session) throw new Error(`signIn: ${session.error?.message}`);
  deniedUserJwt = session.data.session.access_token;
}, 60_000);

afterEach(async () => {
  if (seededIds.length === 0) return;
  const { error } = await srAdmin.from('push_outbox').delete().in('id', seededIds.splice(0));
  if (error) throw new Error(`delete seeded push_outbox: ${error.message}`);
});

afterAll(async () => {
  // 送信待ち・端末の行・献立の依頼の行は、どれも利用者の CASCADE で消える
  for (const id of createdUserIds) await srAdmin.auth.admin.deleteUser(id);
}, 60_000);

// ================================================================
// A. 権限
// ================================================================
describe('#1136 push_outbox と RPC 8 本は service_role だけが使える', () => {
  it('anon / authenticated は表も RPC も 42501', async () => {
    const someId = '00000000-0000-0000-0000-000000000000';
    for (const who of [client(anonKey), client(anonKey, deniedUserJwt)]) {
      expectPermissionDenied(await who.from('push_outbox').select('id'));
      expectPermissionDenied(
        await who.from('push_outbox').insert({
          user_id: deniedUserId,
          push_token_id: someId,
          expo_push_token: tokenFor('denied'),
          kind: TEST_KIND,
        }),
      );
      expectPermissionDenied(await who.from('push_outbox').update({ attempts: 1 }).eq('user_id', deniedUserId));
      expectPermissionDenied(await who.from('push_outbox').delete().eq('user_id', deniedUserId));

      expectPermissionDenied(await enqueue(deniedUserId, 'denied', { request_id: 'x' }, who));
      expectPermissionDenied(await claim('w-denied', 1, who));
      expectPermissionDenied(await complete(someId, 'w-denied', 'r', who));
      expectPermissionDenied(await fail(someId, 'w-denied', { retryable: true }, who));
      expectPermissionDenied(await defer(someId, 'w-denied', later(HOUR), who));
      expectPermissionDenied(await claimReceipts('w-denied', 1, who));
      expectPermissionDenied(await recordReceipt(someId, 'w-denied', 'ok', null, who));
      expectPermissionDenied(await cleanup(who));
    }
  });
});

// ================================================================
// B. 登録 (enqueue_push_notification)
// ================================================================
describe('#1136 enqueue_push_notification', () => {
  it('enqueue は端末の行ごとに 1 行、dedupe_key で 2 回目は 0', async () => {
    const userId = await newUser('enqueue-two');
    const phoneId = await addDevice(userId, tokenFor('phone'));
    const tabletId = await addDevice(userId, tokenFor('tablet'));

    expect(await enqueueCount(userId, 'event:1')).toBe(2);
    const rows = await rowsOf(userId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.push_token_id).sort()).toEqual([phoneId, tabletId].sort());
    for (const row of rows) {
      expect(row.status).toBe('queued');
      expect(row.kind).toBe(TEST_KIND);
      expect(row.attempts).toBe(0);
      expect(row.payload).toEqual({ request_id: 'x' });
      expect(row.dedupe_key).toBe(`event:1:${row.expo_push_token}`);
      expect(row.lease_expires_at).toBeNull();
      expect(Math.abs(new Date(row.next_attempt_at).getTime() - Date.now())).toBeLessThan(CLOCK_TOLERANCE_MS);
    }

    // 同じ出来事の 2 回目は 0 行 (R-10)
    expect(await enqueueCount(userId, 'event:1')).toBe(0);
    // 別の出来事なら積む
    expect(await enqueueCount(userId, 'event:2')).toBe(2);
    // dedupe_key が NULL なら重複を見ない
    expect(await enqueueCount(userId, null)).toBe(2);
    expect(await enqueueCount(userId, null)).toBe(2);
    const all = await rowsOf(userId);
    expect(all).toHaveLength(8);
    expect(all.filter((r) => r.dedupe_key === null)).toHaveLength(4);
  });

  it('端末の行が無い利用者の enqueue は 0 行 (S-03)', async () => {
    const userId = await newUser('enqueue-none');
    expect(await enqueueCount(userId, 'event:none')).toBe(0);
    expect(await rowsOf(userId)).toEqual([]);
  });

  it('enqueue は token の長さが 1..256 を外れる端末の行を飛ばし、同じ利用者のほかの端末には積む (R-24)', async () => {
    const userId = await newUser('enqueue-long');
    const okId = await addDevice(userId, tokenFor('ok'));
    // ちょうど上限の 256 文字は積む
    const exact = 'x'.repeat(MAX_TOKEN_CHARS);
    const exactId = await addDevice(userId, exact);
    // 上限を 1 文字超える行と空の行は飛ばす (user_push_tokens には長さの CHECK が無い)
    await addDevice(userId, 'y'.repeat(MAX_TOKEN_CHARS + 1));
    await addDevice(userId, '');

    expect(await enqueueCount(userId, 'event:long')).toBe(2);
    expect((await rowsOf(userId)).map((r) => r.push_token_id).sort()).toEqual([okId, exactId].sort());
  });

  it('引数の範囲外は 22023 で拒み、行を作らない', async () => {
    const userId = await newUser('enqueue-invalid');
    await addDevice(userId, tokenFor('invalid'));
    const bad = [
      srAdmin.rpc('enqueue_push_notification', { p_user_id: userId, p_kind: 'Bad-Kind', p_payload: {} }),
      srAdmin.rpc('enqueue_push_notification', { p_user_id: userId, p_kind: TEST_KIND, p_payload: [] }),
      srAdmin.rpc('enqueue_push_notification', {
        p_user_id: userId,
        p_kind: TEST_KIND,
        p_payload: { big: 'z'.repeat(MAX_PAYLOAD_BYTES) },
      }),
      srAdmin.rpc('enqueue_push_notification', { p_user_id: userId, p_kind: TEST_KIND, p_payload: {}, p_dedupe_key: '' }),
    ];
    for (const result of await Promise.all(bad)) {
      expect(result.error?.code).toBe('22023');
    }
    expect(await rowsOf(userId)).toEqual([]);
  });
});

// ================================================================
// C. 取る・送れた・送れなかった・延期
// ================================================================
describe('#1136 claim / complete / fail / defer', () => {
  it('claim は SKIP LOCKED で 2 本が同じ行を取らない', async () => {
    const userId = await newUser('claim-race');
    const rows: OutboxRow[] = [];
    for (const label of ['race-1', 'race-2', 'race-3', 'race-4']) rows.push(await seedQueued(userId, label));
    const mine = new Set(rows.map((r) => r.id));

    const [a, b] = await Promise.all([claimRows('w-race-a', rows.length), claimRows('w-race-b', rows.length)]);
    const takenByA = a.filter((r) => mine.has(r.id)).map((r) => r.id);
    const takenByB = b.filter((r) => mine.has(r.id)).map((r) => r.id);
    // 重ならず、合わせて全部
    expect(takenByA.filter((id) => takenByB.includes(id))).toEqual([]);
    expect([...takenByA, ...takenByB].sort()).toEqual([...mine].sort());

    for (const row of await rowsOf(userId)) {
      expect(row.worker_id).toBe(takenByA.includes(row.id) ? 'w-race-a' : 'w-race-b');
      expect(row.status).toBe('queued');
      const leaseMs = new Date(row.lease_expires_at ?? 0).getTime() - Date.now();
      expect(leaseMs).toBeGreaterThan(LEASE_SECONDS * SECOND - CLOCK_TOLERANCE_MS);
      expect(leaseMs).toBeLessThan(LEASE_SECONDS * SECOND + CLOCK_TOLERANCE_MS);
    }

    // リース中の行は、次の時刻が来ていても取り直さない
    const again = await claimRows('w-race-c', rows.length);
    expect(again.filter((r) => mine.has(r.id))).toEqual([]);
  });

  it('claim は送る時刻が来ていない行を取らず、リースの切れた行は取り直す', async () => {
    const userId = await newUser('claim-time');
    const future = await seedQueued(userId, 'future');
    await updateRows([future.id], { next_attempt_at: later(HOUR) });
    const expired = await seedQueued(userId, 'lease-expired');
    await updateRows([expired.id], { lease_expires_at: ago(SECOND), worker_id: 'w-dead' });

    const taken = await claimRows('w-time', 1);
    expect(taken.map((r) => r.id)).toEqual([expired.id]);
    expect((await rowById(expired.id))?.worker_id).toBe('w-time');
    const notTaken = await rowById(future.id);
    expect(notTaken?.worker_id).toBeNull();
    expect(notTaken?.lease_expires_at).toBeNull();
  });

  it('complete は sent にして receipt の id を残し、attempts を 1 増やす', async () => {
    const userId = await newUser('complete');
    const row = await seedClaimed(userId, 'complete', 'w-complete');
    const { data, error } = await complete(row.id, 'w-complete', 'receipt-complete');
    expect(error).toBeNull();
    expect(data).toBe(true);
    const after = await rowById(row.id);
    expect(after).toMatchObject({
      status: 'sent',
      receipt_id: 'receipt-complete',
      attempts: 1,
      lease_expires_at: null,
      worker_id: null,
      last_error_code: null,
      dead_at: null,
    });
    expect(after?.sent_at).not.toBeNull();
    // sent の行をもう一度 complete しても動かない
    expect((await complete(row.id, 'w-complete', 'receipt-again')).data).toBe(false);
  });

  it('fail は retryable と回数で requeued / dead', async () => {
    const userId = await newUser('fail');

    // 1 回目: retryable → queued に戻り、次の時刻が retry_after 秒後
    const row = await seedClaimed(userId, 'fail-retry', 'w-fail');
    const first = await fail(row.id, 'w-fail', { retryable: true, retryAfterSeconds: FIRST_RETRY_SECONDS, statusCode: 503 });
    expect(first.error).toBeNull();
    expect(first.data).toBe('requeued');
    const afterFirst = await rowById(row.id);
    expect(afterFirst).toMatchObject({
      status: 'queued',
      attempts: 1,
      last_error_code: 'expo_http_error',
      last_error_message: 'test failure',
      last_status_code: 503,
      lease_expires_at: null,
      worker_id: null,
      dead_at: null,
    });
    const waitMs = new Date(afterFirst?.next_attempt_at ?? 0).getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(FIRST_RETRY_SECONDS * SECOND - CLOCK_TOLERANCE_MS);
    expect(waitMs).toBeLessThan(FIRST_RETRY_SECONDS * SECOND + CLOCK_TOLERANCE_MS);

    // 2 回目: retryable でも回数を使い切れば dead (上限 2 で試す)
    await updateRows([row.id], { next_attempt_at: oldTimestamp() });
    expect((await claimRows('w-fail', 1)).map((r) => r.id)).toEqual([row.id]);
    const second = await fail(row.id, 'w-fail', { retryable: true, maxAttempts: 2 });
    expect(second.data).toBe('dead');
    const afterSecond = await rowById(row.id);
    expect(afterSecond).toMatchObject({ status: 'dead', attempts: 2, worker_id: null, lease_expires_at: null, sent_at: null });
    expect(afterSecond?.dead_at).not.toBeNull();

    // 非 retryable は 1 回目でも dead (Expo の名前のまま。メッセージは 500 文字で切る)
    const other = await seedClaimed(userId, 'fail-final', 'w-fail');
    const final = await srAdmin.rpc('fail_push_outbox', {
      p_id: other.id,
      p_worker_id: 'w-fail',
      p_error_code: 'DeviceNotRegistered',
      p_error_message: 'm'.repeat(600),
      p_status_code: null,
      p_retryable: false,
      p_max_attempts: MAX_ATTEMPTS,
      p_retry_after_seconds: FIRST_RETRY_SECONDS,
    });
    expect(final.data).toBe('dead');
    const afterFinal = await rowById(other.id);
    expect(afterFinal).toMatchObject({ status: 'dead', attempts: 1, last_error_code: 'DeviceNotRegistered', last_status_code: null });
    expect(afterFinal?.last_error_message).toHaveLength(500);
  });

  it('defer は attempts を増やさない', async () => {
    const userId = await newUser('defer');
    const row = await seedClaimed(userId, 'defer', 'w-defer');
    const until = later(8 * HOUR);
    const { data, error } = await defer(row.id, 'w-defer', until);
    expect(error).toBeNull();
    expect(data).toBe(true);
    const after = await rowById(row.id);
    expect(after).toMatchObject({ status: 'queued', attempts: 0, lease_expires_at: null, worker_id: null });
    expect(new Date(after?.next_attempt_at ?? 0).getTime()).toBe(new Date(until).getTime());

    // 今より前・2 日より先は 22023
    await updateRows([row.id], { next_attempt_at: oldTimestamp() });
    expect((await claimRows('w-defer', 1)).map((r) => r.id)).toEqual([row.id]);
    expect((await defer(row.id, 'w-defer', ago(MINUTE))).error?.code).toBe('22023');
    expect((await defer(row.id, 'w-defer', later(3 * DAY))).error?.code).toBe('22023');
  });

  it('complete / fail / defer / record は別の worker_id では false / ignored', async () => {
    const userId = await newUser('other-worker');
    const row = await seedClaimed(userId, 'other-worker', 'w-own');

    expect((await complete(row.id, 'w-other', 'r')).data).toBe(false);
    expect((await fail(row.id, 'w-other', { retryable: true })).data).toBe('ignored');
    expect((await defer(row.id, 'w-other', later(HOUR))).data).toBe(false);
    const unchanged = await rowById(row.id);
    expect(unchanged).toMatchObject({ status: 'queued', attempts: 0, worker_id: 'w-own', last_error_code: null });

    // 消えた行 (端末の行の削除と競合) も false / ignored
    const missingId = '00000000-0000-0000-0000-000000000001';
    expect((await complete(missingId, 'w-own', 'r')).data).toBe(false);
    expect((await fail(missingId, 'w-own', { retryable: false })).data).toBe('ignored');
    expect((await defer(missingId, 'w-own', later(HOUR))).data).toBe(false);

    // receipt: 取った worker でなければ記録しない
    expect((await complete(row.id, 'w-own', 'receipt-other')).data).toBe(true);
    await updateRows([row.id], { sent_at: oldTimestamp() });
    const claimed = (await claimReceipts('w-own', 1)).data as OutboxRow[];
    expect(claimed.map((r) => r.id)).toEqual([row.id]);
    expect((await recordReceipt(row.id, 'w-other', 'ok', null)).data).toBe(false);
    expect((await rowById(row.id))?.receipt_checked_at).toBeNull();
    // queued の行には receipt を記録しない
    const queued = await seedClaimed(userId, 'other-worker-queued', 'w-own');
    expect((await recordReceipt(queued.id, 'w-own', 'ok', null)).data).toBe(false);
  });
});

// ================================================================
// D. receipt
// ================================================================
describe('#1136 claim_push_receipts / record_push_receipt', () => {
  it('receipt の claim と record', async () => {
    const userId = await newUser('receipt');
    const ids: string[] = [];
    for (const label of ['receipt-ok', 'receipt-error', 'receipt-pending']) {
      const row = await seedClaimed(userId, label, 'w-receipt');
      expect((await complete(row.id, 'w-receipt', `ticket-${label}`)).data).toBe(true);
      ids.push(row.id);
    }
    const [okId, errorId, pendingId] = ids;

    // 送ったばかりの行は取らない (sent_at が 15 分以内)
    const fresh = ((await claimReceipts('w-receipt', ids.length)).data ?? []) as OutboxRow[];
    expect(fresh.filter((r) => ids.includes(r.id))).toEqual([]);

    // 15 分以上たった行は古い順に取る
    for (const id of ids) await updateRows([id], { sent_at: oldTimestamp() });
    const claimed = ((await claimReceipts('w-receipt', ids.length)).data ?? []) as OutboxRow[];
    expect(claimed.map((r) => r.id)).toEqual(ids);
    for (const row of claimed) expect(row.worker_id).toBe('w-receipt');
    // リース中は取り直さない
    const again = ((await claimReceipts('w-receipt-2', ids.length)).data ?? []) as OutboxRow[];
    expect(again.filter((r) => ids.includes(r.id))).toEqual([]);

    // ok / error は記録して確認を終える (error は 128 文字で切る)
    expect((await recordReceipt(okId, 'w-receipt', 'ok', null)).data).toBe(true);
    expect((await recordReceipt(errorId, 'w-receipt', 'error', 'D'.repeat(200))).data).toBe(true);
    // まだ無い (NULL) はリースだけ外す
    expect((await recordReceipt(pendingId, 'w-receipt', null, 'ignored')).data).toBe(true);

    const ok = await rowById(okId);
    expect(ok).toMatchObject({ status: 'sent', receipt_status: 'ok', receipt_error: null, worker_id: null, lease_expires_at: null });
    expect(ok?.receipt_checked_at).not.toBeNull();
    const err = await rowById(errorId);
    expect(err).toMatchObject({ status: 'sent', receipt_status: 'error' });
    expect(err?.receipt_error).toHaveLength(128);
    const pending = await rowById(pendingId);
    expect(pending).toMatchObject({
      status: 'sent',
      receipt_status: null,
      receipt_checked_at: null,
      receipt_error: null,
      worker_id: null,
      lease_expires_at: null,
    });

    // 確認を終えた行は取らず、まだの行は次の回でまた取る。24 時間を超えたら missing で終える
    const next = ((await claimReceipts('w-receipt', ids.length)).data ?? []) as OutboxRow[];
    expect(next.filter((r) => ids.includes(r.id)).map((r) => r.id)).toEqual([pendingId]);
    expect((await recordReceipt(pendingId, 'w-receipt', 'missing', null)).data).toBe(true);
    expect((await rowById(pendingId))?.receipt_status).toBe('missing');
    // 確認を終えた行にはもう記録しない
    expect((await recordReceipt(okId, 'w-receipt', 'error', 'x')).data).toBe(false);
    // 状態の値の誤りは 22023
    const bogus = await srAdmin.rpc('record_push_receipt', { p_id: okId, p_worker_id: 'w-receipt', p_status: 'bogus', p_error: null });
    expect(bogus.error?.code).toBe('22023');
  });
});

// ================================================================
// E. 端末の行の削除・退会
// ================================================================
describe('#1136 端末の行の削除・退会で送信待ちが消える', () => {
  it('端末の行の削除 (ログアウト・claim・release と同じ操作) で queued の行が消える (S-11)', async () => {
    const userId = await newUser('logout');
    const phoneId = await addDevice(userId, tokenFor('logout-phone'));
    await addDevice(userId, tokenFor('logout-tablet'));
    expect(await enqueueCount(userId, 'event:logout')).toBe(2);

    const { error } = await srAdmin.from('user_push_tokens').delete().eq('id', phoneId);
    expect(error).toBeNull();
    const rest = await rowsOf(userId);
    expect(rest).toHaveLength(1);
    expect(rest[0].expo_push_token).toBe(tokenFor('logout-tablet'));
  });

  it('auth.users の削除 (退会) で push_outbox の行が消える (S-12)', async () => {
    const userId = await newUser('withdraw');
    await addDevice(userId, tokenFor('withdraw'));
    expect(await enqueueCount(userId, 'event:withdraw')).toBe(1);
    expect(await rowsOf(userId)).toHaveLength(1);

    const { error } = await srAdmin.auth.admin.deleteUser(userId);
    expect(error).toBeNull();
    expect(await rowsOf(userId)).toEqual([]);
    const { data: devices } = await srAdmin.from('user_push_tokens').select('id').eq('user_id', userId);
    expect(devices).toEqual([]);
  });
});

// ================================================================
// F. トリガー (weekly_menu_requests の最終の status)
// ================================================================
describe('#1136 トリガー weekly_menu_requests_enqueue_push', () => {
  let userId: string;
  let token: string;

  beforeAll(async () => {
    userId = await newUser('trigger');
    token = tokenFor('trigger');
    await addDevice(userId, token);
  }, 60_000);

  it('2 日以上の target_slots の行を completed にするとトリガーが 1 行積む (failed も。pending → processing では積まない。S-01)', async () => {
    const completedId = await insertRequest(userId, { status: 'pending', targetSlots: slotsForDays(7), mode: 'weekly' });
    // pending → processing では積まない
    expect((await setRequestStatus(completedId, 'processing')).error).toBeNull();
    expect(await rowsForRequest(userId, completedId)).toEqual([]);

    expect((await setRequestStatus(completedId, 'completed')).error).toBeNull();
    const completedRows = await rowsForRequest(userId, completedId);
    expect(completedRows).toHaveLength(1);
    expect(completedRows[0]).toMatchObject({
      status: 'queued',
      kind: 'weekly_menu_completed',
      expo_push_token: token,
      dedupe_key: `weekly_menu_result:${completedId}:${token}`,
      payload: { request_id: completedId, start_date: '2026-10-19', mode: 'weekly' },
    });

    const failedId = await insertRequest(userId, { targetSlots: slotsForDays(2, 1) });
    expect((await setRequestStatus(failedId, 'failed', 'ai_consent_required')).error).toBeNull();
    const failedRows = await rowsForRequest(userId, failedId);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]).toMatchObject({ kind: 'weekly_menu_failed', payload: { request_id: failedId, mode: 'v5' } });

    // error_message が NULL の failed も積む
    const nullMessageId = await insertRequest(userId, { targetSlots: slotsForDays(3) });
    expect((await setRequestStatus(nullMessageId, 'failed', null)).error).toBeNull();
    expect(await rowsForRequest(userId, nullMessageId)).toHaveLength(1);
  });

  it('中止 (中止しました) と止まった行の印 (stale_request_timeout) の failed では積まない (S-19・S-22)', async () => {
    const cancelledId = await insertRequest(userId, { targetSlots: slotsForDays(7) });
    expect((await setRequestStatus(cancelledId, 'failed', '中止しました')).error).toBeNull();
    const staleId = await insertRequest(userId, { targetSlots: slotsForDays(7) });
    expect((await setRequestStatus(staleId, 'failed', 'stale_request_timeout')).error).toBeNull();

    expect(await rowsForRequest(userId, cancelledId)).toEqual([]);
    expect(await rowsForRequest(userId, staleId)).toEqual([]);
  });

  it('attempt_limit_exceeded の failed (claim_menu_request) では積む (S-22)', async () => {
    // claim_menu_request は回数を使い切った queued の行を failed (attempt_limit_exceeded) にする (SECURITY DEFINER の関数の中の UPDATE)
    const queuedId = await insertRequest(userId, {
      status: 'queued',
      targetSlots: slotsForDays(3),
      attemptCount: 3,
      createdAt: oldTimestamp(),
    });
    const { error } = await srAdmin.rpc('claim_menu_request', { p_worker_id: `rls-1136-${TS}` });
    expect(error).toBeNull();

    const { data: request } = await srAdmin.from('weekly_menu_requests').select('status, error_message').eq('id', queuedId).single();
    expect(request).toEqual({ status: 'failed', error_message: 'attempt_limit_exceeded' });
    const rows = await rowsForRequest(userId, queuedId);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('weekly_menu_failed');
  });

  it('target_slots が 1 日 (1 食・1 日 3 食) / NULL の completed では積まない (S-20・S-21)', async () => {
    const oneMealId = await insertRequest(userId, { targetSlots: slotsForDays(1, 1) });
    const oneDayId = await insertRequest(userId, { targetSlots: slotsForDays(1) });
    const noSlotsId = await insertRequest(userId, { status: 'pending', targetSlots: null });
    // date の無い要素だけの配列は 0 日、配列でない値も積まない
    const noDateId = await insertRequest(userId, { targetSlots: [{ mealType: 'lunch' }, { mealType: 'dinner' }] });
    const objectSlotsId = await insertRequest(userId, { targetSlots: { date: '2026-10-19' } });

    for (const id of [oneMealId, oneDayId, noSlotsId, noDateId, objectSlotsId]) {
      expect((await setRequestStatus(id, 'completed')).error).toBeNull();
      expect(await rowsForRequest(userId, id)).toEqual([]);
    }
  });

  it('completed のあと failed に書き換えても 2 行目は作られない (R-10)', async () => {
    const id = await insertRequest(userId, { targetSlots: slotsForDays(7) });
    expect((await setRequestStatus(id, 'completed')).error).toBeNull();
    expect((await setRequestStatus(id, 'failed', 'generation_failed')).error).toBeNull();
    const rows = await rowsForRequest(userId, id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('weekly_menu_completed');
  });

  it('enqueue が失敗しても weekly_menu_requests の更新は成功し行は 0 (2 日以上の target_slots の行の mode に 2,048 バイトを超える文字列を入れて payload の上限で失敗させる。R-02)', async () => {
    const id = await insertRequest(userId, { targetSlots: slotsForDays(7), mode: 'm'.repeat(MAX_PAYLOAD_BYTES + 1) });
    const { error } = await setRequestStatus(id, 'completed');
    expect(error).toBeNull();
    const { data: request } = await srAdmin.from('weekly_menu_requests').select('status').eq('id', id).single();
    expect(request?.status).toBe('completed');
    expect(await rowsForRequest(userId, id)).toEqual([]);
  });
});

// ================================================================
// G. 掃除
// ================================================================
describe('#1136 cleanup_push_outbox', () => {
  it('cleanup は期限の行だけ消す', async () => {
    const userId = await newUser('cleanup-retention');
    const labels = ['sent-old', 'sent-new', 'dead-old', 'dead-new'] as const;
    const ids: Record<(typeof labels)[number], string> = { 'sent-old': '', 'sent-new': '', 'dead-old': '', 'dead-new': '' };
    for (const label of labels) ids[label] = (await seedQueued(userId, label)).id;

    await updateRows([ids['sent-old']], { status: 'sent', sent_at: ago(8 * DAY), receipt_id: 'r-old' });
    await updateRows([ids['sent-new']], { status: 'sent', sent_at: ago(6 * DAY), receipt_id: 'r-new' });
    await updateRows([ids['dead-old']], { status: 'dead', dead_at: ago(31 * DAY) });
    await updateRows([ids['dead-new']], { status: 'dead', dead_at: ago(29 * DAY) });

    const { data, error } = await cleanup();
    expect(error).toBeNull();
    const [summary] = data as Array<{ expired: number; sent_deleted: number; dead_deleted: number }>;
    expect(summary.sent_deleted).toBeGreaterThanOrEqual(1);
    expect(summary.dead_deleted).toBeGreaterThanOrEqual(1);

    expect(await rowById(ids['sent-old'])).toBeNull();
    expect(await rowById(ids['dead-old'])).toBeNull();
    expect((await rowById(ids['sent-new']))?.status).toBe('sent');
    expect((await rowById(ids['dead-new']))?.status).toBe('dead');
  });

  it('cleanup は 24 時間を超えたリースの無い queued を expired の dead にし、リース中の行と 24 時間以内の行は触らない (S-07)', async () => {
    const userId = await newUser('cleanup-expired');
    const stale = await seedQueued(userId, 'stale');
    const leased = await seedQueued(userId, 'stale-leased');
    const leaseLapsed = await seedQueued(userId, 'stale-lease-lapsed');
    const recent = await seedQueued(userId, 'recent');
    // 掃除の前の回で attempts を使っていても、expired は attempts を変えない
    await updateRows([stale.id], { created_at: ago(25 * HOUR), attempts: 1, last_error_code: 'network_error' });
    await updateRows([leased.id], { created_at: ago(25 * HOUR), lease_expires_at: later(MINUTE), worker_id: 'w-busy' });
    await updateRows([leaseLapsed.id], { created_at: ago(25 * HOUR), lease_expires_at: ago(MINUTE), worker_id: 'w-gone' });
    await updateRows([recent.id], { created_at: ago(23 * HOUR) });

    const { data, error } = await cleanup();
    expect(error).toBeNull();
    const [summary] = data as Array<{ expired: number; sent_deleted: number; dead_deleted: number }>;
    expect(summary.expired).toBeGreaterThanOrEqual(2);

    const expired = await rowById(stale.id);
    expect(expired).toMatchObject({
      status: 'dead',
      last_error_code: 'expired',
      last_error_message: 'expired',
      attempts: 1,
      worker_id: null,
      lease_expires_at: null,
    });
    expect(expired?.dead_at).not.toBeNull();
    expect(await rowById(leaseLapsed.id)).toMatchObject({ status: 'dead', last_error_code: 'expired', worker_id: null });
    expect(await rowById(leased.id)).toMatchObject({ status: 'queued', worker_id: 'w-busy', last_error_code: null });
    expect(await rowById(recent.id)).toMatchObject({ status: 'queued', last_error_code: null });
  });
});
