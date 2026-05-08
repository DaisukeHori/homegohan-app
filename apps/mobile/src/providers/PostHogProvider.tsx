// PostHog Mobile Provider
// Canonical: docs/design/operator/07-audit-monitoring.md §15.1, §15.5, §15.9

import React, { useEffect } from "react";
import { setAnalyticsAdapter } from "@homegohan/handson-tour-shared";
import { supabase } from "../lib/supabase";
import {
  initPostHogMobile,
  getPostHogClient,
  captureEvent,
} from "../lib/posthog";

/**
 * PostHog Mobile Provider
 * - apps/mobile/app/_layout.tsx の AuthProvider と並列で配置する
 * - PostHog を非同期初期化し、AnalyticsAdapter を共通 package に注入する
 * - 認証ユーザー取得後に identify を呼ぶ (PII は含めない, operator/07 §15.5)
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let isMounted = true;

    (async () => {
      // PostHog 初期化 (EXPO_PUBLIC_POSTHOG_KEY 未設定時はスキップ)
      const client = await initPostHogMobile();
      if (!isMounted || !client) return;

      // AnalyticsAdapter を共通 package に注入
      setAnalyticsAdapter({
        capture: (eventName, payload) => {
          // captureEvent 内で PII フィルタ + graceful degradation
          captureEvent(eventName, payload as Record<string, string | number | boolean | null>);
        },
      });

      // 認証ユーザーの identify (PII 不可, operator/07 §15.5)
      const { data: authData } = await supabase.auth.getUser();
      if (!isMounted || !authData.user) return;

      const userId = authData.user.id;

      // profile から非 PII 属性を取得
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('created_at, plan_key_cached')
        .eq('id', userId)
        .single();

      try {
        client.identify(userId, {
          signup_at: profile?.created_at ?? null,
          platform: 'ios',
          plan_key_cached: profile?.plan_key_cached ?? null,
        });
      } catch {
        // ignore
      }
    })();

    // 認証状態変化を監視: サインアウト時に reset
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        try {
          getPostHogClient()?.reset();
        } catch {
          // ignore
        }
      }
    });

    return () => {
      isMounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return <>{children}</>;
}
