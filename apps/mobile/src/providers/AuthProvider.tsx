import { type Session, type User } from "@supabase/supabase-js";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { classifyAuthError } from "../lib/authErrors";
import { getStoredSession, supabase } from "../lib/supabase";
import { clearUserScopedLocalData, clearUserScopedLocalDataAfterSignedOut } from "../lib/userScopedLocalData";

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

/**
 * サインアウトになる経路と、利用者別の端末データの掃除 (clearUserScopedLocalData) の関係 (#1599 / #1615)。
 * どの経路でも、同じ掃除を通す (CLAUDE.md: 消さないと、この端末で次にログインする別の利用者に前の利用者の値が残る)。
 *
 * | 経路 | 掃除を呼ぶ所 | 掃除する利用者の ID | サインアウトとの順 |
 * |---|---|---|---|
 * | 設定のログアウト、退会のあと、パスワード再設定のあと (reset-password.tsx の signOutWithCleanup)、Web からの sign-out (signOut.ts) | signOut.ts | 画面が持つ利用者 (パスワード再設定のあとは updateUser() が返した利用者、Web からのときは、処理の最初に控えた利用者) | push token の行の削除 (退会のあとは無し) → 掃除 → signOut。そのあと届く SIGNED_OUT で、SIGNED_OUT の行の掃除がもう一度走る |
 * | 上の行の signOut が、通信の失敗 (オフラインなど) で { error } を返した | signOut.ts (signOut の前の掃除だけ) | 上の行と同じ | supabase-js は保管庫のセッションを消さず、SIGNED_OUT も届かないので、SIGNED_OUT の行の掃除は走らない。設定のログアウトと退会のあと (signOutOnDevice・signOutAfterAccountDeletion) は、保管庫のセッションを端末だけで消し (clearStoredSessionLocally)、clearSession で画面の状態を消す (lastKnownUserIdRef は残る。下の clearSession の注)。サーバーのセッションは、設定のログアウト (signOutOnDevice) では、サーバーへのログアウトが届かなければ失効しないまま残る。退会のあと (signOutAfterAccountDeletion) は、サーバーでの削除が済んでから呼ぶ (settings/account.tsx) ので、サーバーのセッションは auth.users の削除 (auth.admin.deleteUser) と一緒に既に消えている。パスワード再設定のあとと Web からの sign-out (signOutWithCleanup) は端末だけで消す処理を持たず、保管庫のセッションと画面の状態が残る (ログイン中のまま。パスワード再設定のあとは、ログイン画面へ移っても (auth)/_layout.tsx がセッションを見てホームへ戻す)。push token の行を消しに行く経路 (signOutOnDevice・signOutWithCleanup) は、その削除が通信の失敗で済まなければ user_push_tokens の行が残り、控えた値は掃除で消える。退会のあとは行を消しに行かず、行は auth.users の削除と一緒に消えている (ON DELETE CASCADE) |
 * | Web からの session-expired で、getUser() が失効を見つけた (webViewAuthMessages.ts) | 先に SIGNED_OUT の行、続いて signOut.ts | SIGNED_OUT の行は直前に分かっていたセッションの利用者、signOut.ts は getUser() の前に控えた利用者 (同じ利用者) | getUser() が端末のセッションを消して SIGNED_OUT が届く → SIGNED_OUT の行の掃除 (push token の値は残す。次の削除と前後してよい) → push token の行の削除 (残した値を読む) → 掃除 (値もここで消える) → signOut |
 * | 起動時、サーバーが失効と明言した (getUser() が invalid) | restoreSession | 保存済みのセッションの利用者 | 掃除 → signOut({ scope: "local" })。そのあと届く SIGNED_OUT で、SIGNED_OUT の行の掃除がもう一度走る |
 * | 起動時、保存済みのセッションが無い (getSession() が null。refresh_token の失効・保管庫を読めない・一度もログインしていない) | restoreSession | 直前に分かっていたセッションの利用者。ふつうは分からず null (利用者別のキーを接頭辞で全員分消す) | supabase-js が既に消している。掃除が済んでから未ログインの画面を出す |
 * | 起動時、getSession() が通信の失敗で null を返し、保存済みのセッションも無い | restoreSession | 同上 | 同上 |
 * | 起動時、getSession() が例外を投げた | restoreSession | 同上 | 同上 |
 * | SIGNED_OUT (supabase-js の自動更新で refresh_token が失効と答えた・getUser() が失効を見つけて端末のセッションを消した・上の行の signOut) | onAuthStateChange (clearUserScopedLocalDataAfterSignedOut) | 直前に分かっていたセッションの利用者 (無ければ null) | supabase-js が既に消している。画面はすぐ未ログインにし、掃除はそのあと (下の注)。この端末の push token の値だけは残す (下の注) |
 *
 * SIGNED_OUT の掃除が push token の値 (push_token_value_v1:<利用者>) を残す理由: SIGNED_OUT は、signOut.ts がその値を読んで
 * user_push_tokens の行を消すより前に届くことがある (上の session-expired の行。ほかに、ログアウトの途中で自動更新が失効を答えたとき)。
 * 先に消すと、signOut.ts が値を読めず、端末から取り直せなければ行が残り、共有端末で前の利用者宛ての通知が届く (#1038 F7-10)。
 * 値はこの端末のトークンでどの利用者でも同じ値になり、利用者の ID 付きのキーなので次の利用者は読まない。signOut.ts を通らない
 * SIGNED_OUT (自動更新の失効) では値が残るが、その利用者が次にログインしたときの登録で書き直され、起動時に未ログインと決まったときの
 * 掃除 (ID なし) で消える。
 *
 * 二重に掃除しても害は無い:
 *   - AsyncStorage: 同じキーを消し直すだけ (消えているキーの削除はエラーにならない)
 *   - WebView の localStorage: 掃除の ID が新しくなるだけで、次に開く WebView が一度だけ消す。二度目の掃除が頼まれるのは
 *     利用者がまだログインしていない間なので、次の利用者が書いた値は消さない
 * SIGNED_OUT の掃除は画面を未ログインにしたあとに走る。次の利用者がログイン (人の操作で数秒) するより、掃除 (端末の中の読み書きで
 * 数ミリ秒) のほうが先に終わる。万一ログインのほうが先でも、消えるのは次の利用者の設定の値で、前の利用者の値が残ることはない。
 * 画面を掃除の完了まで待たせないのは、失効したセッションで画面を出し続けないため。
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  /**
   * 直前に分かっていたセッションの利用者の ID。SIGNED_OUT のときの nextSession は null なので、
   * 誰のキーを消すかはここから取る。画面の状態 (session) は onAuthStateChange の購読の時点の値で閉じ込められるので、ref に持つ
   */
  const lastKnownUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    /** セッションを画面の状態にし、利用者の ID を覚える (null のときは覚えている ID を残す。SIGNED_OUT の掃除で使う) */
    function applySession(next: Session | null) {
      const userId = next?.user?.id;
      if (userId) lastKnownUserIdRef.current = userId;
      setSession(next);
    }

    /**
     * 起動時に未ログインと決まったときの後始末。通常のログアウトと同じ掃除を通してから、未ログインにする。
     * 掃除する利用者は、直前に分かっていたセッションの利用者。起動時なのでふつうは分からず (supabase-js がセッションを既に消している)、
     * そのときは ID なしで掃除できる範囲 (利用者別のキーを接頭辞で全員分) を消す
     */
    async function settleSignedOutAtStartup() {
      const userId = lastKnownUserIdRef.current;
      lastKnownUserIdRef.current = null;
      try {
        await clearUserScopedLocalData(userId);
      } catch {
        // 掃除は例外を投げないが、万一投げても、未ログインにする
      }
      if (!isMounted) return;
      setSession(null);
    }

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
          // 通信が戻れば supabase-js が自動で更新し (TOKEN_REFRESHED)、下の onAuthStateChange で差し替わる
          // (サーバーが refresh_token を失効と答えれば SIGNED_OUT になるので、失効の取りこぼしにはならない)。
          //
          // サーバーでの検証 (下の getUser()) は省く。getUser() も同じ更新をもう一度試み、同じ理由で失敗する。
          // supabase-js は更新に失敗すると約 25 秒かけてやり直すので、検証を続けると、
          // 読み込み中の表示がその分 (約 50 秒) さらに長くなる (実測で、getSession() と getUser() を合わせて約 100 秒)。
          const stored = await getStoredSession();
          if (!isMounted) return;
          if (!stored) {
            // 保存済みのセッションも無い: 未ログインで起動する。通常のログアウトと同じ掃除を通す (#1615)
            await settleSignedOutAtStartup();
            return;
          }
          applySession(stored);
          return;
        }

        if (!cachedSession) {
          // 保存済みのセッションが無い (refresh_token の失効で supabase-js が消した・保管庫を読めない・一度もログインしていない)。
          // 未ログインで起動するので、通常のログアウトと同じ掃除を通す (#1615。前の利用者の値を次の利用者に残さない)
          await settleSignedOutAtStartup();
          return;
        }
        trusted = cachedSession;

        // AsyncStorage のキャッシュだけを信頼せず、サーバー側で JWT を検証する
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (!isMounted) return;

        if (!userError && userData.user) {
          applySession(cachedSession);
          return;
        }

        if (userError && classifyAuthError(userError) !== "invalid") {
          // 通信失敗・サーバー障害・レート制限: 失効とは限らないので、保存済みのセッションのまま続ける
          applySession(cachedSession);
          return;
        }

        // revoked / 期限切れトークンはセッションをクリアする。
        // サーバーが既に失効と答えているので、全端末のセッションを巻き込まず端末側だけ消す (scope: local)。
        // その前に、通常のログアウトと同じ掃除 (AsyncStorage の利用者別のキー・WebView の利用者別の localStorage) を通す
        // (#1599。CLAUDE.md: サインアウトの前に消す。消さないと、この端末で次にログインする別の利用者に前の利用者の値が残る)。
        // 掃除は例外を投げないが、万一投げても、失効したセッションを使い続けない (下の catch で保存済みに戻さない) よう、ここで受ける
        try {
          await clearUserScopedLocalData(cachedSession.user?.id ?? null);
        } catch {
          // 掃除に失敗しても、サインアウトは続ける
        }
        try {
          await supabase.auth.signOut({ scope: "local" });
        } catch {
          // 端末側の削除に失敗しても、サーバーが失効と答えたセッションは使わない
        }
        if (!isMounted) return;
        setSession(null);
      } catch {
        // 想定外の例外 (通信の失敗が例外として出た場合など)。失効が確認できていないので、保存済みのセッションがあれば維持する
        if (!isMounted) return;
        if (trusted) {
          applySession(trusted);
        } else {
          // getSession() 自体が例外を投げた: 未ログインで起動するので、通常のログアウトと同じ掃除を通す (#1615)
          await settleSignedOutAtStartup();
        }
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
          applySession(nextSession);
          setIsLoading(false);
        }
        return;
      }
      if (event === "SIGNED_OUT") {
        // supabase-js がセッションを消した (ログアウト・refresh_token の失効・getUser() が失効を見つけたなど)。
        // 通常のログアウトと同じ掃除を通す (#1615)。画面はすぐ未ログインにし、掃除はそのあと (上の表の注)。
        // push token の値は残す (このあとに signOut.ts が読んで user_push_tokens の行を消すことがある。上の表の注)
        const userId = lastKnownUserIdRef.current;
        lastKnownUserIdRef.current = null;
        setSession(null);
        setIsLoading(false);
        Promise.resolve()
          .then(() => clearUserScopedLocalDataAfterSignedOut(userId))
          .catch(() => {
            // 掃除は例外を投げないが、万一投げても、サインアウトは済んでいる
          });
        return;
      }
      applySession(nextSession);
      setIsLoading(false);
    });

    return () => {
      isMounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const clearSession = useCallback(() => {
    // lastKnownUserIdRef は戻さない: 呼ぶのは signOut.ts がその利用者の掃除を済ませたあとで、次のログインの SIGNED_IN が applySession で上書きするので、掃除の宛先は次の利用者から外れない (#1636)
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
