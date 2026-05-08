// PostHog Web SDK 初期化
// Canonical: docs/design/operator/07-audit-monitoring.md §15.1, §15.7, §15.9
// Cookie 同意連携: docs/design/cross/08-legal-compliance.md §13

import posthog from 'posthog-js';

export { posthog };

// PII フィルタキー (operator/07 §15.7)
const FORBIDDEN_KEYS = [
  'nickname', 'email', 'phone', 'address',
  'weight_kg', 'height_cm', 'age', 'gender',
  'allergies', 'dietary_preferences', 'nutrition_goal',
  'password', 'jwt', 'token',
] as const;

/**
 * localStorage キー: Cookie 同意 (計測) の opt-in 状態
 * 本来は cookie_consents テーブルから取得するが、
 * v1 では localStorage で代替 (cross/08 §13)
 */
export const ANALYTICS_CONSENT_KEY = 'cookie_consent_analytics';

/**
 * 計測 Cookie への同意状態を確認する
 */
export function getAnalyticsConsent(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(ANALYTICS_CONSENT_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * PostHog を初期化する。
 * - NODE_ENV が production かつ NEXT_PUBLIC_POSTHOG_KEY が設定済みの場合のみ init
 * - Cookie 同意なしの場合は init を呼ばない (cross/08 §13)
 */
export function initPostHog(): void {
  const key = process.env['NEXT_PUBLIC_POSTHOG_KEY'];
  const host = process.env['NEXT_PUBLIC_POSTHOG_HOST'] ?? 'https://us.i.posthog.com';

  // 環境変数未設定 or 開発環境はスキップ (graceful degradation)
  if (!key || process.env.NODE_ENV !== 'production') {
    return;
  }

  if (posthog.__loaded) {
    return;
  }

  posthog.init(key, {
    api_host: host,
    person_profiles: 'identified_only',
    autocapture: false,
    capture_pageview: false,
    persistence: 'localStorage',
    sanitize_properties: (props) => {
      for (const forbiddenKey of FORBIDDEN_KEYS) {
        if (forbiddenKey in props) {
          delete props[forbiddenKey as string];
        }
      }
      return props;
    },
  });
}

/**
 * 同意取消し時に呼ぶ: PostHog のキャプチャを停止する
 */
export function optOutPostHog(): void {
  if (typeof window === 'undefined') return;
  try {
    if (posthog.__loaded) {
      posthog.opt_out_capturing();
    }
  } catch {
    // ignore
  }
  try {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'false');
  } catch {
    // ignore
  }
}

/**
 * 同意時に呼ぶ: PostHog のキャプチャを再開する
 */
export function optInPostHog(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'true');
  } catch {
    // ignore
  }
  // init 済みの場合は opt_in_capturing
  if (posthog.__loaded) {
    posthog.opt_in_capturing();
  } else {
    initPostHog();
  }
}
