"use client";

// PostHog Web Provider
// Canonical: docs/design/operator/07-audit-monitoring.md §15.1, §15.5, §15.9
// Cookie 同意連携: docs/design/cross/08-legal-compliance.md §13

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { posthog, initPostHog, getAnalyticsConsent, ANALYTICS_CONSENT_KEY } from "@/lib/posthog";
import { setAnalyticsAdapter, fireAnalytics } from "@homegohan/handson-tour-shared";

/**
 * PostHog Web Provider
 * - root layout (src/app/layout.tsx) の body 内でラップする
 * - Cookie 同意確認済みの場合のみ PostHog init を呼ぶ
 * - 認証ユーザー取得後に identify を呼ぶ (PII は含めない)
 * - setAnalyticsAdapter で共通 package に PostHog を接続する
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Cookie 同意確認 (localStorage 代替)
    const hasConsent = getAnalyticsConsent();
    if (!hasConsent) {
      return;
    }

    // PostHog init (production + 同意あり)
    initPostHog();

    // AnalyticsAdapter を共通 package に注入
    setAnalyticsAdapter({
      capture: (eventName, payload) => {
        try {
          posthog.capture(eventName, payload as Record<string, unknown>);
        } catch {
          // ignore — analytics failure should not break app
        }
      },
    });

    // 認証ユーザーの identify (PII 不可、operator/07 §15.5)
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) return;

      const userId = data.user.id;

      // profile から非 PII 属性を取得
      supabase
        .from('user_profiles')
        .select('created_at, plan_key_cached')
        .eq('id', userId)
        .single()
        .then(({ data: profile }) => {
          try {
            posthog.identify(userId, {
              signup_at: profile?.created_at ?? null,
              platform: 'web',
              plan_key_cached: profile?.plan_key_cached ?? null,
            });
          } catch {
            // ignore
          }

          // Web Vitals 計測 (handson-tour 専用 analytics schema)
          // web-vitals v4+ では onFID は削除され onINP (Interaction to Next Paint) に置き換わった
          import('web-vitals').then(({ onLCP, onCLS, onINP }) => {
            const page = typeof window !== 'undefined' ? window.location.pathname : '/';
            const common = {
              user_id: userId,
              timestamp: new Date().toISOString(),
              platform: 'web' as const,
              app_version: '1.0.0',
              page,
            };
            onLCP((metric) => {
              fireAnalytics('web_vitals_lcp', { ...common, value_ms: metric.value });
            });
            onCLS((metric) => {
              fireAnalytics('web_vitals_cls', { ...common, value: metric.value });
            });
            onINP((metric) => {
              fireAnalytics('web_vitals_inp', { ...common, value_ms: metric.value });
            });
          }).catch(() => {
            // web-vitals unavailable — ignore
          });
        });
    });

    // Cookie 同意変更を監視 (storage event)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === ANALYTICS_CONSENT_KEY) {
        if (e.newValue === 'false' || e.newValue === null) {
          try {
            posthog.opt_out_capturing();
          } catch {
            // ignore
          }
        } else if (e.newValue === 'true') {
          try {
            posthog.opt_in_capturing();
          } catch {
            // ignore
          }
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  return <>{children}</>;
}
