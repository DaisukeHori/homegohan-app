/**
 * billing/03 (有料プランの販売) 段 A: RevenueCat の Webhook の処理の権利の取得 (billing_claim_revenuecat_event) と結果の記録
 * (billing_finish_revenuecat_event) の結合テスト (設計: docs/design/billing/03-paid-plans-and-iap.md §6.3 の (3')・§14.2 の 73)
 *
 * Stripe の billing_claim_stripe_event / billing_finish_stripe_event と同じ本体で、表 (revenuecat_webhook_events) だけが違う
 * (tests/integration/rls/billing-webhook-events-claim-rpc.test.ts と同じ確かめ方)。
 *   73. 新しいイベントは claimed。completed のイベントは completed、ほかが処理中 (processing・p_stuck_after 以内) なら in_progress。
 *       failed / pending と、processing のまま古い (p_stuck_after より前に権利を取った) イベントは、再び claimed になる (= 再処理)
 *   あわせて: 結果の記録 (成功なら completed と processed_at、失敗なら failed と error_message (500 文字に切る))・
 *   anon / authenticated は 2 つの関数も表も使えない (service_role だけ)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/billing-revenuecat-events-claim-rpc.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const clientOf = (key: string): SupabaseClient =>
  createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
const srAdmin = clientOf(serviceKey);
const anon = clientOf(anonKey);

/** 走らせるたびに違うイベント ID にする (前の実行の行と混ざらない) */
const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const EVENT_ID_PREFIX = `evt_it_rc_${RUN}_`;
let seq = 0;
const nextEventId = () => `${EVENT_ID_PREFIX}${++seq}`;

/** 関数の既定の p_stuck_after (15 分) より十分に古い時刻にずらす量 (ミリ秒)。processing のまま止まった行を作るのに使う */
const STUCK_AGE_MS = 20 * 60 * 1000;
/** billing_finish_revenuecat_event が error_message に残す長さの上限 (left(p_error, 500)) */
const ERROR_MESSAGE_MAX = 500;
/** 上限より長い失敗の文の長さ */
const LONG_ERROR_LENGTH = 600;

const EVENT_TYPE = 'RENEWAL';
/** 最小化した写し (§8.1 の minimizeRevenueCatEventPayload が残すキー) */
const payloadOf = (id: string) => ({ id, type: EVENT_TYPE, app_user_id: '00000000-0000-0000-0000-000000000000', product_id: 'it.product', store: 'APP_STORE', event_timestamp_ms: 0 });

interface EventRow {
  id: string;
  processing_status: string;
  processing_started_at: string | null;
  attempt_count: number;
  processed_at: string | null;
  error_message: string | null;
}

async function claim(id: string): Promise<string> {
  const { data, error } = await srAdmin.rpc('billing_claim_revenuecat_event', {
    p_event_id: id,
    p_event_type: EVENT_TYPE,
    p_payload: payloadOf(id),
  });
  if (error) throw new Error(`billing_claim_revenuecat_event: ${error.message}`);
  return data as string;
}

async function finish(id: string, ok: boolean, errorText?: string): Promise<void> {
  const { error } = await srAdmin.rpc('billing_finish_revenuecat_event', {
    p_event_id: id,
    p_ok: ok,
    ...(errorText === undefined ? {} : { p_error: errorText }),
  });
  if (error) throw new Error(`billing_finish_revenuecat_event: ${error.message}`);
}

async function eventRow(id: string): Promise<EventRow> {
  const { data, error } = await srAdmin
    .from('revenuecat_webhook_events')
    .select('id, processing_status, processing_started_at, attempt_count, processed_at, error_message')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`revenuecat_webhook_events: ${error?.message}`);
  return data as EventRow;
}

afterAll(async () => {
  await srAdmin.from('revenuecat_webhook_events').delete().like('id', `${EVENT_ID_PREFIX}%`);
}, 60_000);

describe('billing/03 §6.3 (3\'): RevenueCat の Webhook の処理の権利と結果', () => {
  // 73
  it('claim returns claimed / completed / in_progress and lets failed and stale processing rows be reclaimed', async () => {
    // 新しいイベント → claimed (processing・1 回目)
    const fresh = nextEventId();
    expect(await claim(fresh)).toBe('claimed');
    const claimed = await eventRow(fresh);
    expect(claimed.processing_status).toBe('processing');
    expect(claimed.attempt_count).toBe(1);
    expect(claimed.processing_started_at).not.toBeNull();

    // ほかが処理中 (p_stuck_after 以内) → in_progress。行は変わらない
    expect(await claim(fresh)).toBe('in_progress');
    expect((await eventRow(fresh)).attempt_count).toBe(1);

    // 処理済み → completed。行は変わらない
    await finish(fresh, true);
    expect(await claim(fresh)).toBe('completed');
    const completed = await eventRow(fresh);
    expect(completed.processing_status).toBe('completed');
    expect(completed.attempt_count).toBe(1);

    // 失敗した → 再び claimed (2 回目)。前の失敗の文は消す
    const failed = nextEventId();
    expect(await claim(failed)).toBe('claimed');
    await finish(failed, false, 'BILL_UNKNOWN_PLAN');
    expect((await eventRow(failed)).error_message).toBe('BILL_UNKNOWN_PLAN');
    expect(await claim(failed)).toBe('claimed');
    const reclaimed = await eventRow(failed);
    expect(reclaimed.processing_status).toBe('processing');
    expect(reclaimed.attempt_count).toBe(2);
    expect(reclaimed.error_message).toBeNull();

    // processing のまま古い (処理の途中で止まった) → 再び claimed
    const stuck = nextEventId();
    expect(await claim(stuck)).toBe('claimed');
    const oldStart = new Date(Date.now() - STUCK_AGE_MS).toISOString();
    const { error: ageError } = await srAdmin
      .from('revenuecat_webhook_events')
      .update({ processing_started_at: oldStart })
      .eq('id', stuck);
    if (ageError) throw new Error(`age: ${ageError.message}`);
    expect(await claim(stuck)).toBe('claimed');
    const restarted = await eventRow(stuck);
    expect(restarted.attempt_count).toBe(2);
    expect(new Date(restarted.processing_started_at!).getTime()).toBeGreaterThan(new Date(oldStart).getTime());

    // pending のまま残った行 (権利を取る前に書かれた行) → claimed
    const pending = nextEventId();
    const { error: insertError } = await srAdmin
      .from('revenuecat_webhook_events')
      .insert({ id: pending, event_type: EVENT_TYPE, payload: payloadOf(pending), processing_status: 'pending' });
    if (insertError) throw new Error(`insert pending: ${insertError.message}`);
    expect(await claim(pending)).toBe('claimed');
    expect((await eventRow(pending)).attempt_count).toBe(1);

    // 引数の不足は 22023
    const { error: missing } = await srAdmin.rpc('billing_claim_revenuecat_event', {
      p_event_id: '',
      p_event_type: EVENT_TYPE,
      p_payload: payloadOf('x'),
    });
    expect(missing?.code).toBe('22023');
  });

  it('finish sets completed/processed_at or failed/error_message (truncated)', async () => {
    const ok = nextEventId();
    expect(await claim(ok)).toBe('claimed');
    await finish(ok, true);
    const done = await eventRow(ok);
    expect(done.processing_status).toBe('completed');
    expect(done.processed_at).not.toBeNull();
    expect(done.error_message).toBeNull();

    const ng = nextEventId();
    expect(await claim(ng)).toBe('claimed');
    const longError = `EXT_REVENUECAT_${'x'.repeat(LONG_ERROR_LENGTH)}`;
    await finish(ng, false, longError);
    const failed = await eventRow(ng);
    expect(failed.processing_status).toBe('failed');
    expect(failed.processed_at).toBeNull();
    expect(failed.error_message).toBe(longError.slice(0, ERROR_MESSAGE_MAX));
    expect(failed.error_message!.length).toBe(ERROR_MESSAGE_MAX);

    // 失敗のあとに成功すれば completed になり、失敗の文は消える
    expect(await claim(ng)).toBe('claimed');
    await finish(ng, true);
    const recovered = await eventRow(ng);
    expect(recovered.processing_status).toBe('completed');
    expect(recovered.error_message).toBeNull();
    expect(recovered.processed_at).not.toBeNull();
  });

  it('anon and authenticated cannot call claim / finish or read the events table (service_role only)', async () => {
    const id = nextEventId();
    for (const [name, args] of [
      ['billing_claim_revenuecat_event', { p_event_id: id, p_event_type: EVENT_TYPE, p_payload: payloadOf(id) }],
      ['billing_finish_revenuecat_event', { p_event_id: id, p_ok: true }],
    ] as const) {
      const { error } = await anon.rpc(name, args);
      expect(error?.code, name).toBe('42501');
    }
    const { error: selectError } = await anon.from('revenuecat_webhook_events').select('id').limit(1);
    expect(selectError?.code).toBe('42501');
    // 呼べなかったので行は無い
    const { data, error } = await srAdmin.from('revenuecat_webhook_events').select('id').eq('id', id);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
