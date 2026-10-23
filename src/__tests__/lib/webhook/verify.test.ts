// @vitest-environment node
/**
 * #1184 Webhook の署名の確認 (src/lib/webhook/verify.ts)。
 * Resend の SDK (resend.webhooks.verify。中は svix) と同じ判定になることを、実物の SDK と突き合わせて確かめる。
 */
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Resend } from 'resend';
import {
  parseStripeSignatureHeader,
  verifyResendWebhook,
  verifyRevenueCatSignature,
  verifyRevenueCatWebhook,
  verifyStripeSignature,
  verifyStripeWebhook,
  verifySvixSignature,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  WebhookSecretMissingError,
} from '@/lib/webhook/verify';

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  generateRequestId: () => 'req-test',
}));

const SECRET = `whsec_${Buffer.from('unit-test-signing-key-0123456789').toString('base64')}`;
const PAYLOAD = JSON.stringify({ type: 'email.complained', data: { to: ['a@example.com'] } });
const ID = 'msg_unit_1';
const MS_PER_SECOND = 1000;

function sign(payload: string, id: string, timestamp: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('verifySvixSignature', () => {
  const nowMs = Date.UTC(2026, 9, 14, 0, 0, 0);
  const ts = String(nowMs / MS_PER_SECOND);

  it('正しい署名は ok', () => {
    expect(verifySvixSignature(PAYLOAD, { id: ID, timestamp: ts, signature: `v1,${sign(PAYLOAD, ID, ts)}` }, SECRET, nowMs)).toEqual({
      ok: true,
    });
  });

  it('秘密の入れ替え中に新旧 2 つの署名が並んでいても、どちらか 1 つが合えば ok', () => {
    const other = `whsec_${Buffer.from('old-key').toString('base64')}`;
    const signature = `v1,${sign(PAYLOAD, ID, ts, other)} v1,${sign(PAYLOAD, ID, ts)}`;
    expect(verifySvixSignature(PAYLOAD, { id: ID, timestamp: ts, signature }, SECRET, nowMs).ok).toBe(true);
  });

  it('本文・ID・時刻のどれか 1 つでも署名と違えば signature_mismatch', () => {
    const signature = `v1,${sign(PAYLOAD, ID, ts)}`;
    expect(verifySvixSignature(`${PAYLOAD} `, { id: ID, timestamp: ts, signature }, SECRET, nowMs)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
    expect(verifySvixSignature(PAYLOAD, { id: 'msg_other', timestamp: ts, signature }, SECRET, nowMs).ok).toBe(false);
    const nextSecond = String(Number(ts) + 1);
    expect(verifySvixSignature(PAYLOAD, { id: ID, timestamp: nextSecond, signature }, SECRET, nowMs).ok).toBe(false);
  });

  it('v1 以外の版・形の崩れた署名・長さの違う署名は合わないものとして扱う (例外にしない)', () => {
    const good = sign(PAYLOAD, ID, ts);
    for (const signature of [`v2,${good}`, good, 'v1,', 'v1,AAAA', '']) {
      const result = verifySvixSignature(PAYLOAD, { id: ID, timestamp: ts, signature }, SECRET, nowMs);
      expect(result.ok).toBe(false);
    }
  });

  it('ヘッダーが 1 つでも無ければ missing_headers', () => {
    const signature = `v1,${sign(PAYLOAD, ID, ts)}`;
    expect(verifySvixSignature(PAYLOAD, { id: null, timestamp: ts, signature }, SECRET, nowMs)).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
    expect(verifySvixSignature(PAYLOAD, { id: ID, timestamp: null, signature }, SECRET, nowMs).ok).toBe(false);
    expect(verifySvixSignature(PAYLOAD, { id: ID, timestamp: ts, signature: null }, SECRET, nowMs).ok).toBe(false);
  });

  it('時刻が整数の秒でなければ invalid_timestamp', () => {
    const bad = '1.5e9';
    expect(
      verifySvixSignature(PAYLOAD, { id: ID, timestamp: bad, signature: `v1,${sign(PAYLOAD, ID, bad)}` }, SECRET, nowMs),
    ).toEqual({ ok: false, reason: 'invalid_timestamp' });
  });

  it(`時刻のずれが ${WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS} 秒までは ok、それを超えたら (過去も未来も) timestamp_out_of_tolerance`, () => {
    const at = (offsetSeconds: number) => {
      const t = String(nowMs / MS_PER_SECOND + offsetSeconds);
      return verifySvixSignature(PAYLOAD, { id: ID, timestamp: t, signature: `v1,${sign(PAYLOAD, ID, t)}` }, SECRET, nowMs);
    };
    expect(at(-WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS).ok).toBe(true);
    expect(at(WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS).ok).toBe(true);
    expect(at(-WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 1)).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
    expect(at(WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1)).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('鍵が空になる秘密 ("whsec_" だけ) では、空の鍵で作った署名も受け付けない', () => {
    const emptyKeySignature = crypto.createHmac('sha256', Buffer.alloc(0)).update(`${ID}.${ts}.${PAYLOAD}`).digest('base64');
    expect(verifySvixSignature(PAYLOAD, { id: ID, timestamp: ts, signature: `v1,${emptyKeySignature}` }, 'whsec_', nowMs).ok).toBe(
      false,
    );
  });
});

describe('verifySvixSignature と Resend の SDK (svix) の判定が一致する', () => {
  const sdk = new Resend('re_dummy_key_for_test');

  function sdkAccepts(payload: string, id: string, timestamp: string, signature: string): boolean {
    try {
      sdk.webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret: SECRET });
      return true;
    } catch {
      return false;
    }
  }

  it('こちらで正しいとした署名を SDK も受け付け、こちらで弾いた署名を SDK も弾く', () => {
    const ts = String(Math.floor(Date.now() / MS_PER_SECOND));
    const good = `v1,${sign(PAYLOAD, ID, ts)}`;
    const wrongKey = `v1,${sign(PAYLOAD, ID, ts, `whsec_${Buffer.from('nope').toString('base64')}`)}`;
    const cases: Array<[string, string]> = [
      [PAYLOAD, good],
      [PAYLOAD, wrongKey],
      [`${PAYLOAD}x`, good],
    ];
    for (const [payload, signature] of cases) {
      const ours = verifySvixSignature(payload, { id: ID, timestamp: ts, signature }, SECRET).ok;
      expect(ours).toBe(sdkAccepts(payload, ID, ts, signature));
    }
    expect(sdkAccepts(PAYLOAD, ID, ts, good)).toBe(true);
  });
});

describe('verifyResendWebhook', () => {
  it('RESEND_WEBHOOK_SECRET が未設定 (空) なら WebhookSecretMissingError。message に変数名を入れない', () => {
    vi.stubEnv('RESEND_WEBHOOK_SECRET', '');
    expect(() => verifyResendWebhook(PAYLOAD, { id: ID, timestamp: '1', signature: 'v1,x' })).toThrow(WebhookSecretMissingError);
    try {
      verifyResendWebhook(PAYLOAD, { id: ID, timestamp: '1', signature: 'v1,x' });
    } catch (error) {
      expect((error as Error).message).not.toContain('RESEND_WEBHOOK_SECRET');
    }
  });

  it('環境変数の秘密で確かめる', () => {
    vi.stubEnv('RESEND_WEBHOOK_SECRET', SECRET);
    const nowMs = Date.UTC(2026, 9, 14, 0, 0, 0);
    const ts = String(nowMs / MS_PER_SECOND);
    expect(verifyResendWebhook(PAYLOAD, { id: ID, timestamp: ts, signature: `v1,${sign(PAYLOAD, ID, ts)}` }, nowMs)).toEqual({
      ok: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stripe (billing/01 §8.3): ヘッダー Stripe-Signature: t=<UNIX 秒>,v1=<hex>[,v1=…]。署名の入力は "<t>.<本文>"、鍵は秘密の文字列そのまま
// ─────────────────────────────────────────────────────────────────────────────

const STRIPE_SECRET = 'whsec_stripe_unit_test_secret_value';
const STRIPE_PAYLOAD = JSON.stringify({ id: 'evt_unit_1', object: 'event', type: 'customer.subscription.updated' });

/** Stripe と同じ作り方の v1 の署名 (hex)。鍵は秘密の文字列そのもの (Svix と違い base64 に戻さない) */
function stripeSign(payload: string, timestamp: string, secret = STRIPE_SECRET): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

describe('verifyStripeSignature (billing/01 §8.3)', () => {
  const nowMs = Date.UTC(2026, 9, 16, 0, 0, 0);
  const ts = String(nowMs / MS_PER_SECOND);

  it('verifyStripeSignature accepts a valid t/v1 signature over "t.payload" with the raw secret', () => {
    const header = `t=${ts},v1=${stripeSign(STRIPE_PAYLOAD, ts)}`;
    expect(verifyStripeSignature(STRIPE_PAYLOAD, header, STRIPE_SECRET, nowMs)).toEqual({ ok: true });
    // 秘密を base64 に戻した鍵 (Svix の形) で作った署名は合わない (鍵は文字列そのまま)
    const svixStyleKey = Buffer.from(STRIPE_SECRET.replace(/^whsec_/, ''), 'base64');
    const svixStyle = crypto.createHmac('sha256', svixStyleKey).update(`${ts}.${STRIPE_PAYLOAD}`).digest('hex');
    expect(verifyStripeSignature(STRIPE_PAYLOAD, `t=${ts},v1=${svixStyle}`, STRIPE_SECRET, nowMs)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
    // 知らない要素 (v0) は無視し、要素の順序に依らない
    expect(
      verifyStripeSignature(STRIPE_PAYLOAD, `v0=deadbeef,v1=${stripeSign(STRIPE_PAYLOAD, ts)},t=${ts}`, STRIPE_SECRET, nowMs),
    ).toEqual({ ok: true });
    expect(parseStripeSignatureHeader(`t=${ts},v1=aa,v0=bb,v1=cc`)).toEqual({ timestamp: ts, signatures: ['aa', 'cc'] });
  });

  it('verifyStripeSignature accepts when one of several v1 signatures matches (secret rotation)', () => {
    const header = `t=${ts},v1=${stripeSign(STRIPE_PAYLOAD, ts, 'whsec_old_secret')},v1=${stripeSign(STRIPE_PAYLOAD, ts)}`;
    expect(verifyStripeSignature(STRIPE_PAYLOAD, header, STRIPE_SECRET, nowMs)).toEqual({ ok: true });
    const onlyOld = `t=${ts},v1=${stripeSign(STRIPE_PAYLOAD, ts, 'whsec_old_secret')}`;
    expect(verifyStripeSignature(STRIPE_PAYLOAD, onlyOld, STRIPE_SECRET, nowMs)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('verifyStripeSignature rejects missing header, non-numeric t, out-of-tolerance t, mismatched v1, empty secret', () => {
    const good = stripeSign(STRIPE_PAYLOAD, ts);
    expect(verifyStripeSignature(STRIPE_PAYLOAD, null, STRIPE_SECRET, nowMs)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyStripeSignature(STRIPE_PAYLOAD, '', STRIPE_SECRET, nowMs)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyStripeSignature(STRIPE_PAYLOAD, `v1=${good}`, STRIPE_SECRET, nowMs)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyStripeSignature(STRIPE_PAYLOAD, `t=${ts}`, STRIPE_SECRET, nowMs)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyStripeSignature(STRIPE_PAYLOAD, `t=12a,v1=${good}`, STRIPE_SECRET, nowMs)).toEqual({ ok: false, reason: 'invalid_timestamp' });

    const edgePast = String(nowMs / MS_PER_SECOND - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS);
    expect(verifyStripeSignature(STRIPE_PAYLOAD, `t=${edgePast},v1=${stripeSign(STRIPE_PAYLOAD, edgePast)}`, STRIPE_SECRET, nowMs)).toEqual({
      ok: true,
    });
    const tooOld = String(nowMs / MS_PER_SECOND - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 1);
    expect(verifyStripeSignature(STRIPE_PAYLOAD, `t=${tooOld},v1=${stripeSign(STRIPE_PAYLOAD, tooOld)}`, STRIPE_SECRET, nowMs)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
    const tooNew = String(nowMs / MS_PER_SECOND + WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1);
    expect(verifyStripeSignature(STRIPE_PAYLOAD, `t=${tooNew},v1=${stripeSign(STRIPE_PAYLOAD, tooNew)}`, STRIPE_SECRET, nowMs)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });

    // 本文が 1 文字でも違えば合わない。長さの違う署名・hex でない署名は例外にせず合わないとする
    expect(verifyStripeSignature(`${STRIPE_PAYLOAD} `, `t=${ts},v1=${good}`, STRIPE_SECRET, nowMs)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
    expect(verifyStripeSignature(STRIPE_PAYLOAD, `t=${ts},v1=abcd`, STRIPE_SECRET, nowMs)).toEqual({ ok: false, reason: 'signature_mismatch' });
    expect(verifyStripeSignature(STRIPE_PAYLOAD, `t=${ts},v1=zz-not-hex`, STRIPE_SECRET, nowMs)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });

    // 空の秘密: 空の鍵で作った署名も受け付けない
    const emptyKeySig = crypto.createHmac('sha256', '').update(`${ts}.${STRIPE_PAYLOAD}`).digest('hex');
    expect(verifyStripeSignature(STRIPE_PAYLOAD, `t=${ts},v1=${emptyKeySig}`, '', nowMs)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
});

describe('verifyStripeWebhook (billing/01 §8.3)', () => {
  it('verifyStripeWebhook throws WebhookSecretMissingError when STRIPE_WEBHOOK_SECRET is unset or blank', () => {
    const nowMs = Date.UTC(2026, 9, 16, 0, 0, 0);
    const ts = String(nowMs / MS_PER_SECOND);
    const header = `t=${ts},v1=${stripeSign(STRIPE_PAYLOAD, ts)}`;
    for (const value of ['', '   ']) {
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', value);
      expect(() => verifyStripeWebhook(STRIPE_PAYLOAD, header, nowMs)).toThrow(WebhookSecretMissingError);
      try {
        verifyStripeWebhook(STRIPE_PAYLOAD, header, nowMs);
      } catch (error) {
        expect((error as Error).message).not.toContain('STRIPE_WEBHOOK_SECRET');
      }
    }
    vi.unstubAllEnvs();
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(() => verifyStripeWebhook(STRIPE_PAYLOAD, header, nowMs)).toThrow(WebhookSecretMissingError);

    // 秘密があれば、その文字列 (前後の空白を除く) で確かめる
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', `  ${STRIPE_SECRET}  `);
    expect(verifyStripeWebhook(STRIPE_PAYLOAD, header, nowMs)).toEqual({ ok: true });
    expect(verifyStripeWebhook(STRIPE_PAYLOAD, `t=${ts},v1=${stripeSign(STRIPE_PAYLOAD, ts, 'whsec_other')}`, nowMs)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });
});

describe('RevenueCat の Webhook の署名 (billing/03 §8.2・テスト 14〜16)', () => {
  /** RevenueCat の署名の秘密 (テスト用のダミー。本物の書式にしない) */
  const RC_SECRET = 'rc-unit-test-signing-secret'; // gitleaks:allow
  const RC_PAYLOAD = JSON.stringify({ api_version: '1.0', event: { id: 'evt_rc_1', type: 'RENEWAL', event_timestamp_ms: 1 } });
  /** 期待の署名は設計 (§14.1 テスト 15) のとおりテストの中で作る: HMAC-SHA256(秘密そのまま, "<t>.<本文>") の hex */
  const rcSign = (body: string, t: string, secret = RC_SECRET): string => crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

  it('verifyRevenueCatSignature returns missing_headers for a null or malformed header and invalid_timestamp for a non-numeric t', () => {
    const nowMs = Date.UTC(2026, 9, 21, 0, 0, 0);
    expect(verifyRevenueCatSignature(RC_PAYLOAD, null, RC_SECRET, nowMs)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyRevenueCatSignature(RC_PAYLOAD, '', RC_SECRET, nowMs)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyRevenueCatSignature(RC_PAYLOAD, 'garbage', RC_SECRET, nowMs)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyRevenueCatSignature(RC_PAYLOAD, 't=123', RC_SECRET, nowMs)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyRevenueCatSignature(RC_PAYLOAD, 'v1=abcd', RC_SECRET, nowMs)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyRevenueCatSignature(RC_PAYLOAD, `t=abc,v1=${rcSign(RC_PAYLOAD, 'abc')}`, RC_SECRET, nowMs)).toEqual({ ok: false, reason: 'invalid_timestamp' });
  });

  it('verifyRevenueCatSignature accepts HMAC-SHA256 hex of "<t>.<body>" keyed by the raw secret within WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS and rejects mismatch / stale timestamp', () => {
    const nowMs = Date.UTC(2026, 9, 21, 0, 0, 0);
    const ts = String(nowMs / MS_PER_SECOND);
    expect(verifyRevenueCatSignature(RC_PAYLOAD, `t=${ts},v1=${rcSign(RC_PAYLOAD, ts)}`, RC_SECRET, nowMs)).toEqual({ ok: true });
    // 許容の端 (ちょうど 5 分) は通り、それを 1 秒超えると通らない (前後どちらも)
    const edge = String(nowMs / MS_PER_SECOND - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS);
    expect(verifyRevenueCatSignature(RC_PAYLOAD, `t=${edge},v1=${rcSign(RC_PAYLOAD, edge)}`, RC_SECRET, nowMs)).toEqual({ ok: true });
    for (const offset of [-(WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1), WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1]) {
      const stale = String(nowMs / MS_PER_SECOND + offset);
      expect(verifyRevenueCatSignature(RC_PAYLOAD, `t=${stale},v1=${rcSign(RC_PAYLOAD, stale)}`, RC_SECRET, nowMs)).toEqual({
        ok: false,
        reason: 'timestamp_out_of_tolerance',
      });
    }
    // 違う秘密・違う本文・違う時刻の署名は合わない
    expect(verifyRevenueCatSignature(RC_PAYLOAD, `t=${ts},v1=${rcSign(RC_PAYLOAD, ts, 'other-secret')}`, RC_SECRET, nowMs)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
    expect(verifyRevenueCatSignature(`${RC_PAYLOAD} `, `t=${ts},v1=${rcSign(RC_PAYLOAD, ts)}`, RC_SECRET, nowMs)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
    // 鍵は秘密の文字列そのまま (base64 で戻さない): Svix の形で base64 を戻した鍵の署名は合わない
    const decodedKeySig = crypto.createHmac('sha256', Buffer.from(RC_SECRET, 'base64')).update(`${ts}.${RC_PAYLOAD}`).digest('hex');
    expect(verifyRevenueCatSignature(RC_PAYLOAD, `t=${ts},v1=${decodedKeySig}`, RC_SECRET, nowMs)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('verifyRevenueCatWebhook throws WebhookSecretMissingError when REVENUECAT_WEBHOOK_SECRET is missing', () => {
    const nowMs = Date.UTC(2026, 9, 21, 0, 0, 0);
    const ts = String(nowMs / MS_PER_SECOND);
    const header = `t=${ts},v1=${rcSign(RC_PAYLOAD, ts)}`;
    for (const value of ['', '   ']) {
      vi.stubEnv('REVENUECAT_WEBHOOK_SECRET', value);
      expect(() => verifyRevenueCatWebhook(RC_PAYLOAD, header, nowMs)).toThrow(WebhookSecretMissingError);
      try {
        verifyRevenueCatWebhook(RC_PAYLOAD, header, nowMs);
      } catch (error) {
        expect((error as Error).message).not.toContain('REVENUECAT_WEBHOOK_SECRET');
      }
    }
    vi.unstubAllEnvs();
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
    expect(() => verifyRevenueCatWebhook(RC_PAYLOAD, header, nowMs)).toThrow(WebhookSecretMissingError);
    // 秘密があれば、その文字列 (前後の空白を除く) で確かめる
    vi.stubEnv('REVENUECAT_WEBHOOK_SECRET', `  ${RC_SECRET}  `);
    expect(verifyRevenueCatWebhook(RC_PAYLOAD, header, nowMs)).toEqual({ ok: true });
    expect(verifyRevenueCatWebhook(RC_PAYLOAD, `t=${ts},v1=${rcSign(RC_PAYLOAD, ts, 'other-secret')}`, nowMs)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });
});
