// @vitest-environment node
/**
 * POST /api/webhooks/stripe (src/app/api/webhooks/stripe/route.ts) のテスト (billing/01 §14.1 のテスト 37〜41・86・96)。
 * 署名の確認は本物 (verifyStripeWebhook。秘密は環境変数で与える)。Stripe と DB は偽物 (gateway・repository・service をモック)。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createStripeGateway: vi.fn(),
  claimStripeEvent: vi.fn(),
  finishStripeEvent: vi.fn(),
  handleStripeEvent: vi.fn(),
  recordStripeEventFailure: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = {
    debug: vi.fn(),
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    withUser: () => logger,
  };
  return { createLogger: () => logger, generateRequestId: () => 'req-test' };
});
vi.mock('@/lib/billing/stripe-gateway', () => ({ createStripeGateway: () => mocks.createStripeGateway() }));
vi.mock('@/lib/billing/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/repository')>();
  return {
    ...actual,
    createBillingRepository: () => ({
      claimStripeEvent: (...args: unknown[]) => mocks.claimStripeEvent(...args),
      finishStripeEvent: (...args: unknown[]) => mocks.finishStripeEvent(...args),
    }),
  };
});
vi.mock('@/lib/billing/service', () => ({
  handleStripeEvent: (...args: unknown[]) => mocks.handleStripeEvent(...args),
  recordStripeEventFailure: (...args: unknown[]) => mocks.recordStripeEventFailure(...args),
}));

import * as route from '@/app/api/webhooks/stripe/route';
import { BillingRpcError } from '@/lib/billing/repository';
import {
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_MAX_DURATION_SECONDS,
  StripeApiError,
  StripeNotConfiguredError,
  minimizeStripeEventPayload,
  StripeEventEnvelopeSchema,
} from '@/lib/billing/core';

const SECRET = 'whsec_route_unit_test_secret';
const MS_PER_SECOND = 1000;
const RAW_ERROR = 'duplicate key value violates unique constraint "secret_constraint" (person@example.com)';

const PERSONAL = {
  customer_email: 'person@example.com',
  customer_name: '山田 太郎',
  customer_details: { email: 'person@example.com', name: '山田 太郎', address: { line1: '東京都' } },
  invoice_pdf: 'https://pay.stripe.com/invoice/pdf',
};

function eventBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt_route_1',
    object: 'event',
    type: 'invoice.payment_failed',
    created: 1_760_000_000,
    livemode: false,
    data: { object: { id: 'in_1', object: 'invoice', customer: 'cus_1', subscription: 'sub_1', amount_due: 980, ...PERSONAL } },
    ...overrides,
  };
}

function sign(payload: string, secret = SECRET, nowMs = Date.now()): string {
  const t = String(Math.floor(nowMs / MS_PER_SECOND));
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}

function request(payload: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
}

function signed(body: Record<string, unknown> = eventBody()): Request {
  const payload = JSON.stringify(body);
  return request(payload, { 'stripe-signature': sign(payload) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', SECRET);
  mocks.createStripeGateway.mockReturnValue({ mode: 'test' });
  mocks.claimStripeEvent.mockResolvedValue('claimed');
  mocks.finishStripeEvent.mockResolvedValue(undefined);
  mocks.handleStripeEvent.mockResolvedValue({ action: 'synced', detail: 'past_due' });
  mocks.recordStripeEventFailure.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/webhooks/stripe: 入口', () => {
  it('413 for oversized body before verifying the signature', async () => {
    // 宣言された長さで先に断る (本文を読まない)
    const declared = await route.POST(request('{}', { 'content-length': String(STRIPE_WEBHOOK_MAX_BODY_BYTES + 1) }));
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: 'payload_too_large' });
    // 宣言が無くても、実際の本文が大きければ断る (署名は確かめない)
    const big = JSON.stringify({ pad: 'x'.repeat(STRIPE_WEBHOOK_MAX_BODY_BYTES) });
    const actual = await route.POST(request(big, { 'stripe-signature': sign(big) }));
    expect(actual.status).toBe(413);
    expect(mocks.createStripeGateway).not.toHaveBeenCalled();
    expect(mocks.claimStripeEvent).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('503 webhook_not_configured when the secret is missing; 401 on bad signature; 400 on bad JSON', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    const missing = await route.POST(signed());
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: 'webhook_not_configured' });
    expect(mocks.claimStripeEvent).not.toHaveBeenCalled();

    vi.stubEnv('STRIPE_WEBHOOK_SECRET', SECRET);
    const payload = JSON.stringify(eventBody());
    for (const header of [undefined, sign(payload, 'whsec_other'), sign(`${payload} `), sign(payload, SECRET, Date.now() - 10 * 60 * MS_PER_SECOND)]) {
      const res = await route.POST(request(payload, header ? { 'stripe-signature': header } : {}));
      expect(res.status, String(header)).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(mocks.claimStripeEvent).not.toHaveBeenCalled();

    // 署名は合うが JSON でない / 外形が違う (evt_ で始まらない・object が event でない)
    for (const bad of ['not json', JSON.stringify(eventBody({ id: 'sub_1' })), JSON.stringify(eventBody({ object: 'invoice' })), JSON.stringify({})]) {
      const res = await route.POST(request(bad, { 'stripe-signature': sign(bad) }));
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_payload' });
    }
    expect(mocks.createStripeGateway).not.toHaveBeenCalled();
    expect(mocks.claimStripeEvent).not.toHaveBeenCalled();
  });

  it('503 stripe_not_configured when STRIPE_SECRET_KEY is missing (gateway cannot be created)', async () => {
    mocks.createStripeGateway.mockImplementation(() => {
      throw new StripeNotConfiguredError();
    });
    const res = await route.POST(signed());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'stripe_not_configured' });
    expect(mocks.claimStripeEvent).not.toHaveBeenCalled();
  });

  it('200 ignored on livemode mismatch without touching the repository', async () => {
    mocks.createStripeGateway.mockReturnValue({ mode: 'live' });
    const res = await route.POST(signed(eventBody({ livemode: false })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: true });
    expect(mocks.claimStripeEvent).not.toHaveBeenCalled();
    expect(mocks.handleStripeEvent).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);

    // 逆向き (test の鍵に live のイベント) も同じ
    mocks.createStripeGateway.mockReturnValue({ mode: 'test' });
    const reverse = await route.POST(signed(eventBody({ livemode: true })));
    expect(await reverse.json()).toEqual({ received: true, ignored: true });

    // 鍵のモードが読めない (null) ときは不一致扱いにしない
    mocks.createStripeGateway.mockReturnValue({ mode: null });
    const unknownMode = await route.POST(signed(eventBody({ livemode: true })));
    expect(unknownMode.status).toBe(200);
    expect(await unknownMode.json()).toMatchObject({ received: true, action: 'synced' });
    expect(mocks.claimStripeEvent).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/webhooks/stripe: claim と処理', () => {
  it('200 duplicate when claim returns completed; 409 event_in_progress when claim returns in_progress; 200 synced when handled; 500 and finish(ok=false) on failure', async () => {
    mocks.claimStripeEvent.mockResolvedValueOnce('completed');
    const duplicate = await route.POST(signed());
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ received: true, duplicate: true });
    expect(mocks.handleStripeEvent).not.toHaveBeenCalled();

    mocks.claimStripeEvent.mockResolvedValueOnce('in_progress');
    const inProgress = await route.POST(signed());
    expect(inProgress.status).toBe(409);
    expect(await inProgress.json()).toEqual({ error: 'event_in_progress' });
    expect(mocks.handleStripeEvent).not.toHaveBeenCalled();
    expect(mocks.finishStripeEvent).not.toHaveBeenCalled();

    const handled = await route.POST(signed());
    expect(handled.status).toBe(200);
    expect(await handled.json()).toEqual({ received: true, action: 'synced', detail: 'past_due' });
    expect(mocks.handleStripeEvent).toHaveBeenCalledTimes(1);
    const [handleDeps, handledEvent] = mocks.handleStripeEvent.mock.calls[0];
    expect(handleDeps).toMatchObject({ gateway: { mode: 'test' } });
    expect(handledEvent).toMatchObject({ id: 'evt_route_1', type: 'invoice.payment_failed' });
    expect(mocks.finishStripeEvent).toHaveBeenCalledWith('evt_route_1', { ok: true });
    expect(mocks.recordStripeEventFailure).not.toHaveBeenCalled();

    // 失敗: 業務エラー / Stripe の失敗 / 想定外 → 固定のコードで failed を記録して 500
    const failures: Array<[unknown, string]> = [
      [new BillingRpcError('BILL_UNKNOWN_PLAN', 'sub_1'), 'BILL_UNKNOWN_PLAN'],
      [new StripeApiError({ status: 503, rawMessage: RAW_ERROR }), 'EXT_STRIPE_API_FAILED'],
      [new Error(RAW_ERROR), 'SYS_INTERNAL_ERROR'],
    ];
    for (const [error, code] of failures) {
      mocks.finishStripeEvent.mockClear();
      mocks.recordStripeEventFailure.mockClear();
      mocks.handleStripeEvent.mockRejectedValueOnce(error);
      const res = await route.POST(signed());
      expect(res.status, code).toBe(500);
      expect(mocks.recordStripeEventFailure).toHaveBeenCalledTimes(1);
      expect(mocks.recordStripeEventFailure.mock.calls[0][1]).toMatchObject({ id: 'evt_route_1' });
      expect(mocks.recordStripeEventFailure.mock.calls[0][2]).toBe(code);
      // 成功の finish は呼ばない
      expect(mocks.finishStripeEvent).not.toHaveBeenCalled();
    }

    // 失敗の記録 (finish(ok=false)) 自体が失敗しても 500 (行は processing のまま)
    mocks.handleStripeEvent.mockRejectedValueOnce(new Error('db down'));
    mocks.recordStripeEventFailure.mockRejectedValueOnce(new Error('finish failed'));
    expect((await route.POST(signed())).status).toBe(500);

    // 処理は成功したが finish(ok=true) が失敗 → 500 (failed を記録しない。行は processing のまま 15 分後の再送で再処理)
    mocks.recordStripeEventFailure.mockClear();
    mocks.finishStripeEvent.mockRejectedValueOnce(new Error('finish failed'));
    expect((await route.POST(signed())).status).toBe(500);
    expect(mocks.recordStripeEventFailure).not.toHaveBeenCalled();

    // claim 自体の失敗 → 500 (処理しない)
    mocks.handleStripeEvent.mockClear();
    mocks.claimStripeEvent.mockRejectedValueOnce(new Error('db down'));
    expect((await route.POST(signed())).status).toBe(500);
    expect(mocks.handleStripeEvent).not.toHaveBeenCalled();
  });

  it('claims the event with the minimized payload: the repository receives minimizeStripeEventPayload(event) and never customer_email / customer_name / customer_details', async () => {
    const body = eventBody();
    await route.POST(signed(body));
    expect(mocks.claimStripeEvent).toHaveBeenCalledTimes(1);
    const payload = mocks.claimStripeEvent.mock.calls[0][0];
    expect(payload).toEqual(minimizeStripeEventPayload(StripeEventEnvelopeSchema.parse(body)));
    expect(payload.data.object).toMatchObject({ id: 'in_1', customer: 'cus_1', subscription: 'sub_1', amount_due: 980 });
    const serialized = JSON.stringify(payload);
    for (const word of ['customer_email', 'customer_name', 'customer_details', 'person@example.com', '山田', '東京都', 'invoice_pdf', 'pay.stripe.com']) {
      expect(serialized, word).not.toContain(word);
    }
  });

  it('response bodies never contain the event payload or raw error text', async () => {
    const bodies: string[] = [];
    const collect = async (res: Response) => bodies.push(await res.text());

    await collect(await route.POST(signed()));
    mocks.claimStripeEvent.mockResolvedValueOnce('completed');
    await collect(await route.POST(signed()));
    mocks.claimStripeEvent.mockResolvedValueOnce('in_progress');
    await collect(await route.POST(signed()));
    mocks.handleStripeEvent.mockRejectedValueOnce(new Error(RAW_ERROR));
    await collect(await route.POST(signed()));
    mocks.handleStripeEvent.mockRejectedValueOnce(new StripeApiError({ status: 400, rawMessage: RAW_ERROR }));
    await collect(await route.POST(signed()));
    mocks.claimStripeEvent.mockRejectedValueOnce(new Error(RAW_ERROR));
    await collect(await route.POST(signed()));
    mocks.createStripeGateway.mockImplementationOnce(() => {
      throw new Error(RAW_ERROR);
    });
    await collect(await route.POST(signed()));
    await collect(await route.POST(request('not json', { 'stripe-signature': sign('not json') })));
    await collect(await route.POST(request(JSON.stringify(eventBody()), { 'stripe-signature': 'bad' })));
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    await collect(await route.POST(signed()));

    expect(bodies).toHaveLength(10);
    for (const text of bodies) {
      for (const word of ['secret_constraint', 'person@example.com', '山田', 'in_1', 'sub_1', 'cus_1', 'evt_route_1', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY']) {
        expect(text, word).not.toContain(word);
      }
    }
  });

  it('maxDuration is a numeric literal in the route source and equals STRIPE_WEBHOOK_MAX_DURATION_SECONDS', () => {
    expect(route.maxDuration).toBe(STRIPE_WEBHOOK_MAX_DURATION_SECONDS);
    const source = fs.readFileSync(path.join(process.cwd(), 'src/app/api/webhooks/stripe/route.ts'), 'utf8');
    expect(source).toMatch(/^export const maxDuration = \d+;/m);
    expect(source).toMatch(/^export const runtime = 'nodejs';/m);
    expect(source).toMatch(/^export const dynamic = 'force-dynamic';/m);
  });
});
