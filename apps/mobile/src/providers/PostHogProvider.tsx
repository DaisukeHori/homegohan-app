// PostHog Mobile Provider
// Canonical: docs/design/operator/07-audit-monitoring.md §15.1, §15.5, §15.9

import React, { useEffect } from "react";
import { Platform } from "react-native";
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
 * - ログインしたユーザーを identify する (PII は含めない, operator/07 §15.5)。
 *   以前はマウント時に 1 回だけ試していたため、未ログインで起動してあとからログインした場合や、
 *   別のユーザーでログインし直した場合に identify されなかった。認証状態の変化 (SIGNED_IN など) に追従する (#1049 F7-23)。
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let isMounted = true;
    // PostHog の初期化が終わったか。終わる前に届いたログインは、初期化の後に拾う
    let isReady = false;
    // 今 identify 済みのユーザー。同じユーザーで二重に identify しない
    let identifiedUserId: string | null = null;
    // identify 中に別のユーザーへ切り替わったとき、古い結果を捨てるための番号
    let identifySeq = 0;

    const identifyUser = async (userId: string) => {
      if (!isMounted || !isReady || identifiedUserId === userId) return;
      const client = getPostHogClient();
      if (!client) return;

      // SIGNED_OUT を挟まずに別のユーザーへ切り替わった場合は、先に reset して前のユーザーとの紐付けを切る
      if (identifiedUserId !== null) {
        try {
          client.reset();
        } catch {
          // ignore
        }
      }

      identifiedUserId = userId;
      const seq = ++identifySeq;

      // profile から非 PII 属性を取得 (失敗しても identify 自体は行う)
      let profile: { created_at?: string | null; plan_key_cached?: string | null } | null = null;
      try {
        const { data } = await supabase
          .from('user_profiles')
          .select('created_at, plan_key_cached')
          .eq('id', userId)
          .single();
        profile = data;
      } catch {
        // ignore
      }

      // 取得している間にサインアウト / 別ユーザーへ切り替わっていたら、古いユーザーの identify はしない
      if (!isMounted || seq !== identifySeq || identifiedUserId !== userId) return;

      try {
        client.identify(userId, {
          signup_at: profile?.created_at ?? null,
          // 以前は 'ios' 固定で、Android の利用者も ios として計上されていた
          platform: Platform.OS,
          plan_key_cached: profile?.plan_key_cached ?? null,
        });
      } catch {
        // ignore
      }
    };

    const resetUser = () => {
      identifiedUserId = null;
      identifySeq += 1;
      try {
        getPostHogClient()?.reset();
      } catch {
        // ignore
      }
    };

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

      isReady = true;

      // 初期化の前から既にログインしていた場合 (アプリ再起動など)
      try {
        const { data } = await supabase.auth.getSession();
        const userId = data.session?.user?.id;
        if (userId) await identifyUser(userId);
      } catch {
        // ignore
      }
    })();

    // 認証状態の変化を監視: ログイン時に identify、サインアウト時に reset
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        resetUser();
        return;
      }
      // INITIAL_SESSION: 起動時に保存済みのセッションが復元された / SIGNED_IN: ログインした
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user?.id) {
        void identifyUser(session.user.id);
      }
    });

    return () => {
      isMounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return <>{children}</>;
}
