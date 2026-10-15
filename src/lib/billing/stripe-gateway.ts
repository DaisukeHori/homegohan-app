/**
 * StripeGateway の実装 (billing/01 §8.4)。Stripe の REST を fetch + form-encode で呼ぶ (SDK を入れない)。
 * 鍵 (STRIPE_SECRET_KEY) が無ければ createStripeGateway が StripeNotConfiguredError を投げる (route は 503)。
 */
import { getOptionalEnv } from '@/lib/env';
import { createLogger } from '@/lib/db-logger';
import {
  STRIPE_API_BASE_URL,
  STRIPE_API_VERSION,
  CUSTOMER_IDEMPOTENCY_KEY_PREFIX,
  STRIPE_LIST_PAGE_LIMIT,
  STRIPE_LOCALE,
  StripeApiError,
  StripeNotConfiguredError,
  StripeApiErrorBodySchema,
  StripeBillingPortalSessionSchema,
  StripeCheckoutSessionListSchema,
  StripeCheckoutSessionSchema,
  StripeCustomerSchema,
  StripeSubscriptionListSchema,
  StripeSubscriptionSchema,
  buildCustomerAnonymizeParams,
  stripeKeyMode,
  toFormBody,
  type StripeFormParams,
  type StripeGateway,
} from '@/lib/billing/core';
import type { z } from 'zod';

const logger = createLogger('billing/stripe-gateway');

/** 1 回の Stripe API 呼び出しの上限 (ms)。Webhook の route の maxDuration (30 秒) の中に取り直し + RPC が収まる値 */
const STRIPE_REQUEST_TIMEOUT_MS = 10_000;

interface StripeRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** GET はクエリ文字列に、POST / DELETE は本文に form-encode する */
  params?: StripeFormParams;
  idempotencyKey?: string;
}

/**
 * STRIPE_SECRET_KEY を読んで gateway を作る。鍵が無ければ StripeNotConfiguredError (route は 503)。
 * 鍵は一覧 (src/lib/env.ts) の任意の変数なので getOptionalEnv で読む (process.env.X! とは書かない)。
 */
export function createStripeGateway(fetchImpl: typeof fetch = fetch): StripeGateway {
  const secretKey = getOptionalEnv('STRIPE_SECRET_KEY');
  if (!secretKey || secretKey.trim().length === 0) throw new StripeNotConfiguredError();
  const key = secretKey.trim();

  async function call<T>(request: StripeRequest, schema: z.ZodType<T>): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': STRIPE_API_VERSION,
    };
    const init: RequestInit = { method: request.method, headers, signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS) };
    let url = `${STRIPE_API_BASE_URL}${request.path}`;
    if (request.method === 'GET') {
      const query = toFormBody(request.params ?? {});
      if (query.length > 0) url = `${url}?${query}`;
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = toFormBody(request.params ?? {});
      if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;
    }
    const response = await fetchImpl(url, init);
    const requestId = response.headers.get('request-id');
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsedError = StripeApiErrorBodySchema.safeParse(json);
      const error = new StripeApiError({
        status: response.status,
        stripeType: parsedError.success ? (parsedError.data.error.type ?? null) : null,
        stripeCode: parsedError.success ? (parsedError.data.error.code ?? null) : null,
        requestId,
        rawMessage: parsedError.success ? (parsedError.data.error.message ?? null) : null,
      });
      // 生の文面はここ (app_logs) にだけ残す。鍵・本文は残さない
      logger.error('Stripe API が 2xx 以外を返しました', error, {
        path: request.path, method: request.method, status: response.status,
        stripe_type: error.stripeType, stripe_code: error.stripeCode, request_id: requestId, raw_message: error.rawMessage,
      });
      throw error;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const error = new StripeApiError({ status: response.status, requestId, rawMessage: 'unexpected response shape' });
      logger.error('Stripe API の応答の形が想定と違いました', error, { path: request.path, issues: parsed.error.issues.map((i) => i.path.join('.')) });
      throw error;
    }
    return parsed.data;
  }

  /** Stripe の list API を has_more の間 starting_after で進めて全部返す (1 ページ STRIPE_LIST_PAGE_LIMIT 件) */
  async function listAll<T extends { id: string }>(
    path: string,
    params: StripeFormParams,
    schema: z.ZodType<{ data: T[]; has_more: boolean }>,
  ): Promise<T[]> {
    const all: T[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const page = await call({ method: 'GET', path, params: { ...params, limit: STRIPE_LIST_PAGE_LIMIT, starting_after: startingAfter } }, schema);
      all.push(...page.data);
      const last = page.data[page.data.length - 1];
      if (!page.has_more || last === undefined) return all;
      startingAfter = last.id;
    }
  }

  return {
    mode: stripeKeyMode(key),
    createCustomer: ({ userId, email }) =>
      call(
        {
          method: 'POST',
          path: '/customers',
          params: { email, metadata: { user_id: userId }, preferred_locales: [STRIPE_LOCALE] },
          idempotencyKey: `${CUSTOMER_IDEMPOTENCY_KEY_PREFIX}${userId}`,
        },
        StripeCustomerSchema,
      ),
    createCheckoutSession: (params) =>
      call({ method: 'POST', path: '/checkout/sessions', params, idempotencyKey: crypto.randomUUID() }, StripeCheckoutSessionSchema),
    retrieveCheckoutSession: (sessionId) =>
      call({ method: 'GET', path: `/checkout/sessions/${encodeURIComponent(sessionId)}` }, StripeCheckoutSessionSchema),
    retrieveSubscription: (subscriptionId) =>
      call({ method: 'GET', path: `/subscriptions/${encodeURIComponent(subscriptionId)}` }, StripeSubscriptionSchema),
    // status=all: 既定の一覧は canceled を含まないので、終端も含めて全部取り、呼ぶ側が終端を除く (§11)
    listCustomerSubscriptions: (customerId) =>
      listAll('/subscriptions', { customer: customerId, status: 'all' }, StripeSubscriptionListSchema),
    updateCancelAtPeriodEnd: (subscriptionId, cancelAtPeriodEnd) =>
      call(
        { method: 'POST', path: `/subscriptions/${encodeURIComponent(subscriptionId)}`, params: { cancel_at_period_end: cancelAtPeriodEnd } },
        StripeSubscriptionSchema,
      ),
    cancelSubscriptionNow: (subscriptionId) =>
      // 即時解約。日割りの返金はしない (prorate=false)。請求中の invoice はそのまま (invoice_now=false)
      call({ method: 'DELETE', path: `/subscriptions/${encodeURIComponent(subscriptionId)}`, params: { prorate: false, invoice_now: false } }, StripeSubscriptionSchema),
    // 退会: 開いたままの Checkout Session を列挙して閉じる (§11。閉じた Session は完了できない)
    listOpenCheckoutSessions: (customerId) =>
      listAll('/checkout/sessions', { customer: customerId, status: 'open' }, StripeCheckoutSessionListSchema),
    expireCheckoutSession: (sessionId) =>
      call({ method: 'POST', path: `/checkout/sessions/${encodeURIComponent(sessionId)}/expire` }, StripeCheckoutSessionSchema),
    anonymizeCustomer: async (customerId, anonymizedAtIso) => {
      await call({ method: 'POST', path: `/customers/${encodeURIComponent(customerId)}`, params: buildCustomerAnonymizeParams(anonymizedAtIso) }, StripeCustomerSchema);
    },
    createBillingPortalSession: ({ customerId, returnUrl }) =>
      call(
        { method: 'POST', path: '/billing_portal/sessions', params: { customer: customerId, return_url: returnUrl, locale: STRIPE_LOCALE } },
        StripeBillingPortalSessionSchema,
      ),
  };
}
