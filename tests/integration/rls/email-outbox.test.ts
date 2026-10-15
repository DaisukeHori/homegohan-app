/**
 * #1193 / #1708 段 A: メールの送信待ち (email_outbox) の DB 側の部品の回帰テスト (実 DB)
 *   public.email_outbox / claim_email_outbox / complete_email_outbox / fail_email_outbox / requeue_email_outbox /
 *   email_outbox_dead_counts / cleanup_email_outbox / mark_email_outbox_dead_alerted / unmark_email_outbox_dead_alerted /
 *   prepare_account_deletion の段 1b・1c / pg_cron の cleanup-email-outbox
 *   (supabase/migrations/20261016234000_email_outbox.sql。正典: docs/design/operator/10-logs-and-mail-retry.md §5)
 *
 * 期待する挙動 (設計書 §5・§7.3・§12):
 *   - 表も RPC 8 本も service_role だけ。anon / authenticated は 42501
 *   - claim: queued で next_attempt_at を過ぎ、リースの無い (切れた) 行だけを取り、worker_id とリースを付ける。
 *     同時に呼んでも同じ行は 1 本だけが取る (FOR UPDATE SKIP LOCKED)
 *   - complete / fail は worker_id と status = 'queued' のガードで、別の worker・伏せられた行には効かない
 *   - fail は再試行するか dead にするかを決め、redact_after_send の行は dead にするときだけ伏せる
 *   - dead_counts / mark / unmark は窓を持たず、まだ知らせていない dead を数え、印を付け、同じ印だけを外す
 *   - cleanup は sent 7 日・dead 30 日で消し、queued は残す
 *   - prepare_account_deletion は本人の行を伏せて queued を dead (recipient_deleted) にし (1b)、
 *     他人宛の行の件名・本文・HTML・返信先の本人のアドレスだけを伏せる (1c。状態・リース・鍵は変えない)
 *
 * 自分が入れた行は template の接頭辞 (TPL_PREFIX) と、作った行の id の一覧で識別し、終了時に消す。
 * claim は表の全体から取るので、取らせたい行の next_attempt_at を 2000 年にして先頭に並べ、取らせたくない行は遠い未来にする。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/email-outbox.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

/** ローカルスタックの postgres-meta で SQL を実行する (カタログの確認と、時刻を過去にずらす書き換えにだけ使う) */
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

/** SQL の文字列リテラル (テストが作る値だけを渡す) */
const q = (value: string) => `'${value.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------
// 目印・定数
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = `TestPass!2026-outbox-${TS}`;
/** この実行で入れた行の template の接頭辞 (後片付けの目印) */
const TPL_PREFIX = `rls1708-${TS}-`;
const tpl = (label: string) => `${TPL_PREFIX}${label}`;
/** 運用メールの template (ops_ で始まる。dead の通知で数えない) */
const OPS_TPL = `ops_rls1708_${TS}`;
const MASKED_EMAIL = 'redacted@redacted.invalid';
const MASKED_TEXT = '[redacted]';
const OTHER_EMAIL = `rls1708-other-${TS}@homegohan.test`;
const FROM_EMAIL = 'noreply@homegohan.test';
/** claim に取らせたい行の next_attempt_at (表の中で先頭に並ぶ過去) と、取らせたくない行の next_attempt_at (遠い未来) */
const LONG_AGO = (second: number) => `2000-01-01T00:00:${String(second).padStart(2, '0')}+00:00`;
const FAR_FUTURE = '2999-01-01T00:00:00+00:00';
const DAY_MS = 24 * 60 * 60 * 1000;
/** fail_email_outbox に渡す試行の上限 (設計書 §6.1 の既定) と、再試行の待ち (1 回目の失敗のあと 60 秒) */
const MAX_ATTEMPTS = 6;
const RETRY_AFTER_SECONDS = 60;
const LEASE_SECONDS = 120;

const createdIds: string[] = [];
const createdUserIds: string[] = [];

interface OutboxRow {
  id: string;
  status: 'queued' | 'sent' | 'dead';
  template: string;
  to_email: string;
  from_email: string;
  reply_to: string | null;
  subject: string;
  text_body: string;
  html_body: string | null;
  user_id: string | null;
  idempotency_key: string;
  redact_after_send: boolean;
  attempts: number;
  requeue_count: number;
  next_attempt_at: string;
  lease_expires_at: string | null;
  worker_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_status_code: number | null;
  sent_at: string | null;
  resend_message_id: string | null;
  dead_at: string | null;
  requeued_at: string | null;
  dead_alerted_at: string | null;
  updated_at: string;
  created_at: string;
}

interface CountRow {
  template: string;
  dead_count: number;
  total_count: number;
}

type Insert = Partial<OutboxRow> & { template: string };

/** service_role で行を入れて、入った行を返す。既定は「誰も取らない queued」(next_attempt_at が遠い未来) */
async function insertRow(row: Insert): Promise<OutboxRow> {
  const { data, error } = await srAdmin
    .from('email_outbox')
    .insert({
      to_email: OTHER_EMAIL,
      from_email: FROM_EMAIL,
      subject: 'subject',
      text_body: 'body',
      idempotency_key: randomUUID(),
      next_attempt_at: FAR_FUTURE,
      ...row,
    })
    .select('*')
    .single();
  // 握りつぶすと、行が入らないままテストが空振りで通る
  if (error || !data) throw new Error(`insert email_outbox: ${error?.message}`);
  const inserted = data as OutboxRow;
  createdIds.push(inserted.id);
  return inserted;
}

async function insertDead(row: Insert): Promise<OutboxRow> {
  return insertRow({ status: 'dead', dead_at: new Date().toISOString(), ...row });
}

async function getRow(id: string): Promise<OutboxRow> {
  const { data, error } = await srAdmin.from('email_outbox').select('*').eq('id', id).single();
  if (error || !data) throw new Error(`select email_outbox: ${error?.message}`);
  return data as OutboxRow;
}

async function rowExists(id: string): Promise<boolean> {
  const { data, error } = await srAdmin.from('email_outbox').select('id').eq('id', id);
  if (error) throw new Error(`select email_outbox: ${error.message}`);
  return (data ?? []).length > 0;
}

/** 時刻の列を SQL で書き換える (RPC の now() と比べる状態を作る) */
async function setColumns(id: string, assignments: string): Promise<void> {
  await pgQuery(`update public.email_outbox set ${assignments} where id = ${q(id)}`);
}

function asCountRows(data: unknown): CountRow[] {
  expect(Array.isArray(data)).toBe(true);
  return data as CountRow[];
}

const countOf = (rows: CountRow[], template: string) => rows.find((r) => r.template === template)?.dead_count;

/** 権利の時刻の代わりに使う、この実行だけの時刻 (unmark は時刻の一致で外すので、実行ごとに重ならない値にする) */
let alertedSeq = 0;
function alertedAt(): string {
  alertedSeq += 1;
  return new Date(Date.UTC(2001, 0, 1) + (TS % DAY_MS) + alertedSeq * 1000).toISOString();
}

/** 42501 (permission denied)。PostgREST は表も関数も、権限が無ければこのコードで返す */
function expectPermissionDenied(result: { error: { code?: string } | null }, label: string) {
  expect(result.error, `${label} は権限エラーになるはず`).not.toBeNull();
  expect(result.error?.code, label).toBe('42501');
}

function expect22023(result: { error: { code?: string } | null }, label: string) {
  expect(result.error, `${label} は 22023 になるはず`).not.toBeNull();
  expect(result.error?.code, label).toBe('22023');
}

async function claim(workerId: string, limit: number, who: SupabaseClient = srAdmin) {
  return who.rpc('claim_email_outbox', { p_worker_id: workerId, p_limit: limit, p_lease_seconds: LEASE_SECONDS });
}

async function fail(id: string, workerId: string, retryable: boolean | null, maxAttempts = MAX_ATTEMPTS) {
  return srAdmin.rpc('fail_email_outbox', {
    p_id: id,
    p_worker_id: workerId,
    p_error_code: 'service_unavailable',
    p_error_message: 'r***@homegohan.test への送信に失敗しました',
    p_status_code: 503,
    p_retryable: retryable,
    p_max_attempts: maxAttempts,
    p_retry_after_seconds: RETRY_AFTER_SECONDS,
  });
}

/** 行を claim させた状態 (worker_id とリース) を直接作る (claim の取り合いに他の行を巻き込まない) */
async function lease(id: string, workerId: string): Promise<void> {
  await setColumns(id, `worker_id = ${q(workerId)}, lease_expires_at = now() + interval '120 seconds'`);
}

async function createUser(label: string): Promise<{ id: string; email: string }> {
  const email = `rls1708-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email };
}

async function purge() {
  await srAdmin.from('email_outbox').delete().like('template', `${TPL_PREFIX}%`);
  await srAdmin.from('email_outbox').delete().eq('template', OPS_TPL);
  if (createdIds.length > 0) await srAdmin.from('email_outbox').delete().in('id', createdIds);
}

let userJwt: string;

beforeAll(async () => {
  // 前回の実行が途中で止まっていた場合の取り残しを先に消す (表がまだ無いときの削除エラーは、ここでは無視する)
  await purge().catch(() => {});
  const user = await createUser('authn');
  const signIn = await client(anonKey).auth.signInWithPassword({ email: user.email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
  userJwt = signIn.data.session.access_token;
}, 60_000);

afterAll(async () => {
  await purge();
  for (const userId of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
}, 60_000);

// ---------------------------------------------------------------
// 権限
// ---------------------------------------------------------------
describe('#1193 email_outbox: 権限', () => {
  it('anon / authenticated は表も RPC も 42501', async () => {
    const callers: Array<[string, SupabaseClient]> = [
      ['anon', client(anonKey)],
      ['authenticated', client(anonKey, userJwt)],
    ];
    const id = randomUUID();
    const at = alertedAt();
    for (const [role, who] of callers) {
      expectPermissionDenied(await who.from('email_outbox').select('id').limit(1), `${role} の SELECT`);
      expectPermissionDenied(
        await who.from('email_outbox').insert({
          template: tpl('denied'),
          to_email: OTHER_EMAIL,
          from_email: FROM_EMAIL,
          subject: 's',
          text_body: 'b',
          idempotency_key: randomUUID(),
        }),
        `${role} の INSERT`,
      );
      expectPermissionDenied(await claim('w-denied', 1, who), `${role} の claim_email_outbox`);
      expectPermissionDenied(
        await who.rpc('complete_email_outbox', { p_id: id, p_worker_id: 'w', p_resend_message_id: 'm' }),
        `${role} の complete_email_outbox`,
      );
      expectPermissionDenied(
        await who.rpc('fail_email_outbox', {
          p_id: id,
          p_worker_id: 'w',
          p_error_code: 'x',
          p_error_message: 'x',
          p_status_code: null,
          p_retryable: true,
          p_max_attempts: MAX_ATTEMPTS,
          p_retry_after_seconds: RETRY_AFTER_SECONDS,
        }),
        `${role} の fail_email_outbox`,
      );
      expectPermissionDenied(await who.rpc('requeue_email_outbox', { p_id: id }), `${role} の requeue_email_outbox`);
      expectPermissionDenied(await who.rpc('email_outbox_dead_counts', { p_limit: 10 }), `${role} の email_outbox_dead_counts`);
      expectPermissionDenied(await who.rpc('cleanup_email_outbox'), `${role} の cleanup_email_outbox`);
      expectPermissionDenied(
        await who.rpc('mark_email_outbox_dead_alerted', { p_alerted_at: at, p_limit: 10 }),
        `${role} の mark_email_outbox_dead_alerted`,
      );
      expectPermissionDenied(
        await who.rpc('unmark_email_outbox_dead_alerted', { p_alerted_at: at }),
        `${role} の unmark_email_outbox_dead_alerted`,
      );
    }
    // 権限エラーの間に行が入っていない
    const { data } = await srAdmin.from('email_outbox').select('id').eq('template', tpl('denied'));
    expect(data ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------
// claim
// ---------------------------------------------------------------
describe('#1193 claim_email_outbox', () => {
  it('next_attempt_at とリースを見て取る (期日前・リース中・queued でない行は取らない。リースの切れた行は取り直す)', async () => {
    const due = await insertRow({ template: tpl('claim-due'), next_attempt_at: LONG_AGO(1) });
    const leased = await insertRow({ template: tpl('claim-leased'), next_attempt_at: LONG_AGO(2) });
    await setColumns(leased.id, `worker_id = 'w-other', lease_expires_at = now() + interval '1 hour'`);
    const expired = await insertRow({ template: tpl('claim-expired'), next_attempt_at: LONG_AGO(3) });
    await setColumns(expired.id, `worker_id = 'w-old', lease_expires_at = now() - interval '1 second'`);
    const sent = await insertRow({ template: tpl('claim-sent'), status: 'sent', sent_at: new Date().toISOString(), next_attempt_at: LONG_AGO(4) });
    const notYet = await insertRow({ template: tpl('claim-not-yet') });

    const before = Date.now();
    const { data, error } = await claim('w-claim', 2);
    expect(error).toBeNull();
    const rows = data as OutboxRow[];
    expect(rows.map((r) => r.id).sort()).toEqual([due.id, expired.id].sort());
    for (const row of rows) {
      expect(row.worker_id).toBe('w-claim');
      const leaseMs = Date.parse(row.lease_expires_at ?? '') - before;
      // リースは now + 120 秒 (時計のずれを 30 秒まで見込む)
      expect(leaseMs).toBeGreaterThan((LEASE_SECONDS - 30) * 1000);
      expect(leaseMs).toBeLessThan((LEASE_SECONDS + 30) * 1000);
      expect(row.status).toBe('queued');
      expect(row.attempts).toBe(0);
    }
    expect((await getRow(leased.id)).worker_id).toBe('w-other');
    expect((await getRow(sent.id)).worker_id).toBeNull();
    expect((await getRow(notYet.id)).worker_id).toBeNull();

    // 取った行は、リースが切れるまで次の claim に取られない
    for (const row of [due, expired]) await setColumns(row.id, `next_attempt_at = ${q(FAR_FUTURE)}`);
  });

  it('同時に呼んでも同じ行は 1 本だけが取る (SKIP LOCKED)', async () => {
    const rows: OutboxRow[] = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push(await insertRow({ template: tpl(`claim-race-${i}`), next_attempt_at: LONG_AGO(10 + i) }));
    }
    const mine = new Set(rows.map((r) => r.id));
    const [a, b] = await Promise.all([claim('w-race-a', rows.length), claim('w-race-b', rows.length)]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const idsA = (a.data as OutboxRow[]).map((r) => r.id).filter((id) => mine.has(id));
    const idsB = (b.data as OutboxRow[]).map((r) => r.id).filter((id) => mine.has(id));
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect([...idsA, ...idsB].sort()).toEqual([...mine].sort());
    for (const id of idsA) expect((await getRow(id)).worker_id).toBe('w-race-a');
    for (const id of idsB) expect((await getRow(id)).worker_id).toBe('w-race-b');
    for (const row of rows) await setColumns(row.id, `next_attempt_at = ${q(FAR_FUTURE)}`);
  });

  it('worker_id が空・limit / lease が範囲外なら 22023', async () => {
    expect22023(await srAdmin.rpc('claim_email_outbox', { p_worker_id: ' ', p_limit: 1, p_lease_seconds: LEASE_SECONDS }), '空の worker_id');
    expect22023(await srAdmin.rpc('claim_email_outbox', { p_worker_id: 'w', p_limit: 0, p_lease_seconds: LEASE_SECONDS }), 'limit 0');
    expect22023(await srAdmin.rpc('claim_email_outbox', { p_worker_id: 'w', p_limit: 101, p_lease_seconds: LEASE_SECONDS }), 'limit 101');
    expect22023(await srAdmin.rpc('claim_email_outbox', { p_worker_id: 'w', p_limit: 1, p_lease_seconds: 9 }), 'lease 9');
    expect22023(await srAdmin.rpc('claim_email_outbox', { p_worker_id: 'w', p_limit: 1, p_lease_seconds: 3601 }), 'lease 3601');
  });
});

// ---------------------------------------------------------------
// complete / fail
// ---------------------------------------------------------------
describe('#1193 complete_email_outbox', () => {
  it('worker_id が違えば false で何も変えない。一致すれば sent にし、redact_after_send でない行は本文を残す', async () => {
    const row = await insertRow({ template: tpl('complete'), subject: '件名', text_body: '本文', html_body: '<p>本文</p>' });
    await lease(row.id, 'w-complete');

    const wrong = await srAdmin.rpc('complete_email_outbox', { p_id: row.id, p_worker_id: 'w-wrong', p_resend_message_id: 'msg-1' });
    expect(wrong.error).toBeNull();
    expect(wrong.data).toBe(false);
    expect((await getRow(row.id)).status).toBe('queued');

    const ok = await srAdmin.rpc('complete_email_outbox', { p_id: row.id, p_worker_id: 'w-complete', p_resend_message_id: 'msg-1' });
    expect(ok.error).toBeNull();
    expect(ok.data).toBe(true);
    const after = await getRow(row.id);
    expect(after).toMatchObject({
      status: 'sent',
      attempts: 1,
      resend_message_id: 'msg-1',
      worker_id: null,
      lease_expires_at: null,
      dead_at: null,
      to_email: OTHER_EMAIL,
      subject: '件名',
      text_body: '本文',
      html_body: '<p>本文</p>',
    });
    expect(after.sent_at).not.toBeNull();

    // もう sent なので、同じ worker でも 2 回目は false
    const again = await srAdmin.rpc('complete_email_outbox', { p_id: row.id, p_worker_id: 'w-complete', p_resend_message_id: 'msg-2' });
    expect(again.data).toBe(false);
  });

  it('redact_after_send の行は、送れたときに宛先・件名・本文を伏せる', async () => {
    const row = await insertRow({ template: tpl('complete-redact'), redact_after_send: true, html_body: '<p>x</p>' });
    await lease(row.id, 'w-redact');
    const ok = await srAdmin.rpc('complete_email_outbox', { p_id: row.id, p_worker_id: 'w-redact', p_resend_message_id: 'msg-r' });
    expect(ok.data).toBe(true);
    expect(await getRow(row.id)).toMatchObject({
      status: 'sent',
      to_email: MASKED_EMAIL,
      subject: MASKED_TEXT,
      text_body: MASKED_TEXT,
      html_body: null,
    });
  });
});

describe('#1193 fail_email_outbox', () => {
  it('retryable で回数内なら queued のまま次の時刻を進め、回数切れ・非 retryable なら dead', async () => {
    const retry = await insertRow({ template: tpl('fail-retry') });
    await lease(retry.id, 'w-fail');
    const before = Date.now();
    const r1 = await fail(retry.id, 'w-fail', true);
    expect(r1.error).toBeNull();
    expect(r1.data).toBe('queued');
    const queued = await getRow(retry.id);
    expect(queued).toMatchObject({
      status: 'queued',
      attempts: 1,
      dead_at: null,
      worker_id: null,
      lease_expires_at: null,
      last_error_code: 'service_unavailable',
      last_status_code: 503,
    });
    const waitMs = Date.parse(queued.next_attempt_at) - before;
    expect(waitMs).toBeGreaterThan((RETRY_AFTER_SECONDS - 30) * 1000);
    expect(waitMs).toBeLessThan((RETRY_AFTER_SECONDS + 30) * 1000);

    // 回数切れ: attempts が max - 1 の行の失敗は dead
    const exhausted = await insertRow({ template: tpl('fail-exhausted'), attempts: MAX_ATTEMPTS - 1 });
    await lease(exhausted.id, 'w-fail');
    const r2 = await fail(exhausted.id, 'w-fail', true);
    expect(r2.data).toBe('dead');
    expect(await getRow(exhausted.id)).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS, worker_id: null });
    expect((await getRow(exhausted.id)).dead_at).not.toBeNull();

    // 非 retryable は 1 回目でも dead
    const fatal = await insertRow({ template: tpl('fail-fatal') });
    await lease(fatal.id, 'w-fail');
    const r3 = await fail(fatal.id, 'w-fail', false);
    expect(r3.data).toBe('dead');
    expect(await getRow(fatal.id)).toMatchObject({ status: 'dead', attempts: 1, to_email: OTHER_EMAIL });

    // worker が違う・行が無い・queued でないときは ignored
    expect((await fail(fatal.id, 'w-fail', false)).data).toBe('ignored');
    expect((await fail(randomUUID(), 'w-fail', true)).data).toBe('ignored');
    const other = await insertRow({ template: tpl('fail-other-worker') });
    await lease(other.id, 'w-owner');
    expect((await fail(other.id, 'w-intruder', true)).data).toBe('ignored');
    expect((await getRow(other.id)).attempts).toBe(0);
  });

  it('redact_after_send の行は、queued に戻すときは伏せず、dead にするとき (非 retryable・回数切れ) は宛先・件名・本文を伏せる。伏せた dead の requeue は redacted', async () => {
    const row = await insertRow({ template: tpl('fail-redact'), redact_after_send: true, subject: '退会', text_body: '完了', html_body: '<p>完了</p>' });
    await lease(row.id, 'w-redact-fail');
    expect((await fail(row.id, 'w-redact-fail', true)).data).toBe('queued');
    expect(await getRow(row.id)).toMatchObject({ status: 'queued', to_email: OTHER_EMAIL, subject: '退会', text_body: '完了', html_body: '<p>完了</p>' });

    await lease(row.id, 'w-redact-fail');
    expect((await fail(row.id, 'w-redact-fail', false)).data).toBe('dead');
    expect(await getRow(row.id)).toMatchObject({ status: 'dead', to_email: MASKED_EMAIL, subject: MASKED_TEXT, text_body: MASKED_TEXT, html_body: null });
    expect((await srAdmin.rpc('requeue_email_outbox', { p_id: row.id })).data).toBe('redacted');

    const exhausted = await insertRow({ template: tpl('fail-redact-exhausted'), redact_after_send: true, attempts: MAX_ATTEMPTS - 1 });
    await lease(exhausted.id, 'w-redact-fail');
    expect((await fail(exhausted.id, 'w-redact-fail', true)).data).toBe('dead');
    expect(await getRow(exhausted.id)).toMatchObject({ status: 'dead', to_email: MASKED_EMAIL, subject: MASKED_TEXT, text_body: MASKED_TEXT, html_body: null });
  });

  it('p_retryable が NULL・max_attempts / retry_after が範囲外なら 22023 で、行は変わらない', async () => {
    const row = await insertRow({ template: tpl('fail-null') });
    await lease(row.id, 'w-null');
    expect22023(await fail(row.id, 'w-null', null), 'p_retryable NULL');
    expect22023(await fail(row.id, 'w-null', true, 0), 'max_attempts 0');
    expect22023(await fail(row.id, 'w-null', true, 21), 'max_attempts 21');
    expect22023(
      await srAdmin.rpc('fail_email_outbox', {
        p_id: row.id,
        p_worker_id: 'w-null',
        p_error_code: 'x',
        p_error_message: 'x',
        p_status_code: null,
        p_retryable: true,
        p_max_attempts: MAX_ATTEMPTS,
        p_retry_after_seconds: 0,
      }),
      'retry_after 0',
    );
    expect(await getRow(row.id)).toMatchObject({ status: 'queued', attempts: 0, worker_id: 'w-null' });
  });
});

// ---------------------------------------------------------------
// requeue
// ---------------------------------------------------------------
describe('#1193 requeue_email_outbox', () => {
  it('dead だけを queued に戻す (attempts 0・requeue_count +1・リースなし)。queued / sent は not_dead、無い行は not_found、伏せ字は redacted', async () => {
    const dead = await insertDead({ template: tpl('requeue-dead'), attempts: 3, last_error_code: 'validation_error' });
    await setColumns(dead.id, `worker_id = 'w-stale', lease_expires_at = now() + interval '1 minute'`);
    const before = Date.now();
    const r = await srAdmin.rpc('requeue_email_outbox', { p_id: dead.id });
    expect(r.error).toBeNull();
    expect(r.data).toBe('requeued');
    const after = await getRow(dead.id);
    expect(after).toMatchObject({ status: 'queued', attempts: 0, requeue_count: 1, dead_at: null, worker_id: null, lease_expires_at: null });
    expect(Date.parse(after.next_attempt_at)).toBeLessThan(before + 30_000);
    expect(after.requeued_at).not.toBeNull();
    // すぐには取り直されないよう、期日を未来へ
    await setColumns(dead.id, `next_attempt_at = ${q(FAR_FUTURE)}`);

    expect((await srAdmin.rpc('requeue_email_outbox', { p_id: dead.id })).data).toBe('not_dead');
    const sent = await insertRow({ template: tpl('requeue-sent'), status: 'sent', sent_at: new Date().toISOString() });
    expect((await srAdmin.rpc('requeue_email_outbox', { p_id: sent.id })).data).toBe('not_dead');
    expect((await srAdmin.rpc('requeue_email_outbox', { p_id: randomUUID() })).data).toBe('not_found');
    const redacted = await insertDead({ template: tpl('requeue-redacted'), to_email: MASKED_EMAIL });
    expect((await srAdmin.rpc('requeue_email_outbox', { p_id: redacted.id })).data).toBe('redacted');
    expect((await getRow(redacted.id)).status).toBe('dead');
  });
});

// ---------------------------------------------------------------
// dead の通知: dead_counts / mark / unmark
// ---------------------------------------------------------------
describe('#1193 email_outbox_dead_counts / mark / unmark', () => {
  it('dead_counts: 窓が無く、まだ印の無い dead だけを template ごとに数える (1 日前の dead も数える。印の付いた行・suppressed・recipient_deleted・ops_ は数えない)', async () => {
    const t = tpl('counts');
    await insertDead({ template: t, last_error_code: 'validation_error' });
    const old = await insertDead({ template: t, last_error_code: 'validation_error' });
    await setColumns(old.id, `dead_at = now() - interval '1 day'`);
    await insertDead({ template: t, last_error_code: 'validation_error', dead_alerted_at: alertedAt() });
    await insertDead({ template: t, last_error_code: 'suppressed' });
    await insertDead({ template: t, last_error_code: 'recipient_deleted' });
    await insertDead({ template: OPS_TPL, last_error_code: 'validation_error' });
    await insertRow({ template: t });
    await insertRow({ template: t, status: 'sent', sent_at: new Date().toISOString() });

    const { data, error } = await srAdmin.rpc('email_outbox_dead_counts', { p_limit: 100 });
    expect(error).toBeNull();
    const rows = asCountRows(data);
    expect(countOf(rows, t)).toBe(2);
    expect(countOf(rows, OPS_TPL)).toBeUndefined();
    const total = rows.reduce((sum, r) => sum + r.dead_count, 0);
    for (const row of rows) expect(row.total_count).toBe(total);

    expect22023(await srAdmin.rpc('email_outbox_dead_counts', { p_limit: 0 }), 'limit 0');
    expect22023(await srAdmin.rpc('email_outbox_dead_counts', { p_limit: 101 }), 'limit 101');
  });

  it('mark: まだ印の無い dead (数える条件と同じ) に p_alerted_at の印を付け、印を付けた行だけを template ごとに数えて返す。同じ行に 2 回目の mark は付かない。suppressed などには付けない', async () => {
    const t = tpl('mark');
    const a = await insertDead({ template: t, last_error_code: 'validation_error' });
    const b = await insertDead({ template: t, last_error_code: 'invalid_api_key' });
    const suppressed = await insertDead({ template: t, last_error_code: 'suppressed' });
    const deleted = await insertDead({ template: t, last_error_code: 'recipient_deleted' });
    const ops = await insertDead({ template: OPS_TPL, last_error_code: 'validation_error' });
    const queued = await insertRow({ template: t });

    const at1 = alertedAt();
    const first = await srAdmin.rpc('mark_email_outbox_dead_alerted', { p_alerted_at: at1, p_limit: 100 });
    expect(first.error).toBeNull();
    expect(countOf(asCountRows(first.data), t)).toBe(2);
    for (const row of [a, b]) expect(Date.parse((await getRow(row.id)).dead_alerted_at ?? '')).toBe(Date.parse(at1));
    for (const row of [suppressed, deleted, ops, queued]) expect((await getRow(row.id)).dead_alerted_at).toBeNull();

    // 数えた行はもう数えない・印も付け直さない
    const counts = asCountRows((await srAdmin.rpc('email_outbox_dead_counts', { p_limit: 100 })).data);
    expect(countOf(counts, t)).toBeUndefined();
    const second = await srAdmin.rpc('mark_email_outbox_dead_alerted', { p_alerted_at: alertedAt(), p_limit: 100 });
    expect(second.error).toBeNull();
    expect(countOf(asCountRows(second.data), t)).toBeUndefined();
    expect(Date.parse((await getRow(a.id)).dead_alerted_at ?? '')).toBe(Date.parse(at1));
  });

  it('unmark: p_alerted_at と同じ印の行だけを NULL に戻して行数を返す (別の時刻の印は残る)。戻した行は次の dead_counts に入る', async () => {
    const t = tpl('unmark');
    const at1 = alertedAt();
    const at2 = alertedAt();
    const x = await insertDead({ template: t, last_error_code: 'validation_error', dead_alerted_at: at1 });
    const y = await insertDead({ template: t, last_error_code: 'validation_error', dead_alerted_at: at1 });
    const z = await insertDead({ template: t, last_error_code: 'validation_error', dead_alerted_at: at2 });

    const r = await srAdmin.rpc('unmark_email_outbox_dead_alerted', { p_alerted_at: at1 });
    expect(r.error).toBeNull();
    expect(r.data).toBe(2);
    expect((await getRow(x.id)).dead_alerted_at).toBeNull();
    expect((await getRow(y.id)).dead_alerted_at).toBeNull();
    expect(Date.parse((await getRow(z.id)).dead_alerted_at ?? '')).toBe(Date.parse(at2));
    expect(countOf(asCountRows((await srAdmin.rpc('email_outbox_dead_counts', { p_limit: 100 })).data), t)).toBe(2);
    // 後続のテストで数えないよう、印を付けて閉じる
    await srAdmin.rpc('mark_email_outbox_dead_alerted', { p_alerted_at: alertedAt(), p_limit: 100 });
  });

  it('mark / unmark: p_alerted_at が NULL なら 22023。mark の limit が範囲外も 22023', async () => {
    expect22023(await srAdmin.rpc('mark_email_outbox_dead_alerted', { p_alerted_at: null, p_limit: 10 }), 'mark の NULL');
    expect22023(await srAdmin.rpc('mark_email_outbox_dead_alerted', { p_alerted_at: alertedAt(), p_limit: 0 }), 'mark の limit 0');
    expect22023(await srAdmin.rpc('unmark_email_outbox_dead_alerted', { p_alerted_at: null }), 'unmark の NULL');
  });

  it('requeue: 印のある dead を queued に戻すと dead_alerted_at が NULL になり、もう一度 fail で dead になれば dead_counts に入る', async () => {
    const t = tpl('requeue-alerted');
    const row = await insertDead({ template: t, last_error_code: 'validation_error', dead_alerted_at: alertedAt() });
    expect((await srAdmin.rpc('requeue_email_outbox', { p_id: row.id })).data).toBe('requeued');
    expect((await getRow(row.id)).dead_alerted_at).toBeNull();
    await lease(row.id, 'w-again');
    expect((await fail(row.id, 'w-again', false)).data).toBe('dead');
    expect(countOf(asCountRows((await srAdmin.rpc('email_outbox_dead_counts', { p_limit: 100 })).data), t)).toBe(1);
    await srAdmin.rpc('mark_email_outbox_dead_alerted', { p_alerted_at: alertedAt(), p_limit: 100 });
  });

  it('CHECK: queued / sent の行に dead_alerted_at を入れる UPDATE は 23514', async () => {
    const queued = await insertRow({ template: tpl('check-queued') });
    const sent = await insertRow({ template: tpl('check-sent'), status: 'sent', sent_at: new Date().toISOString() });
    for (const row of [queued, sent]) {
      const { error } = await srAdmin.from('email_outbox').update({ dead_alerted_at: alertedAt() }).eq('id', row.id);
      expect(error?.code).toBe('23514');
    }
    // 状態と時刻の組 (email_outbox_status_times) も同じく 23514
    const { error } = await srAdmin.from('email_outbox').update({ status: 'sent' }).eq('id', queued.id);
    expect(error?.code).toBe('23514');
  });
});

// ---------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------
describe('#1193 cleanup_email_outbox', () => {
  it('sent は 7 日、dead は 30 日より古い行を消す。queued は古くても残る', async () => {
    const sentOld = await insertRow({ template: tpl('cleanup-sent-old'), status: 'sent', sent_at: new Date().toISOString() });
    await setColumns(sentOld.id, `sent_at = now() - interval '7 days 1 minute'`);
    const sentNew = await insertRow({ template: tpl('cleanup-sent-new'), status: 'sent', sent_at: new Date().toISOString() });
    await setColumns(sentNew.id, `sent_at = now() - interval '6 days 23 hours'`);
    const deadOld = await insertDead({ template: tpl('cleanup-dead-old'), last_error_code: 'suppressed' });
    await setColumns(deadOld.id, `dead_at = now() - interval '30 days 1 minute'`);
    const deadNew = await insertDead({ template: tpl('cleanup-dead-new'), last_error_code: 'suppressed' });
    await setColumns(deadNew.id, `dead_at = now() - interval '29 days 23 hours'`);
    const queuedOld = await insertRow({ template: tpl('cleanup-queued-old') });
    await setColumns(queuedOld.id, `created_at = now() - interval '60 days'`);

    const { data, error } = await srAdmin.rpc('cleanup_email_outbox');
    expect(error).toBeNull();
    expect(data as number).toBeGreaterThanOrEqual(2);
    expect(await rowExists(sentOld.id)).toBe(false);
    expect(await rowExists(deadOld.id)).toBe(false);
    expect(await rowExists(sentNew.id)).toBe(true);
    expect(await rowExists(deadNew.id)).toBe(true);
    expect(await rowExists(queuedOld.id)).toBe(true);
  });
});

// ---------------------------------------------------------------
// prepare_account_deletion の段 1b・1c
// ---------------------------------------------------------------
async function prepare(userId: string): Promise<Record<string, number>> {
  const { data, error } = await srAdmin.rpc('prepare_account_deletion', { p_user_id: userId });
  expect(error).toBeNull();
  return data as Record<string, number>;
}

describe('#1193 prepare_account_deletion: email_outbox', () => {
  it('1b: 本人の行 (user_id・宛先が一致) の宛先・件名・本文を伏せ、queued は dead (recipient_deleted) にする。sent / dead は状態のまま', async () => {
    const user = await createUser('self');
    const byUser = await insertRow({ template: tpl('1b-user'), user_id: user.id, html_body: '<p>x</p>' });
    const byAddress = await insertRow({ template: tpl('1b-address'), to_email: user.email.toUpperCase(), status: 'sent', sent_at: new Date().toISOString() });
    const deadMine = await insertDead({ template: tpl('1b-dead'), to_email: user.email, last_error_code: 'validation_error' });
    const others = await insertRow({ template: tpl('1b-other') });

    const report = await prepare(user.id);
    expect(report.email_outbox).toBe(3);
    const q1 = await getRow(byUser.id);
    expect(q1).toMatchObject({
      status: 'dead',
      last_error_code: 'recipient_deleted',
      to_email: MASKED_EMAIL,
      subject: MASKED_TEXT,
      text_body: MASKED_TEXT,
      html_body: null,
      worker_id: null,
      lease_expires_at: null,
    });
    expect(q1.dead_at).not.toBeNull();
    expect(await getRow(byAddress.id)).toMatchObject({ status: 'sent', to_email: MASKED_EMAIL, subject: MASKED_TEXT, text_body: MASKED_TEXT });
    expect(await getRow(deadMine.id)).toMatchObject({ status: 'dead', last_error_code: 'validation_error', to_email: MASKED_EMAIL });
    expect(await getRow(others.id)).toMatchObject({ status: 'queued', to_email: OTHER_EMAIL, subject: 'subject', updated_at: others.updated_at });

    // 2 回目は伏せるものが無い (やり直せる)
    expect((await prepare(user.id)).email_outbox).toBe(0);
  });

  it('リース中の queued を 1b が dead にしたあと、元の worker の complete は false・fail は ignored で、行は dead (recipient_deleted)・伏せ字のまま', async () => {
    const user = await createUser('leased');
    const row = await insertRow({ template: tpl('1b-leased'), user_id: user.id });
    await lease(row.id, 'w-inflight');
    expect((await prepare(user.id)).email_outbox).toBe(1);

    const done = await srAdmin.rpc('complete_email_outbox', { p_id: row.id, p_worker_id: 'w-inflight', p_resend_message_id: 'msg-late' });
    expect(done.data).toBe(false);
    expect((await fail(row.id, 'w-inflight', true)).data).toBe('ignored');
    expect(await getRow(row.id)).toMatchObject({
      status: 'dead',
      last_error_code: 'recipient_deleted',
      to_email: MASKED_EMAIL,
      resend_message_id: null,
      attempts: 0,
    });
  });

  it('1c: 他人宛の行 (queued・リース中の queued・sent・dead) の件名・本文・HTML・返信先にある本人のアドレスを、大文字小文字を問わずすべて伏せ、status・attempts・next_attempt_at・リース・鍵・宛先は変えない。戻り値は 1b と 1c の和', async () => {
    const user = await createUser('mention');
    const upper = user.email.toUpperCase();
    const mention = (label: string) => `旧オーナー: ${user.email} (${label}) / 連絡先 ${upper}`;
    const own = await insertRow({ template: tpl('1c-own'), user_id: user.id });
    const queued = await insertRow({
      template: tpl('1c-queued'),
      subject: `${upper} さんからの譲渡`,
      text_body: mention('本文'),
      html_body: `<p>${mention('html')}</p>`,
      reply_to: user.email,
      attempts: 1,
    });
    const leased = await insertRow({ template: tpl('1c-leased'), text_body: mention('leased'), attempts: 2 });
    await lease(leased.id, 'w-1c');
    const leasedBefore = await getRow(leased.id);
    const sent = await insertRow({ template: tpl('1c-sent'), status: 'sent', sent_at: new Date().toISOString(), text_body: mention('sent') });
    const dead = await insertDead({ template: tpl('1c-dead'), last_error_code: 'validation_error', text_body: mention('dead') });
    const untouched = await insertRow({ template: tpl('1c-untouched'), text_body: `新オーナー: ${OTHER_EMAIL}` });

    const report = await prepare(user.id);
    // 1b (本人の行 1) + 1c (他人宛の 4 行)
    expect(report.email_outbox).toBe(5);
    expect((await getRow(own.id)).status).toBe('dead');

    const pattern = new RegExp(user.email.replace(/[^A-Za-z0-9]/g, '\\$&'), 'i');
    for (const before of [queued, leasedBefore, sent, dead]) {
      const after = await getRow(before.id);
      for (const value of [after.subject, after.text_body, after.html_body ?? '', after.reply_to ?? '']) {
        expect(value, `${after.template} に本人のアドレスが残っている`).not.toMatch(pattern);
      }
      expect(after.text_body).toContain(MASKED_EMAIL);
      expect(after).toMatchObject({
        status: before.status,
        attempts: before.attempts,
        next_attempt_at: before.next_attempt_at,
        worker_id: before.worker_id,
        lease_expires_at: before.lease_expires_at,
        idempotency_key: before.idempotency_key,
        to_email: before.to_email,
        dead_at: before.dead_at,
      });
    }
    const q2 = await getRow(queued.id);
    expect(q2.subject).toBe(`${MASKED_EMAIL} さんからの譲渡`);
    expect(q2.text_body).toBe(`旧オーナー: ${MASKED_EMAIL} (本文) / 連絡先 ${MASKED_EMAIL}`);
    expect(q2.html_body).toBe(`<p>旧オーナー: ${MASKED_EMAIL} (html) / 連絡先 ${MASKED_EMAIL}</p>`);
    expect(q2.reply_to).toBe(MASKED_EMAIL);
    expect(await getRow(untouched.id)).toMatchObject({ text_body: `新オーナー: ${OTHER_EMAIL}`, updated_at: untouched.updated_at });
  });

  it('1c: アドレスの . や + を任意の文字・繰り返しとして扱わない。本人のアドレスを含まない他人宛の行は updated_at も変わらない', async () => {
    const email = `del.user+x${TS}@homegohan.test`;
    const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
    createdUserIds.push(data.user.id);
    const lookAlike1 = `delXuser+x${TS}@homegohan.test`;
    const lookAlike2 = `del.userrx${TS}@homegohan.test`;
    const decoyText = `似たアドレス ${lookAlike1} と ${lookAlike2}`;
    const decoy = await insertRow({ template: tpl('1c-decoy'), text_body: decoyText });
    const hit = await insertRow({ template: tpl('1c-hit'), text_body: `本人 ${email}` });

    const report = await prepare(data.user.id);
    expect(report.email_outbox).toBe(1);
    expect(await getRow(decoy.id)).toMatchObject({ text_body: decoyText, updated_at: decoy.updated_at });
    expect((await getRow(hit.id)).text_body).toBe(`本人 ${MASKED_EMAIL}`);
  });

  it('1c で本文を伏せたリース中の queued の行は、元の worker の complete_email_outbox が true で sent になり、本文は伏せたまま', async () => {
    const user = await createUser('mention-complete');
    const row = await insertRow({ template: tpl('1c-complete'), text_body: `旧オーナー ${user.email}` });
    await lease(row.id, 'w-1c-complete');
    expect((await prepare(user.id)).email_outbox).toBe(1);
    const done = await srAdmin.rpc('complete_email_outbox', { p_id: row.id, p_worker_id: 'w-1c-complete', p_resend_message_id: 'msg-1c' });
    expect(done.data).toBe(true);
    expect(await getRow(row.id)).toMatchObject({ status: 'sent', to_email: OTHER_EMAIL, text_body: `旧オーナー ${MASKED_EMAIL}` });
  });
});

// ---------------------------------------------------------------
// pg_cron
// ---------------------------------------------------------------
describe('#1193 pg_cron', () => {
  it('cron.job に cleanup-email-outbox (20 18 * * *・cleanup_email_outbox を呼ぶ) がある', async () => {
    const hasCron = await pgQuery<{ ok: boolean }>(`select to_regclass('cron.job') is not null as ok`);
    if (!hasCron[0]?.ok) {
      // pg_cron の無い DB では migration が登録を飛ばす (NOTICE)。ローカルの Supabase には pg_cron がある
      throw new Error('cron.job がありません (pg_cron が入っていない DB)');
    }
    const jobs = await pgQuery<{ schedule: string; calls: boolean }>(`
      select schedule, command ~ 'public\\.cleanup_email_outbox\\(\\)' as calls
        from cron.job where jobname = 'cleanup-email-outbox'
    `);
    expect(jobs).toEqual([{ schedule: '20 18 * * *', calls: true }]);
  });
});
