import { type Session, type User } from "@supabase/supabase-js";
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

import { classifyAuthError } from "../lib/authErrors";
import { getStoredSession, supabase } from "../lib/supabase";

type AuthState = {
  isLoading: boolean;
  session: Session | null;
  user: User | null;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let isMounted = true;

    /**
     * 起動時にセッションを復元する。
     * 保存済みのセッションはサーバーで検証するが、「サーバーが失効と明言したとき」だけ捨てる (#1038 F7-07)。
     * 機内モード・電波の悪い場所・サーバーの一時障害では、ログイン済みのまま起動する
     * (以前は getUser() のどんなエラーでも signOut しており、オフライン起動でウェルカム画面に落ちていた)。
     */
    async function restoreSession() {
      let trusted: Session | null = null;
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!isMounted) return;
        let cachedSession = data.session ?? null;

        if (!cachedSession && error && classifyAuthError(error) === "transient") {
          // access_token が期限切れで、更新しようとして通信に失敗した場合、getSession() は session: null を返す。
          // ただし保存済みのセッション (refresh_token) は消えていないので、それを信頼して画面を出す。
          // 通信が戻れば supabase-js が自動で更新し (TOKEN_REFRESHED)、下の onAuthStateChange で差し替わる。
          cachedSession = await getStoredSession();
          if (!isMounted) return;
        }

        if (!cachedSession) {
          setSession(null);
          return;
        }
        trusted = cachedSession;

        // AsyncStorage のキャッシュだけを信頼せず、サーバー側で JWT を検証する
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (!isMounted) return;

        if (!userError && userData.user) {
          setSession(cachedSession);
          return;
        }

        if (userError && classifyAuthError(userError) !== "invalid") {
          // 通信失敗・サーバー障害・レート制限: 失効とは限らないので、保存済みのセッションのまま続ける
          setSession(cachedSession);
          return;
        }

        // revoked / 期限切れトークンはセッションをクリアする。
        // サーバーが既に失効と答えているので、全端末のセッションを巻き込まず端末側だけ消す (scope: local)
        try {
          await supabase.auth.signOut({ scope: "local" });
        } catch {
          // 端末側の削除に失敗しても、サーバーが失効と答えたセッションは使わない
        }
        if (!isMounted) return;
        setSession(null);
      } catch {
        // 想定外の例外 (通信の失敗が例外として出た場合など)。失効が確認できていないので、保存済みのセッションがあれば維持する
        if (isMounted) setSession(trusted);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    restoreSession();

    const { data: sub } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === "INITIAL_SESSION") {
        // 起動時の復元は restoreSession() が行う。INITIAL_SESSION が null のときは、通信失敗で復元できなかっただけの
        // 可能性があるので採用しない (採用すると、上の復元結果を null で上書きしてしまう)。
        // 値があるときは、検証完了を待たずにすぐ画面を出すため採用する
        if (nextSession) {
          setSession(nextSession);
          setIsLoading(false);
        }
        return;
      }
      setSession(nextSession);
      setIsLoading(false);
    });

    return () => {
      isMounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value: AuthState = useMemo(
    () => ({
      isLoading,
      session,
      user: session?.user ?? null,
    }),
    [isLoading, session]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
