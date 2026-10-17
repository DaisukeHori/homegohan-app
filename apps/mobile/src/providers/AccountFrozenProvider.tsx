import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

import {
  FROZEN_PROBE_API_PATH,
  accountFrozenEntryAfterProbe,
  accountFrozenErrorOf,
  accountFrozenStateOf,
  subscribeAccountFrozen,
  type AccountFrozenEntry,
  type AccountFrozenState,
} from "../lib/account-frozen";
import { getApi } from "../lib/api";
import { useAuth } from "./AuthProvider";

export type { AccountFrozenState } from "../lib/account-frozen";

type AccountFrozenContextValue = {
  /** 今の利用者の凍結の状態 (描画のその場で accountFrozenStateOf が決める。ログインの直後の描画から loading) */
  state: AccountFrozenState;
  /** 凍結しているかを確かめ直す。失敗しても例外を投げない (今の利用者の記録があれば保つ。無ければ unknown にする) */
  refresh: () => Promise<void>;
};

const AccountFrozenContext = createContext<AccountFrozenContextValue | null>(null);

/**
 * アカウントの凍結 (BAN) の状態 (#1861)。app/_layout.tsx が AuthProvider の内側・LegalConsentProvider の外側に置く
 * (規約の同意のゲートが「凍結中は畳まない」ために読む。凍結が先なのは Web の middleware の順と同じ)。
 *   - 利用者が変わるたびに (起動時のセッションの復元の直後を含む)、判定の API (FROZEN_PROBE_API_PATH) で確かめる。
 *     2xx → clear / 403 AUTH_ACCOUNT_FROZEN → frozen / それ以外の失敗 → unknown (止めない)
 *   - どの画面の API でも 403 AUTH_ACCOUNT_FROZEN が返ったら (getApi と生の fetch が notifyAccountFrozen で知らせる)、すぐ frozen にする。
 *     ここでは確かめ直さない (確かめる API も凍結中は 403 で、知らせが繰り返し届くため)
 *   - frozen のまま前面に戻ったら確かめ直す (一時的な凍結の期限が過ぎた・運営が解除した → 2xx で clear に戻り、ゲートが入口へ移す)
 * 記録は利用者ごと (AccountFrozenEntry.userId)。今の利用者の記録が無ければ、その描画から loading にする
 * (effect で loading にすると、ログインの直後の 1 回の描画が clear になり、入口・タブ・初期設定が中身を描いてしまう)。
 */
export function AccountFrozenProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [entry, setEntry] = useState<AccountFrozenEntry | null>(null);
  const state = accountFrozenStateOf(userId, entry);
  const requestSeq = useRef(0);
  const stateRef = useRef<AccountFrozenState>(state);
  stateRef.current = state;

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (userId === null) return; // 未ログイン: 確かめない (確かめ中の応答は seq で捨てる)
    let result: "ok" | "frozen" | "failed";
    try {
      await getApi().get<unknown>(FROZEN_PROBE_API_PATH);
      result = "ok";
    } catch (error) {
      result = accountFrozenErrorOf(error) ? "frozen" : "failed";
    }
    if (seq !== requestSeq.current) return; // 古い応答は捨てる (利用者が切り替わった後・後から確かめ直した後)
    setEntry((prev) => accountFrozenEntryAfterProbe(prev, userId, result));
  }, [userId]);

  // 利用者が変わるたびに確かめる (起動時のセッションの復元・ログイン・ログアウト・アカウントの切り替え)。
  // ログアウトしたら記録を捨てる (同じ利用者がログインし直したとき、前の記録を使わずに loading から始める)
  useEffect(() => {
    if (userId === null) setEntry(null);
    void refresh();
  }, [refresh, userId]);

  // /api の 403 AUTH_ACCOUNT_FROZEN → すぐ frozen (ゲートが凍結の画面だけにする)
  useEffect(() => {
    if (userId === null) return undefined;
    return subscribeAccountFrozen(() => {
      setEntry((prev) => accountFrozenEntryAfterProbe(prev, userId, "frozen"));
    });
  }, [userId]);

  // 凍結が解けたことに気づく: frozen のまま前面に戻ったら確かめ直す
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && stateRef.current === "frozen") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const value = useMemo<AccountFrozenContextValue>(() => ({ state, refresh }), [state, refresh]);
  return <AccountFrozenContext.Provider value={value}>{children}</AccountFrozenContext.Provider>;
}

export function useAccountFrozen(): AccountFrozenContextValue {
  const ctx = useContext(AccountFrozenContext);
  if (!ctx) throw new Error("useAccountFrozen must be used within <AccountFrozenProvider>");
  return ctx;
}
