/**
 * RevenueCatGateway の実装 (billing/03 §8.3)。REST v1 を fetch で呼ぶ (SDK を入れない)。
 * 秘密の鍵 (REVENUECAT_SECRET_API_KEY) が無ければ createRevenueCatGateway が RevenueCatNotConfiguredError を投げる (route は 503)。
 */
import { getOptionalEnv } from '@/lib/env';
import { createLogger } from '@/lib/db-logger';
import {
  REVENUECAT_API_BASE_URL,
  REVENUECAT_REQUEST_TIMEOUT_MS,
  RevenueCatApiError,
  RevenueCatCustomerInfoSchema,
  RevenueCatNotConfiguredError,
  type RevenueCatGateway,
} from '@/lib/billing/iap-core';

const logger = createLogger('billing/revenuecat-gateway');

export function createRevenueCatGateway(fetchImpl: typeof fetch = fetch): RevenueCatGateway {
  const secretKey = getOptionalEnv('REVENUECAT_SECRET_API_KEY');
  if (!secretKey || secretKey.trim().length === 0) throw new RevenueCatNotConfiguredError();
  const key = secretKey.trim();
  return {
    async getSubscriber(appUserId) {
      const url = `${REVENUECAT_API_BASE_URL}/subscribers/${encodeURIComponent(appUserId)}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(REVENUECAT_REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        // 時間切れ (AbortSignal.timeout の TimeoutError)・接続の失敗も 502 にまとめる (§13.1 の文「通信に失敗しました」。S30)。生の文は残さず名前だけ
        const error = new RevenueCatApiError({ status: null, rawMessage: cause instanceof Error ? cause.name : null });
        logger.error('RevenueCat API に届きませんでした', error, { reason: 'fetch_failed' });
        throw error;
      }
      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new RevenueCatApiError({ status: response.status, rawMessage: typeof json === 'object' && json !== null ? JSON.stringify(json) : null });
        // 生の文面は app_logs にだけ残す (鍵・本文は残さない)
        logger.error('RevenueCat API が 2xx 以外を返しました', error, { status: response.status });
        throw error;
      }
      const parsed = RevenueCatCustomerInfoSchema.safeParse(json);
      if (!parsed.success) {
        const error = new RevenueCatApiError({ status: response.status, rawMessage: 'unexpected response shape' });
        logger.error('RevenueCat API の応答の形が想定と違いました', error, { issues: parsed.error.issues.map((i) => i.path.join('.')) });
        throw error;
      }
      return parsed.data;
    },
  };
}
