// @vitest-environment node
/**
 * StripeGateway の実装 (src/lib/billing/stripe-gateway.ts) の単体テスト (billing/01 §14.1 のテスト 21〜25・73・81・107)。
 * fetch を偽物に差し替え、Stripe へ送る要求 (メソッド・URL・ヘッダー・form-encode の本文) と、応答の扱いを見る。
 * 本物の Stripe には触れない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoggerError } = vi.hoisted(() => ({ mockLoggerError: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockLoggerError }),
  generateRequestId: () => 'req-test',
}));

import { createStripeGateway } from '@/lib/billing/stripe-gateway';
import { STRIPE_API_VERSION, StripeApiError, StripeNotConfiguredError, buildCheckoutSessionParams } from '@/lib/billing/core';

const SECRET_KEY = 'sk_test_unit_gateway_key';
const USER = '11111111-1111-4111-8111-111111111111';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function subscriptionJson(id: string, status = 'active'): Record<string, unknown> {
  return {
    id,
    object: 'subscription',
    customer: 'cus_1',
    status,
    metadata: {},
    items: { data: [{ id: `si_${id}`, price: { id: 'price_1', recurring: { interval: 'month' } } }] },
    start_date: 1_760_000_000,
    cancel_at_period_end: false,
  };
}

function sessionJson(id: string, status = 'open'): Record<string, unknown> {
  return { id, object: 'checkout.session', mode: 'subscription', status, url: `https://checkout.stripe.test/${id}` };
}

/** 呼ばれた順に応答を返す偽の fetch。送った要求は captured に残す */
function fakeFetch(responses: Array<{ status?: number; json: unknown; headers?: Record<string, string> }>) {
  const captured: Captured[] = [];
  let index = 0;
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(next.json), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  });
  return { impl: impl as unknown as typeof fetch, captured };
}

/** form-encode の本文を [キー, 値] の一覧にする (キーの角括弧は元に戻す) */
function formPairs(body: string | null): Array<[string, string]> {
  if (!body) return [];
  return body.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    return [decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1))];
  });
}

beforeEach(() => {
  vi.stubEnv('STRIPE_SECRET_KEY', SECRET_KEY);
  mockLoggerError.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createStripeGateway: 要求の形', () => {
  it('sends Stripe-Version, Bearer key, form-encoded body and Idempotency-Key for customers', async () => {
    const { impl, captured } = fakeFetch([{ json: { id: 'cus_new', object: 'customer' } }]);
    const gateway = createStripeGateway(impl);

    const customer = await gateway.createCustomer({ userId: USER, email: 'person@example.com' });

    expect(customer).toMatchObject({ id: 'cus_new', object: 'customer' });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://api.stripe.com/v1/customers');
    expect(captured[0].method).toBe('POST');
    expect(captured[0].headers).toMatchObject({
      authorization: `Bearer ${SECRET_KEY}`,
      'stripe-version': STRIPE_API_VERSION,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': `billing-customer:${USER}`,
    });
    expect(formPairs(captured[0].body)).toEqual([
      ['email', 'person@example.com'],
      ['metadata[user_id]', USER],
      ['preferred_locales[0]', 'ja'],
    ]);
    // メールが無ければ送らない (null は form-encode しない)
    const second = fakeFetch([{ json: { id: 'cus_2', object: 'customer' } }]);
    await createStripeGateway(second.impl).createCustomer({ userId: USER, email: null });
    expect(formPairs(second.captured[0].body).map(([key]) => key)).not.toContain('email');
    // 鍵のモード
    expect(gateway.mode).toBe('test');
  });

  it('createCheckoutSession sends allow_promotion_codes=true, client_reference_id and metadata[user_id] in the form body', async () => {
    const { impl, captured } = fakeFetch([{ json: sessionJson('cs_1') }]);
    const gateway = createStripeGateway(impl);
    const params = buildCheckoutSessionParams({
      customerId: 'cus_1',
      userId: USER,
      planKey: 'pro',
      interval: 'month',
      priceId: 'price_month',
      trialDays: 7,
      siteUrl: 'https://example.test',
    });

    await gateway.createCheckoutSession(params);

    expect(captured[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(captured[0].method).toBe('POST');
    // Checkout の作成は呼ぶたびに別の Idempotency-Key
    expect(captured[0].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const pairs = formPairs(captured[0].body);
    expect(pairs).toContainEqual(['allow_promotion_codes', 'true']);
    expect(pairs).toContainEqual(['client_reference_id', USER]);
    expect(pairs).toContainEqual(['metadata[user_id]', USER]);
    expect(pairs).toContainEqual(['metadata[plan_key]', 'pro']);
    expect(pairs).toContainEqual(['subscription_data[metadata][user_id]', USER]);
    expect(pairs).toContainEqual(['subscription_data[trial_period_days]', '7']);
    expect(pairs).toContainEqual(['line_items[0][price]', 'price_month']);
    expect(pairs).toContainEqual(['line_items[0][quantity]', '1']);
    expect(pairs).toContainEqual(['success_url', 'https://example.test/account/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}']);
    expect(pairs).toContainEqual(['payment_method_collection', 'always']);
    expect(pairs).toContainEqual(['mode', 'subscription']);
  });

  it('cancelSubscriptionNow sends DELETE with prorate=false&invoice_now=false', async () => {
    const { impl, captured } = fakeFetch([{ json: subscriptionJson('sub_1', 'canceled') }]);
    const result = await createStripeGateway(impl).cancelSubscriptionNow('sub_1');

    expect(result).toMatchObject({ id: 'sub_1', status: 'canceled' });
    expect(captured[0].method).toBe('DELETE');
    expect(captured[0].url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect(captured[0].body).toBe('prorate=false&invoice_now=false');
    expect(captured[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('anonymizeCustomer clears name/email/phone/description/address/shipping/metadata.user_id', async () => {
    const { impl, captured } = fakeFetch([{ json: { id: 'cus_1', object: 'customer' } }]);
    await createStripeGateway(impl).anonymizeCustomer('cus_1', '2026-10-16T00:00:00.000Z');

    expect(captured[0].method).toBe('POST');
    expect(captured[0].url).toBe('https://api.stripe.com/v1/customers/cus_1');
    expect(formPairs(captured[0].body)).toEqual([
      ['name', ''],
      ['email', ''],
      ['phone', ''],
      ['description', ''],
      ['address', ''],
      ['shipping', ''],
      ['metadata[user_id]', ''],
      ['metadata[anonymized_at]', '2026-10-16T00:00:00.000Z'],
    ]);
  });

  it('listCustomerSubscriptions sends GET /subscriptions?customer=<cus>&status=all&limit=100 with no body and follows has_more with starting_after', async () => {
    const { impl, captured } = fakeFetch([
      { json: { object: 'list', data: [subscriptionJson('sub_a'), subscriptionJson('sub_b', 'canceled')], has_more: true } },
      { json: { object: 'list', data: [subscriptionJson('sub_c')], has_more: false } },
    ]);

    const subs = await createStripeGateway(impl).listCustomerSubscriptions('cus_1');

    expect(subs.map((sub) => sub.id)).toEqual(['sub_a', 'sub_b', 'sub_c']);
    expect(captured).toHaveLength(2);
    expect(captured[0].method).toBe('GET');
    expect(captured[0].url).toBe('https://api.stripe.com/v1/subscriptions?customer=cus_1&status=all&limit=100');
    expect(captured[0].body).toBeNull();
    expect(captured[0].headers['content-type']).toBeUndefined();
    expect(captured[0].headers['idempotency-key']).toBeUndefined();
    expect(captured[1].url).toBe('https://api.stripe.com/v1/subscriptions?customer=cus_1&status=all&limit=100&starting_after=sub_b');
  });

  it('listOpenCheckoutSessions sends GET /checkout/sessions?customer=<cus>&status=open&limit=100 and follows has_more; expireCheckoutSession sends POST /checkout/sessions/<id>/expire with no params', async () => {
    const { impl, captured } = fakeFetch([
      { json: { object: 'list', data: [sessionJson('cs_a')], has_more: true } },
      { json: { object: 'list', data: [sessionJson('cs_b')], has_more: false } },
      { json: sessionJson('cs_a', 'expired') },
    ]);
    const gateway = createStripeGateway(impl);

    const sessions = await gateway.listOpenCheckoutSessions('cus_1');
    expect(sessions.map((session) => session.id)).toEqual(['cs_a', 'cs_b']);
    expect(captured[0].method).toBe('GET');
    expect(captured[0].url).toBe('https://api.stripe.com/v1/checkout/sessions?customer=cus_1&status=open&limit=100');
    expect(captured[0].body).toBeNull();
    expect(captured[1].url).toBe('https://api.stripe.com/v1/checkout/sessions?customer=cus_1&status=open&limit=100&starting_after=cs_a');

    const expired = await gateway.expireCheckoutSession('cs_a');
    expect(expired).toMatchObject({ id: 'cs_a', status: 'expired' });
    expect(captured[2].method).toBe('POST');
    expect(captured[2].url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_a/expire');
    expect(captured[2].body).toBe('');
  });

  it('path の id は URL エンコードする・Portal は return_url と locale を送る・取り直しは GET', async () => {
    const { impl, captured } = fakeFetch([
      { json: subscriptionJson('sub_x') },
      { json: { id: 'bps_1', url: 'https://billing.stripe.test/p' } },
      { json: subscriptionJson('sub_x') },
    ]);
    const gateway = createStripeGateway(impl);
    await gateway.retrieveSubscription('sub_x/../y');
    expect(captured[0].url).toBe('https://api.stripe.com/v1/subscriptions/sub_x%2F..%2Fy');
    expect(captured[0].method).toBe('GET');

    expect(await gateway.createBillingPortalSession({ customerId: 'cus_1', returnUrl: 'https://example.test/account/billing' })).toEqual({
      id: 'bps_1',
      url: 'https://billing.stripe.test/p',
    });
    expect(captured[1].url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(formPairs(captured[1].body)).toEqual([
      ['customer', 'cus_1'],
      ['return_url', 'https://example.test/account/billing'],
      ['locale', 'ja'],
    ]);

    await gateway.updateCancelAtPeriodEnd('sub_x', true);
    expect(captured[2].method).toBe('POST');
    expect(captured[2].url).toBe('https://api.stripe.com/v1/subscriptions/sub_x');
    expect(captured[2].body).toBe('cancel_at_period_end=true');
  });
});

describe('createStripeGateway: 失敗の扱い', () => {
  it('maps non-2xx to StripeApiError with status/type/code/request-id and never exposes the raw message in .message', async () => {
    const raw = 'No such customer: cus_secret_detail (person@example.com)';
    const { impl } = fakeFetch([
      { status: 404, json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: raw } }, headers: { 'request-id': 'req_stripe_1' } },
    ]);

    const error = await createStripeGateway(impl)
      .retrieveSubscription('sub_1')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StripeApiError);
    const apiError = error as StripeApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.stripeType).toBe('invalid_request_error');
    expect(apiError.stripeCode).toBe('resource_missing');
    expect(apiError.requestId).toBe('req_stripe_1');
    expect(apiError.rawMessage).toBe(raw);
    expect(apiError.message).toBe('Stripe API の呼び出しに失敗しました');
    expect(apiError.message).not.toContain('cus_secret_detail');
    // 生の文面はログにだけ残す。鍵はログに渡さない
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(mockLoggerError.mock.calls[0]);
    expect(logged).toContain('resource_missing');
    expect(logged).not.toContain(SECRET_KEY);

    // 本文が JSON でない 5xx も StripeApiError (type / code は null)
    const notJson = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
    const second = await createStripeGateway(notJson)
      .retrieveSubscription('sub_1')
      .catch((caught: unknown) => caught);
    expect(second).toBeInstanceOf(StripeApiError);
    expect(second).toMatchObject({ status: 502, stripeType: null, stripeCode: null, rawMessage: null });

    // 2xx でも形が違えば StripeApiError (unexpected response shape)
    const wrongShape = fakeFetch([{ json: { id: 'sub_1', object: 'customer' } }]);
    const third = await createStripeGateway(wrongShape.impl)
      .retrieveSubscription('sub_1')
      .catch((caught: unknown) => caught);
    expect(third).toBeInstanceOf(StripeApiError);
    expect(third).toMatchObject({ status: 200, rawMessage: 'unexpected response shape' });
  });

  it('throws StripeNotConfiguredError when STRIPE_SECRET_KEY is unset', () => {
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect(() => createStripeGateway(fetchSpy)).toThrow(StripeNotConfiguredError);
    vi.stubEnv('STRIPE_SECRET_KEY', '   ');
    expect(() => createStripeGateway(fetchSpy)).toThrow(StripeNotConfiguredError);
    try {
      createStripeGateway(fetchSpy);
    } catch (error) {
      // message に変数名を入れない (#1182・#1434)
      expect((error as Error).message).not.toContain('STRIPE_SECRET_KEY');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // 前後の空白は除いて使う
    vi.stubEnv('STRIPE_SECRET_KEY', `  ${SECRET_KEY}  `);
    expect(createStripeGateway(fetchSpy).mode).toBe('test');
  });
});
