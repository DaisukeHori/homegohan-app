import { type Session, type User } from "@supabase/supabase-js";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { supabase } from "../lib/supabase";

type AuthState = {
  isLoading: boolean;
  session: Session | null;
  user: User | null;
  /**
   * ネットワークに依存せず in-memory の session を即座に破棄する。
   *
   * Round-4 レビュー指摘 (#1037): `supabase.auth.signOut()` はネットワークエラー等で
   * 失敗すると `SIGNED_OUT` イベントを発火せず、`onAuthStateChange` 経由の自動クリアが
   * 効かないことがある。アカウント削除後の後片付けのように、サーバー側の状態は既に
   * 確定しているケースでこれを呼び、`app/index.tsx` が古い session を見てホームタブへ
   * 戻すフラッシュを防ぐ。
   */
  clearSession: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let isMounted = true;

    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        if (!isMounted) return;
        const cachedSession = data.session ?? null;

        if (cachedSession) {
          // AsyncStorage のキャッシュだけを信頼せず、サーバー側で JWT を検証する
          const { data: userData, error: userError } = await supabase.auth.getUser();
          if (!isMounted) return;

          if (userError || !userData.user) {
            // revoked / 期限切れトークンはセッションをクリアする
            await supabase.auth.signOut();
            if (!isMounted) return;
            setSession(null);
          } else {
            setSession(cachedSession);
          }
        } else {
          setSession(null);
        }

        setIsLoading(false);
      })
      .catch(() => {
        if (!isMounted) return;
        setIsLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setIsLoading(false);
    });

    return () => {
      isMounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const clearSession = useCallback(() => {
    setSession(null);
  }, []);

  const value: AuthState = useMemo(
    () => ({
      isLoading,
      session,
      user: session?.user ?? null,
      clearSession,
    }),
    [isLoading, session, clearSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}



