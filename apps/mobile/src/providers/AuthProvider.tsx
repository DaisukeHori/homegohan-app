import { type Session, type User } from "@supabase/supabase-js";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { classifyAuthError } from "../lib/authErrors";
import { registerDeviceName } from "../lib/device-name";
import { identifyPurchases, resetPurchasesOnSignOut } from "../lib/purchases";
import {
  flushPendingPushTokenReleases,
  recordPushTokenRelease,
  recordPushTokenReleasesForStoredValues,
  releasePushTokenAfterSignedOut,
} from "../lib/pushTokenRelease";
import { getStoredSession, supabase } from "../lib/supabase";
import { clearUserScopedLocalData, clearUserScopedLocalDataAfterSignedOut } from "../lib/userScopedLocalData";

type AuthState = {
  isLoading: boolean;
  session: Session | null;
  user: User | null;
  /**
   * ネットワークに依存せず in-memory の session を即座に破棄する。
   *
   * Round-4 レビュー指摘 (#1037): `supabase.auth.signOut()` は、access token が失効していて更新もできない
   * (オフライン・5xx・失敗の控えの間) と、サーバーへのログアウトを呼ばずに `{ error }` を返すだけで、保管も残り
   * `SIGNED_OUT` イベントも発火せず、`onAuthStateChange` 経由の自動クリアが効かない
   * (このとき `clearSession` が画面の状態を消す本体)。access token が有効なうちなら、サーバーへのログアウトが失敗しても
   * supabase-js が保管を消して `SIGNED_OUT` を出す (auth-js 2.117。#1768)。
   * アカウント削除後の後片付けのように、サーバー側の状態は既に確定しているケースでこれを呼び、
   * `app/index.tsx` が古い session を見てホームタブへ戻すフラッシュを防ぐ。
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
 * | 設定のログアウト (退会の API が 401 を返したときのアカウントの画面のログアウトも同じ signOutOnDevice。#1562)、退会のあと、パスワード再設定のあと (reset-password.tsx の signOutWithCleanup)、Web からの sign-out (signOut.ts) | signOut.ts | 画面が持つ利用者 (パスワード再設定のあとは呼ぶ前のセッションの利用者 (#1720 段 C)、Web からのときは、処理の最初に控えた利用者) | push token の行の削除 (退会のあとは無し。削除が失敗・0 件なら、掃除が値を消す前に release の宛先を控える。#1706。通信はしない) → 掃除 → signOut。そのあと届く SIGNED_OUT で、SIGNED_OUT の行の掃除がもう一度走り、控えた宛先があれば release が消す |
 * | 上の行の signOut が、通信の失敗 (オフラインなど)・5xx で { error } を返した | signOut.ts (signOut の前の掃除だけ。(a) では SIGNED_OUT の行の掃除もそのあと走る) | 上の行と同じ | signOut の前の掃除のあとは、保管庫の access token の状態で 2 つの枝に分かれる。(a) access token が有効 (残り 90 秒未満で更新に失敗していても、失効の前なら有効): サーバーへのログアウトまで届いて失敗し、supabase-js (auth-js 2.117) は保管庫のセッションを消して SIGNED_OUT を出す (scope others を除く) ので、成功のときと同じく SIGNED_OUT の行の掃除と release が走る。(b) access token が失効していて、更新もできない (更新が接続の失敗・5xx で終わった、または失敗の控えの 60 秒の間): signOut はサーバーへのログアウトを呼ばずに { error } を返し、保管庫のセッションは残り、SIGNED_OUT も届かない (SIGNED_OUT の行の掃除と release は走らない)。設定のログアウトと退会のあと (signOutOnDevice・signOutAfterAccountDeletion) は、どちらの枝でも (と signOut が例外を投げたときも)、保管庫のセッションを端末だけで消し (clearStoredSessionLocally)、clearSession で画面の状態を消す (lastKnownUserIdRef は残る。下の clearSession の注)。(b) と例外では、これが後始末の本体で、(a) では supabase-js の消去と重なる (二重でも害は無い)。サーバーのセッションは、設定のログアウト (signOutOnDevice) では、サーバーへのログアウトが届かなければ失効しないまま残る。退会のあと (signOutAfterAccountDeletion) は、サーバーでの削除が済んでから呼ぶ (settings/account.tsx) ので、サーバーのセッションは auth.users の削除 (auth.admin.deleteUser) と一緒に既に消えている。パスワード再設定のあとと Web からの sign-out (signOutWithCleanup) は端末だけで消す処理を持たないので、(a) では SIGNED_OUT で未ログインになるが、(b) では保管庫のセッションと画面の状態が残る (ログイン中のまま。パスワード再設定のあとは、ログイン画面へ移っても (auth)/_layout.tsx がセッションを見てホームへ戻す)。push token の行を消しに行く経路 (signOutOnDevice・signOutWithCleanup) は、その削除が通信の失敗で済まなければ、掃除が値を消す前に release の宛先を控えてある (#1706)。(a) では SIGNED_OUT の release が控えを消しに行き、(b) では起動時に未ログインと決まったとき (flushPendingPushTokenReleases) か次の SIGNED_OUT で消す。パスワード再設定のあとと Web からの sign-out が (b) でログイン中のまま残ったときは、控えはその利用者の次の登録 (claim の成功) で外れるか、次のサインアウトで消す。退会のあとは行を消しに行かず、行は auth.users の削除と一緒に消えている (ON DELETE CASCADE) |
 * | Web からの session-expired で、getUser() が失効を見つけた (webViewAuthMessages.ts) | 先に SIGNED_OUT の行、続いて signOut.ts | SIGNED_OUT の行は直前に分かっていたセッションの利用者、signOut.ts は getUser() の前に控えた利用者 (同じ利用者) | getUser() が端末のセッションを消して SIGNED_OUT が届く → SIGNED_OUT の行の掃除 (push token の値は残す。次の削除と前後してよい) → push token の行の削除 (残した値を読む。SIGNED_OUT の release が先に消していて 0 件なら宛先を控える。#1706。release は 0 件で控えから外れるだけ) → 掃除 (値もここで消える) → signOut |
 * | 起動時、サーバーが失効と明言した (getUser() が invalid) | restoreSession | 保存済みのセッションの利用者 | push token の行の release の宛先を控える (#1636。通信はしない) → 掃除 → signOut({ scope: "local" })。そのあと届く SIGNED_OUT で、SIGNED_OUT の行の掃除と release (控えた宛先) が走る |
 * | 起動時、保存済みのセッションが無い (getSession() が null。refresh_token の失効・保管庫を読めない・一度もログインしていない) | restoreSession | 直前に分かっていたセッションの利用者。ふつうは分からず null (利用者別のキーを接頭辞で全員分消す) | supabase-js が既に消している。掃除の前に、端末に残っている push token の値を全部 release の宛先として控える (#1636。利用者が分からないので全部。通信はしない。下の注) → 掃除 → 控えた宛先の release を始める (待たない)。掃除が済んでから未ログインの画面を出す。ただし端末の Cookie の置き場の掃除は始めるだけで待たない (下の注) |
 * | 起動時、getSession() が通信の失敗で null を返し、保存済みのセッションも無い | restoreSession | 同上 | 同上 |
 * | 起動時、getSession() が例外を投げた | restoreSession | 同上 | 同上 |
 * | SIGNED_OUT (supabase-js の自動更新で refresh_token が失効と答えた・getUser() が失効を見つけて端末のセッションを消した・上の行の signOut) | onAuthStateChange (clearUserScopedLocalDataAfterSignedOut) | 直前に分かっていたセッションの利用者 (無ければ null) | supabase-js が既に消している。画面はすぐ未ログインにし、掃除はそのあと (下の注)。この端末の push token の値だけは残す (下の注)。端末の Cookie の置き場の掃除は待たない (下の注)。掃除のあと、残した値で user_push_tokens の行をセッション無しで消す (pushTokenRelease.ts の releasePushTokenAfterSignedOut。利用者が分からない (null) ときは残っている値を全部。#1636。下の注) |
 *
 * SIGNED_OUT の掃除が push token の値 (push_token_value_v1:<利用者>) を残す理由: SIGNED_OUT は、signOut.ts がその値を読んで
 * user_push_tokens の行を消すより前に届くことがある (上の session-expired の行。ほかに、ログアウトの途中で自動更新が失効を答えたとき)。
 * 先に消すと、signOut.ts が値を読めず、端末から取り直せなければ行が残り、共有端末で前の利用者宛ての通知が届く (#1038 F7-10)。
 * 値はこの端末のトークンでどの利用者でも同じ値になり、利用者の ID 付きのキーなので次の利用者は読まない。signOut.ts を通らない
 * SIGNED_OUT (自動更新の失効) では値が残るが、その利用者が次にログインしたときの登録で書き直され、起動時に未ログインと決まったときの
 * 掃除 (ID なし) で消える。
 *
 * SIGNED_OUT の行の消し方 (#1636): signOut.ts を通らない SIGNED_OUT (自動更新の失効など) では、セッションが無いので RLS では
 * user_push_tokens の行を消せない。そこで、SIGNED_OUT の掃除のあとに、残した値と端末の秘密の値 (pushInstallSecret.ts) で、
 * セッション無しの release の API を呼ぶ (pushTokenRelease.ts の releasePushTokenAfterSignedOut)。消せなかったら宛先を控え、
 * 起動時に未ログインと決まったとき (flushPendingPushTokenReleases) と次の SIGNED_OUT でやり直す。どちらも画面は待たない。
 * サインアウトした利用者が分からないとき (アプリが閉じている間に refresh_token が失効し、次の起動で supabase-js の初期化がセッションを
 * 消したときなど。lastKnownUserIdRef は null) は、端末に残っている値 (push_token_value_v1:<利用者>) を全部宛先にする。
 * 起動時に未ログインと決まったときは、ID なしの掃除がその値を消すので、掃除の前に控える (recordPushTokenReleasesForStoredValues)。
 * SIGNED_OUT の掃除は値を残すので、掃除のあとの release (releasePushTokenAfterSignedOut(null)) が読む。
 * どちらも端末は未ログインなので、残っている値はどれもサインアウトした利用者のもの。保管庫を読めない起動 (実はログイン中) では
 * ログイン中の利用者の値も宛先になるが、端末の秘密の値も同じ保管庫で読めないので、やり直しは通信せずに控えを残し、次にセッションが
 * 戻った起動の登録 (claim の成功) が同じトークンの控えを外す (ログイン中の利用者の行は消さない)。
 * signOut.ts を通った SIGNED_OUT では、signOut.ts が値を先に消しているので、release は控えのやり直しだけをする。行は、signOut.ts の
 * 削除で消えているか、削除が失敗・0 件だったとき (退会の API が 401 を返したときのログアウトのように、セッションが既に失効しているなど) は
 * signOut.ts が値を消す前に控えた宛先として、このやり直しが消す (#1706)。
 * Web の session-expired では、signOut.ts の削除と release が同じ行を消しに行くことがある (どちらかが 0 件になるだけで害は無い)。
 *
 * 二重に掃除しても害は無い:
 *   - AsyncStorage: 同じキーを消し直すだけ (消えているキーの削除はエラーにならない)
 *   - WebView の localStorage: 掃除の ID が新しくなるだけで、次に開く WebView が一度だけ消す。二度目の掃除が頼まれるのは
 *     利用者がまだログインしていない間なので、次の利用者が書いた値は消さない
 * SIGNED_OUT の掃除は画面を未ログインにしたあとに走る。次の利用者がログイン (人の操作で数秒) するより、掃除 (端末の中の読み書きで
 * 数ミリ秒) のほうが先に終わる。万一ログインのほうが先でも、消えるのは次の利用者の設定の値で、前の利用者の値が残ることはない。
 * 画面を掃除の完了まで待たせないのは、失効したセッションで画面を出し続けないため。
 *
 * 端末の Cookie の置き場の掃除 (Networking.clearCookies。userScopedLocalData.ts の WebViewNativeCookieClearWait) を待つのは、
 * このあとにサインアウトする経路 (signOut.ts・起動時の失効の明言) だけ (#1647)。起動時に未ログインと決まったときと SIGNED_OUT は、
 * サインアウトが済んでいて待っても順は変わらないので、始めるだけで待たない。待つと、ネイティブから知らせが来ない端末では、
 * 未ログインで起動するたびに (一度もログインしていない端末も) 読み込み中の表示が上限 (WEB_VIEW_NATIVE_COOKIE_CLEAR_TIMEOUT_MS) まで延びる。
 * 未ログインの間に作られる Cookie で、消えると困るものは無い (webViewUserStorageCleanup.ts の「Cookie」)。掃除はふつう数十ミリ秒で
 * 終わり、次の利用者のログインとブリッジ (人の操作で数秒) より先に済む。万一ブリッジのほうが先でも、消えるのは次の利用者の
 * Cookie で、前の利用者の Cookie が残ることはない。
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
      if (userId) {
        lastKnownUserIdRef.current = userId;
        // ストアの購入 (RevenueCat) をこの利用者に結び付ける (billing/03 §8.10)。待たない。失敗はログだけ (購入の画面を開いたときにもう一度結び付ける)
        identifyPurchases(userId).catch((error: unknown) => {
          console.warn("[purchases] identify failed", error);
        });
      }
      setSession(next);
    }

    /**
     * 起動時に未ログインと決まったときの後始末。通常のログアウトと同じ掃除を通してから、未ログインにする。
     * 掃除する利用者は、直前に分かっていたセッションの利用者。起動時なのでふつうは分からず (supabase-js がセッションを既に消している)、
     * そのときは ID なしで掃除できる範囲 (利用者別のキーを接頭辞で全員分) を消す。
     * 端末の Cookie の置き場の掃除は始めるだけで待たない (上の表の注。#1647)
     */
    async function settleSignedOutAtStartup() {
      const userId = lastKnownUserIdRef.current;
      lastKnownUserIdRef.current = null;
      // 掃除が push token の値を消す前に、端末に残っている値を全部 release の宛先として控える (#1636。上の表の注)。
      // サインアウトした利用者 (アプリが閉じている間に refresh_token が失効した利用者など) はふつう分からないので、利用者を問わず全部。
      // 待つのは値を読むところまで (通信はしない。例外も投げない)
      try {
        await recordPushTokenReleasesForStoredValues();
      } catch {
        // 控えは例外を投げないが、万一投げても、掃除と未ログインは続ける
      }
      try {
        await clearUserScopedLocalData(userId, { webViewNativeCookies: "background" });
      } catch {
        // 掃除は例外を投げないが、万一投げても、未ログインにする
      }
      // 控えた宛先 (と、前に消せなかった宛先) の release を始める。通信を伴うので待たない (例外も拒否も投げない)
      void flushPendingPushTokenReleases();
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
          // 通信が戻ると supabase-js が更新し (TOKEN_REFRESHED)、下の onAuthStateChange で差し替わる。auth-js 2.117 は
          // やり直せる失敗も 60 秒控えるので、更新は最後の失敗から 60 秒が過ぎた最初の契機 (30 秒ごとの tick か getSession()) まで待つ
          // (通信が戻ってから最大約 90 秒。その間 getSession() は控えた失敗 (session: null) を返す)
          // (サーバーが refresh_token を失効と答えれば SIGNED_OUT になるので、失効の取りこぼしにはならない)。
          //
          // サーバーでの検証 (下の getUser()) は省く。getUser() も同じ更新を試み、同じ理由で失敗する (控えた失敗をすぐ受け取る)。
          // supabase-js は更新に失敗すると約 25 秒かけてやり直すので、検証を続けると、
          // 読み込み中の表示がその分さらに長くなる (2.105 の実測で、getSession() と getUser() を合わせて約 100 秒。
          // 2.117 は初期化の失敗を控え、getSession() は控えた失敗をすぐ返すので、約 25 秒で済む)。
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
        // 掃除は例外を投げないが、万一投げても、失効したセッションを使い続けない (下の catch で保存済みに戻さない) よう、ここで受ける。
        // この経路は signOut.ts を通らず、掃除が push token の値を消すので、その前に user_push_tokens の行の release の宛先を控える
        // (#1636。通信はしない。このあとに届く SIGNED_OUT の release が消す。上の表の注)
        try {
          await recordPushTokenRelease(cachedSession.user?.id ?? null);
        } catch {
          // 控えは例外を投げないが、万一投げても、サインアウトは続ける
        }
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
          // この端末のログインに端末名を登録する (#1189。cross/16 §16)。待たない (失敗しても画面は変えない)
          registerDeviceName(nextSession.access_token).catch(() => undefined);
          applySession(nextSession);
          setIsLoading(false);
        }
        return;
      }
      if (event === "SIGNED_OUT") {
        // supabase-js がセッションを消した (ログアウト・refresh_token の失効・getUser() が失効を見つけたなど)。
        // 通常のログアウトと同じ掃除を通す (#1615)。画面はすぐ未ログインにし、掃除はそのあと (上の表の注)。
        // push token の値は残す (このあとに signOut.ts が読んで user_push_tokens の行を消すことがある。上の表の注)。
        // 掃除のあと、残した値で user_push_tokens の行をセッション無しで消す (#1636。利用者が分からない (null) ときは、
        // 残っている値を全部。上の表の注)
        const userId = lastKnownUserIdRef.current;
        lastKnownUserIdRef.current = null;
        // ストアの購入 (RevenueCat) の利用者も外す (#1912。billing/03 §8.10)。signOut.ts を通らない SIGNED_OUT (自動更新の失効など) では
        // ここが唯一の外し。外さないと、次の利用者の logIn が通信で落ちたとき、SDK が前の利用者のままになる。
        // 待たない (失敗しても投げない)。identify と同じ列に並ぶので、このあとの次の利用者の identify より先に済む。
        // signOut.ts のあとに届く SIGNED_OUT では既に外れていて何もしない (二重でも害は無い)
        resetPurchasesOnSignOut().catch(() => undefined);
        setSession(null);
        setIsLoading(false);
        Promise.resolve()
          .then(() => clearUserScopedLocalDataAfterSignedOut(userId))
          .catch(() => {
            // 掃除は例外を投げないが、万一投げても、サインアウトは済んでいる
          })
          .then(() => releasePushTokenAfterSignedOut(userId))
          .catch(() => {
            // release は例外を投げないが、万一投げても、サインアウトは済んでいる
          });
        return;
      }
      if (event === "SIGNED_IN" && nextSession) {
        // 新しいセッション (= 新しい access token) の行に端末名を登録する (#1189。cross/16 §16)。待たない
        registerDeviceName(nextSession.access_token).catch(() => undefined);
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
