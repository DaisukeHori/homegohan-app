/**
 * #1708 秘密を含むメールの文面 (招待・本人確認・本人同意のトークンを含むリンク) が、送信待ち (email_outbox) に
 * 生のトークンを残さないことを、ローカル Supabase の実 DB で確かめる (sendEmail → complete / fail の RPC を実物で通す)。
 *   - 秘密を含む文面のすべて (tests/helpers/secret-email-samples.ts) で:
 *     S-1: sendEmail は呼び出し元が何も渡さなくても redact_after_send を立てて登録する (送るまでは本文にトークンがある)
 *     S-2: 送れたとき (complete_email_outbox) に宛先・件名・本文が伏せられ、行のどの列にもトークンと宛先が残らない。template は残る
 *     S-3: 届けられずに dead になったとき (fail_email_outbox・非 retryable) も同じく伏せられ、再送 (requeue) は 'redacted'
 *   - 対照 C-1: 秘密の宣言の無い封筒は、送れたあとも本文が残る (伏せたのが宣言のおかげであることを確かめる)
 *
 * sendEmail が使う service_role のクライアントは、テストの実クライアントにする (表と RPC は実物)。
 * ロガー (app_logs への書き込み) だけは何もしない偽物にする (このテストの行を app_logs に残さない)。
 * 自分の行は Idempotency-Key の目印 (MARK) で識別し、開始時と終了時に消す (伏せたあとも Idempotency-Key は残る)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/email-outbox-secret-templates.test.ts
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ws from 'ws';
import { SECRET_EMAIL_SAMPLES, SECRET_SAMPLE_TOKEN } from '../../helpers/secret-email-samples';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const admin: SupabaseClient = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws as unknown as typeof WebSocket },
});

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => admin,
}));

vi.mock('@/lib/db-logger', () => {
  const noop = () => undefined;
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

const { sendEmail } = await import('@/lib/emails/send');

/** この実行の目印 (Idempotency-Key の接頭辞と宛先のローカル部) */
const MARK = `it1708-secret-${Date.now()}-${randomBytes(4).toString('hex')}`;
/** 宛先のドメイン (予約済みの .test。実在の宛先にならない) */
const ADDRESS_DOMAIN = 'example.test';
const address = (label: string) => `${MARK}-${label}@${ADDRESS_DOMAIN}`;
const keyOf = (label: string) => `${MARK}-${label}`;

/** 伏せ字 (migration 20261016234000_email_outbox.sql の c_masked_email / c_masked_text) */
const MASKED_EMAIL = 'redacted@redacted.invalid';
const MASKED_TEXT = '[redacted]';
/** RESEND_API_KEY の代わりのダミー値 (sendEmail は有無だけを見る。Resend は呼ばない) */
const DUMMY_RESEND_API_KEY = 'dummy-api-key-for-integration-test';
/** worker の代わりの id と、Resend の受け付けの ID の代わり */
const WORKER_ID = `${MARK}-worker`;
const RESEND_MESSAGE_ID = 're_it1708_dummy';
/** fail_email_outbox に渡す値 (非 retryable の 422 で 1 回目に dead。上限と待ちは設計書 §6.1 の既定) */
const NON_RETRYABLE_STATUS = 422;
const MAX_ATTEMPTS = 6;
const RETRY_AFTER_SECONDS = 60;
/** 対照の封筒の送信元 */
const FROM_EMAIL = 'noreply@homegohan.test';
/** 誰も取らない時刻 (他のテストの claim に巻き込まれない) */
const FAR_FUTURE = '2999-01-01T00:00:00+00:00';

interface OutboxRow {
  id: string;
  status: 'queued' | 'sent' | 'dead';
  template: string;
  to_email: string;
  subject: string;
  text_body: string;
  html_body: string | null;
  redact_after_send: boolean;
}

let previousResendKey: string | undefined;

async function purge(): Promise<void> {
  const { error } = await admin.from('email_outbox').delete().like('idempotency_key', `${MARK}-%`);
  if (error) throw new Error(`purge email_outbox: ${error.message}`);
}

async function getRow(id: string): Promise<OutboxRow> {
  const { data, error } = await admin.from('email_outbox').select('*').eq('id', id).single();
  if (error || !data) throw new Error(`select email_outbox: ${error?.message}`);
  return data as OutboxRow;
}

/** sendEmail で登録し、worker が claim した状態 (worker_id) を作る。claim は表の全体から取るので使わない */
async function enqueueAndLease(envelope: Parameters<typeof sendEmail>[0], label: string): Promise<OutboxRow> {
  const result = await sendEmail(envelope, { idempotencyKey: keyOf(label) });
  if (!result.ok) throw new Error(`sendEmail ${label}: ${result.error.code}`);
  const { error } = await admin
    .from('email_outbox')
    .update({ worker_id: WORKER_ID, next_attempt_at: FAR_FUTURE })
    .eq('id', result.id);
  if (error) throw new Error(`lease ${label}: ${error.message}`);
  return getRow(result.id);
}

function expectFullyRedacted(row: OutboxRow, to: string): void {
  expect(row.to_email).toBe(MASKED_EMAIL);
  expect(row.subject).toBe(MASKED_TEXT);
  expect(row.text_body).toBe(MASKED_TEXT);
  expect(row.html_body).toBeNull();
  // どの列にも生のトークンと宛先が残らない
  const serialized = JSON.stringify(row);
  expect(serialized).not.toContain(SECRET_SAMPLE_TOKEN);
  expect(serialized).not.toContain(to);
}

beforeAll(async () => {
  previousResendKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = DUMMY_RESEND_API_KEY;
  await purge();
});

afterAll(async () => {
  if (previousResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = previousResendKey;
  await purge();
});

describe('#1708 秘密を含む文面は、送れた・届けられなかったあとに送信待ちの行が伏せられる (実 DB)', () => {
  it.each(SECRET_EMAIL_SAMPLES.map((sample) => [sample.template, sample] as const))(
    '%s: S-1 redact_after_send で登録 → S-2 送れたら宛先・件名・本文を伏せる (template は残る)',
    async (template, sample) => {
      const to = address(`${template}-sent`);
      const queued = await enqueueAndLease(sample.render(to), `${template}-sent`);

      expect(queued.status).toBe('queued');
      expect(queued.template).toBe(template);
      expect(queued.redact_after_send).toBe(true);
      expect(queued.text_body).toContain(SECRET_SAMPLE_TOKEN);

      const { data, error } = await admin.rpc('complete_email_outbox', {
        p_id: queued.id,
        p_worker_id: WORKER_ID,
        p_resend_message_id: RESEND_MESSAGE_ID,
      });
      expect(error).toBeNull();
      expect(data).toBe(true);

      const sent = await getRow(queued.id);
      expect(sent.status).toBe('sent');
      expect(sent.template).toBe(template);
      expectFullyRedacted(sent, to);
    },
  );

  it.each(SECRET_EMAIL_SAMPLES.map((sample) => [sample.template, sample] as const))(
    '%s: S-3 届けられずに dead になったら宛先・件名・本文を伏せ、再送は redacted',
    async (template, sample) => {
      const to = address(`${template}-dead`);
      const queued = await enqueueAndLease(sample.render(to), `${template}-dead`);

      const { data, error } = await admin.rpc('fail_email_outbox', {
        p_id: queued.id,
        p_worker_id: WORKER_ID,
        p_error_code: 'validation_error',
        p_error_message: '宛先が受け付けられませんでした',
        p_status_code: NON_RETRYABLE_STATUS,
        p_retryable: false,
        p_max_attempts: MAX_ATTEMPTS,
        p_retry_after_seconds: RETRY_AFTER_SECONDS,
      });
      expect(error).toBeNull();
      expect(data).toBe('dead');

      const dead = await getRow(queued.id);
      expect(dead.status).toBe('dead');
      expect(dead.template).toBe(template);
      expectFullyRedacted(dead, to);

      const requeue = await admin.rpc('requeue_email_outbox', { p_id: queued.id });
      expect(requeue.error).toBeNull();
      expect(requeue.data).toBe('redacted');
    },
  );

  it('C-1 対照: 秘密の宣言の無い封筒は、送れたあとも宛先・本文が残る', async () => {
    const to = address('control');
    const queued = await enqueueAndLease(
      { to, from: FROM_EMAIL, subject: '対照の件名', text: `対照の本文 ${MARK}`, template: 'it1708_control' },
      'control',
    );
    expect(queued.redact_after_send).toBe(false);

    const { data, error } = await admin.rpc('complete_email_outbox', {
      p_id: queued.id,
      p_worker_id: WORKER_ID,
      p_resend_message_id: RESEND_MESSAGE_ID,
    });
    expect(error).toBeNull();
    expect(data).toBe(true);

    const sent = await getRow(queued.id);
    expect(sent.status).toBe('sent');
    expect(sent.to_email).toBe(to);
    expect(sent.text_body).toBe(`対照の本文 ${MARK}`);
  });
});
