"use client";

// PostHog Web Provider
// Canonical: docs/design/operator/07-audit-monitoring.md §15.1, §15.5, §15.9
// Cookie 同意連携: docs/design/cross/08-legal-compliance.md §13

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  posthog,
  initPostHog,
  getAnalyticsConsent,
  ANALYTICS_CONSENT_KEY,
  ANALYTICS_CONSENT_EVENT,
} from "@/lib/posthog";
import { setAnalyticsAdapter, fireAnalytics } from "@homegohan/handson-tour-shared";

/**
 * PostHog Web Provider
 * - root layout (src/app/layout.tsx) の body 内でラップする
 * - Cookie 同意確認済みの場合のみ PostHog init を呼ぶ
 * - 認証ユーザー取得後に identify を呼ぶ (PII は含めない)
 * - setAnalyticsAdapter で共通 package に PostHog を接続する
 *
 * #1044 (F6-15): 同意状態は mount 時の 1 回だけでなく、
 * 同意変更のたびに (同一タブ/別タブどちらでも) 再評価する。
 * 同一タブでの opt-in は 'storage' イベントが発火しないため、
 * CustomEvent (ANALYTICS_CONSENT_EVENT) も監視する。
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const supabase = createClient();
    // identify / Web Vitals 登録は同意が有効な間に一度だけ行う
    // (opt-out → opt-in を繰り返しても Web Vitals リスナーが多重登録されないようにする)
    let identifyDone = false;

    // 認証ユーザーの identify + Web Vitals 計測 (PII 不可、operator/07 §15.5)
    const identifyAndTrackVitals = () => {
      if (identifyDone) return;
      identifyDone = true;
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
    };

    // 現在の同意状態を反映する (mount 時・opt-in/opt-out 時の両方から呼ばれる)
    const applyConsentState = () => {
      if (!getAnalyticsConsent()) {
        try {
          if (posthog.__loaded) {
            posthog.opt_out_capturing();
          }
        } catch {
          // ignore
        }
        return;
      }

      // PostHog init (production + 同意あり、initPostHog 冒頭でも同意ガードあり)
      // #1044 round-2: すでに init 済み (__loaded) の場合、initPostHog() は no-op のため
      // opt-out → opt-in を跨いだ際に capturing が再開されない。src/lib/posthog.ts の
      // optInPostHog() と等価に、__loaded 済みなら opt_in_capturing を明示的に呼ぶ。
      try {
        if (posthog.__loaded) {
          posthog.opt_in_capturing();
        } else {
          initPostHog();
        }
      } catch {
        // ignore
      }
      identifyAndTrackVitals();
    };

    // AnalyticsAdapter を共通 package に注入する (同意チェックは呼び出しの都度行う: F6-15)
    setAnalyticsAdapter({
      capture: (eventName, payload) => {
        if (!getAnalyticsConsent()) return;
        try {
          posthog.capture(eventName, payload as Record<string, unknown>);
        } catch {
          // ignore — analytics failure should not break app
        }
      },
    });

    // mount 時点の同意状態を反映
    applyConsentState();

    // Cookie 同意変更を監視: 別タブ (storage event) + 同一タブ (CustomEvent) の両方に対応
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key !== ANALYTICS_CONSENT_KEY) return;
      applyConsentState();
    };
    const handleConsentChangeEvent = () => {
      applyConsentState();
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener(ANALYTICS_CONSENT_EVENT, handleConsentChangeEvent);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener(ANALYTICS_CONSENT_EVENT, handleConsentChangeEvent);
    };
  }, []);

  return <>{children}</>;
}
