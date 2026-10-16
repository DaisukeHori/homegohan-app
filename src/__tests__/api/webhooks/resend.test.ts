// @vitest-environment node
/**
 * #1184 POST /api/webhooks/resend — Resend の Webhook で、ハードバウンス・苦情の宛先を宛先停止リスト (email_blacklist) に入れる。
 *
 * route と停止リストの読み書き (src/lib/emails/suppression.ts) は実物を通し、Supabase の service_role のクライアントだけを
 * 偽物にする。偽物は email_blacklist を主キー (email) つきの表として持ち、upsert の ignoreDuplicates (ON CONFLICT DO NOTHING) を
 * 本物と同じく「既にある行はそのまま」にする。そのうえで、受けた宛先へ sendEmail が送らないことまでを通しで確かめる。
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: new Map<string, { email: string; reason: string; added_at: string }>(),
  upsertError: null as { message: string; code: string } | null,
  upsertCalls: [] as Array<{ rows: unknown; options: unknown }>,
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  emailsSend: vi.fn(),
  /** #1193 sendEmail が送信待ち (email_outbox) に入れた行 */
  outboxRows: [] as Array<Record<string, unknown>>,
}));

/** 送信待ちに登録した行の id (固定) */
const OUTBOX_ROW_ID = '00000000-0000-4000-8000-0000000000bb';

/** email_blacklist と email_outbox (#1193。sendEmail の登録先) を持つ偽物の service_role クライアント */
function fakeAdmin() {
  return {
    from(table: string) {
      if (table === 'email_outbox') {
        return {
          // insert(row).select('id').single() は登録した行の id を返し、select を付けない insert は { error: null }
          insert(row: Record<string, unknown>) {
            mocks.outboxRows.push(row);
            return {
              select: () => ({ single: () => Promise.resolve({ data: { id: OUTBOX_ROW_ID }, error: null }) }),
              then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                Promise.resolve({ error: null }).then(resolve, reject),
            };
          },
        };
      }
      if (table !== 'email_blacklist') throw new Error(`unexpected table ${table}`);
      return {
        upsert(
          rows: Array<{ email: string; reason: string; added_at: string }>,
          options: { onConflict?: string; ignoreDuplicates?: boolean },
        ) {
          mocks.upsertCalls.push({ rows, options });
          if (mocks.upsertError) return Promise.resolve({ error: mocks.upsertError });
          for (const row of rows) {
            if (mocks.rows.has(row.email)) {
              if (!options.ignoreDuplicates) mocks.rows.set(row.email, row);
            } else {
              mocks.rows.set(row.email, row);
            }
          }
          return Promise.resolve({ error: null });
        },
        select() {
          let keys: string[] = [];
          const builder = {
            in(_column: string, values: string[]) {
              keys = values;
              return builder;
            },
            limit() {
              return builder;
            },
            abortSignal() {
              const data = keys.flatMap((key) => {
                const row = mocks.rows.get(key);
                return row ? [{ email: row.email, reason: row.reason }] : [];
              });
              return Promise.resolve({ data, error: null });
            },
          };
          return builder;
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => fakeAdmin(),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.logInfo, warn: mocks.logWarn, error: mocks.logError }),
  generateRequestId: () => 'req-test',
}));

vi.mock('resend', () => {
  class MockResend {
    emails = { send: mocks.emailsSend };
  }
  return { Resend: MockResend };
});

import { POST } from '@/app/api/webhooks/resend/route';
import { sendEmail } from '@/lib/emails/send';
import { WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS } from '@/lib/webhook/verify';

// テスト用の鍵 (本物ではない。"whsec_" + base64)
const SECRET = `whsec_${Buffer.from('test-signing-key-for-resend-webhook').toString('base64')}`;
const OTHER_SECRET = `whsec_${Buffer.from('a-different-signing-key').toString('base64')}`;
const URL = 'http://localhost/api/webhooks/resend';

function sign(payload: string, id: string, timestamp: string, secret = SECRET): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function signedRequest(
  event: unknown,
  opts: { id?: string; timestamp?: string; secret?: string; signature?: string | null } = {},
): Request {
  const payload = typeof event === 'string' ? event : JSON.stringify(event);
  const id = opts.id ?? 'msg_test_1';
  const timestamp = opts.timestamp ?? nowSeconds();
  const headers = new Headers({ 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp });
  const signature = opts.signature === undefined ? `v1,${sign(payload, id, timestamp, opts.secret)}` : opts.signature;
  if (signature !== null) headers.set('svix-signature', signature);
  return new Request(URL, { method: 'POST', headers, body: payload });
}

function bouncedEvent(to: string | string[], bounceType: string) {
  return {
    type: 'email.bounced',
    created_at: '2026-10-14T00:00:00.000Z',
    data: {
      created_at: '2026-10-14T00:00:00.000Z',
      email_id: 'email-1',
      from: 'noreply@example.test',
      to: Array.isArray(to) ? to : [to],
      subject: 'x',
      bounce: { message: 'm', subType: 'General', type: bounceType },
    },
  };
}

function complainedEvent(to: string) {
  return {
    type: 'email.complained',
    created_at: '2026-10-14T00:00:00.000Z',
    data: { created_at: '2026-10-14T00:00:00.000Z', email_id: 'email-2', from: 'noreply@example.test', to: [to], subject: 'x' },
  };
}

beforeEach(() => {
  vi.stubEnv('RESEND_WEBHOOK_SECRET', SECRET);
  mocks.rows.clear();
  mocks.upsertError = null;
  mocks.upsertCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('POST /api/webhooks/resend: 署名', () => {
  it('正しい署名なら 200 で受け付ける', async () => {
    const res = await POST(signedRequest(bouncedEvent('hard@example.com', 'Permanent')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it('別の秘密で付けた署名は 401。停止リストに書かない', async () => {
    const res = await POST(signedRequest(bouncedEvent('hard@example.com', 'Permanent'), { secret: OTHER_SECRET }));
    expect(res.status).toBe(401);
    expect(mocks.upsertCalls).toHaveLength(0);
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.any(String), { reason: 'signature_mismatch' });
  });

  it('署名のあとで本文を書き換えたら 401', async () => {
    const original = JSON.stringify(complainedEvent('a@example.com'));
    const id = 'msg_tamper';
    const timestamp = nowSeconds();
    const signature = `v1,${sign(original, id, timestamp)}`;
    const tampered = original.replace('a@example.com', 'victim@example.com');
    const res = await POST(
      new Request(URL, {
        method: 'POST',
        headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature },
        body: tampered,
      }),
    );
    expect(res.status).toBe(401);
    expect(mocks.rows.size).toBe(0);
  });

  it('署名のヘッダーが無ければ 401', async () => {
    const res = await POST(signedRequest(bouncedEvent('hard@example.com', 'Permanent'), { signature: null }));
    expect(res.status).toBe(401);
    expect(mocks.upsertCalls).toHaveLength(0);
  });

  it(`送った時刻が ${WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS} 秒より古い署名は、署名が合っていても 401 (再送の悪用を防ぐ)`, async () => {
    const old = String(Math.floor(Date.now() / 1000) - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 60);
    const res = await POST(signedRequest(bouncedEvent('hard@example.com', 'Permanent'), { timestamp: old }));
    expect(res.status).toBe(401);
    expect(mocks.upsertCalls).toHaveLength(0);
  });

  it('署名の秘密 (RESEND_WEBHOOK_SECRET) が未設定なら 503。受け付けず、本文に変数名を出さない', async () => {
    vi.stubEnv('RESEND_WEBHOOK_SECRET', '');
    const res = await POST(signedRequest(bouncedEvent('hard@example.com', 'Permanent')));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('RESEND_WEBHOOK_SECRET');
    expect(mocks.upsertCalls).toHaveLength(0);
  });

  it('秘密が "whsec_" だけ (鍵が空) のときも未設定と同じく 503 (空の鍵の署名を受け付けない)', async () => {
    vi.stubEnv('RESEND_WEBHOOK_SECRET', 'whsec_');
    const res = await POST(signedRequest(bouncedEvent('hard@example.com', 'Permanent')));
    expect(res.status).toBe(503);
  });

  it('署名は合っているが本文が JSON でなければ 400', async () => {
    const res = await POST(signedRequest('not json'));
    expect(res.status).toBe(400);
    expect(mocks.upsertCalls).toHaveLength(0);
  });

  it('本文が大きすぎれば、署名を確かめる前に 413', async () => {
    const huge = JSON.stringify({ type: 'email.sent', data: { pad: 'x'.repeat(300 * 1024) } });
    const res = await POST(signedRequest(huge));
    expect(res.status).toBe(413);
  });
});

describe('POST /api/webhooks/resend: 振り分け', () => {
  it('ハードバウンス (bounce.type = Permanent) は reason = bounce で入れる。宛先は小文字にそろえ、受けた時刻を残す', async () => {
    const before = Date.now();
    const res = await POST(signedRequest(bouncedEvent('Hard.User@Example.COM', 'Permanent')));
    expect(res.status).toBe(200);
    const row = mocks.rows.get('hard.user@example.com');
    expect(row).toMatchObject({ email: 'hard.user@example.com', reason: 'bounce' });
    expect(Date.parse(row!.added_at)).toBeGreaterThanOrEqual(before);
    expect(mocks.upsertCalls[0].options).toEqual({ onConflict: 'email', ignoreDuplicates: true });
  });

  it('ソフトバウンス (Temporary / Transient / Undetermined / 種類なし) は記録しない (200 は返す)', async () => {
    for (const bounceType of ['Temporary', 'Transient', 'Undetermined', '']) {
      const res = await POST(signedRequest(bouncedEvent('soft@example.com', bounceType)));
      expect(res.status).toBe(200);
    }
    expect(mocks.upsertCalls).toHaveLength(0);
    expect(mocks.rows.size).toBe(0);
  });

  it('苦情 (email.complained) は reason = complaint で入れる', async () => {
    const res = await POST(signedRequest(complainedEvent('spam-report@example.com')));
    expect(res.status).toBe(200);
    expect(mocks.rows.get('spam-report@example.com')).toMatchObject({ reason: 'complaint' });
  });

  it('それ以外の種類 (email.delivered など) は何もせず 200', async () => {
    const delivered = { ...complainedEvent('ok@example.com'), type: 'email.delivered' };
    const res = await POST(signedRequest(delivered));
    expect(res.status).toBe(200);
    expect(mocks.upsertCalls).toHaveLength(0);
  });

  it('ログに生の宛先を残さない (マスクした宛先だけ)', async () => {
    await POST(signedRequest(bouncedEvent('hard@example.com', 'Permanent')));
    const logged = JSON.stringify([mocks.logInfo.mock.calls, mocks.logWarn.mock.calls, mocks.logError.mock.calls]);
    expect(logged).not.toContain('hard@example.com');
    expect(logged).toContain('h***@example.com');
  });

  it('停止リストへの書き込みに失敗したら 500 (Resend に送り直してもらう)。本文に DB のエラー文を出さない', async () => {
    mocks.upsertError = { message: 'relation "email_blacklist" does not exist', code: '42P01' };
    const res = await POST(signedRequest(bouncedEvent('hard@example.com', 'Permanent')));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('email_blacklist');
  });
});

describe('POST /api/webhooks/resend: 冪等', () => {
  it('同じイベントが何度届いても行は 1 つで、最初の理由と時刻のまま', async () => {
    const event = bouncedEvent('hard@example.com', 'Permanent');
    expect((await POST(signedRequest(event, { id: 'msg_same' }))).status).toBe(200);
    const first = { ...mocks.rows.get('hard@example.com')! };
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await POST(signedRequest(event, { id: 'msg_same' }))).status).toBe(200);
    expect(mocks.rows.size).toBe(1);
    expect(mocks.rows.get('hard@example.com')).toEqual(first);
  });

  it('苦情のあとにハードバウンスが届いても、運営が手で入れた行 (manual) でも、上書きしない', async () => {
    mocks.rows.set('manual@example.com', { email: 'manual@example.com', reason: 'manual', added_at: '2026-01-01T00:00:00.000Z' });
    await POST(signedRequest(complainedEvent('x@example.com')));
    await POST(signedRequest(bouncedEvent('x@example.com', 'Permanent')));
    await POST(signedRequest(bouncedEvent('manual@example.com', 'Permanent')));
    expect(mocks.rows.get('x@example.com')?.reason).toBe('complaint');
    expect(mocks.rows.get('manual@example.com')).toEqual({
      email: 'manual@example.com',
      reason: 'manual',
      added_at: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('受けた宛先へは送らない (Webhook → sendEmail の通し)', () => {
  it('ハードバウンスの宛先へは sendEmail が Resend を呼ばず suppressed を返し (dead の行を 1 行残す)。ほかの宛先は送信待ちに登録する (ok: true・Resend は呼ばない・queued の行が 1 行)', async () => {
    vi.stubEnv('RESEND_API_KEY', 'dummy-api-key-for-test');
    mocks.outboxRows.length = 0;
    mocks.emailsSend.mockResolvedValue({ data: { id: 'sent-id' }, error: null, headers: null });
    await POST(signedRequest(bouncedEvent('Hard@Example.com', 'Permanent')));

    const blocked = await sendEmail({ to: 'Hard@Example.com', from: 'noreply@example.test', subject: 's', text: 't', template: 'org_invite_new' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.code).toBe('suppressed');
    expect(mocks.outboxRows).toEqual([
      expect.objectContaining({ to_email: 'Hard@Example.com', status: 'dead', last_error_code: 'suppressed' }),
    ]);

    const sent = await sendEmail({ to: 'other@example.com', from: 'noreply@example.test', subject: 's', text: 't', template: 'org_invite_new' });
    expect(sent).toMatchObject({ ok: true, id: OUTBOX_ROW_ID });
    expect(mocks.outboxRows.filter((row) => row.status === 'queued')).toEqual([
      expect.objectContaining({ to_email: 'other@example.com', status: 'queued' }),
    ]);
    // 送るのは worker (GET /api/cron/email-outbox)。sendEmail は Resend を呼ばない
    expect(mocks.emailsSend).not.toHaveBeenCalled();
  });
});
