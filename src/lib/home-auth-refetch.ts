import type { AuthChangeEvent } from "@supabase/supabase-js";

/**
 * ホームのデータを読み直すログインの状態の変化 (supabase.auth.onAuthStateChange の event。#2206 G3)。
 * INITIAL_SESSION (購読を始めたときに 1 回。開いたときの読み込みと重なる)・TOKEN_REFRESHED (トークンの更新。ログインしている人は
 * 変わらない) では読み直さない (読み直すたびに AI つきの栄養の分析を読み、LLM と上限に数えない枠の安全弁 nutrition_advice_auto を使う)。
 * SIGNED_IN は shouldRefetchHomeOnAuthChange が、前回読んだ利用者と違うときだけに絞る (#2227 H3)
 */
export const HOME_REFETCH_AUTH_EVENTS: ReadonlySet<AuthChangeEvent> = new Set<AuthChangeEvent>([
  "SIGNED_IN",
  "SIGNED_OUT",
  "USER_UPDATED",
]);

/**
 * 前回のホームの読み取りが確かめた利用者の id。
 *   - string: その利用者を読んだ
 *   - null: ログインしていないと確かめた (開いたときの読み込みで利用者がいなかった)
 *   - undefined: まだ確かめていない (開いたときの読み込みが利用者を確かめる前)
 */
export type HomeLastReadAuthUserId = string | null | undefined;

/**
 * ログインの状態の変化でホームのデータを読み直すか (#2227 H3)。
 * supabase-js はタブを前に戻したときにも同じ利用者の SIGNED_IN を出すことがあり、そのたびに読み直すと AI つきの栄養の分析を読み、
 * LLM を呼んで安全弁 nutrition_advice_auto を使う (上限に当たると自動のコメントが止まる)。SIGNED_IN は、前回読んだ利用者と違うとき
 * (別の人のログイン・ログインしていなかった) だけ読み直す。まだ確かめていないとき・セッションに利用者が無いときは読み直す
 * (読み落とすより 1 回多く読む側に寄せる)。SIGNED_OUT・USER_UPDATED はいつも読み直す
 *
 * @param event onAuthStateChange の event
 * @param sessionUserId onAuthStateChange の session の利用者の id (session が無ければ null / undefined)
 * @param lastReadUserId 前回のホームの読み取りが確かめた利用者の id
 */
export function shouldRefetchHomeOnAuthChange(
  event: AuthChangeEvent,
  sessionUserId: string | null | undefined,
  lastReadUserId: HomeLastReadAuthUserId,
): boolean {
  if (!HOME_REFETCH_AUTH_EVENTS.has(event)) return false;
  if (event !== "SIGNED_IN") return true;
  if (lastReadUserId === undefined) return true;
  if (sessionUserId === null || sessionUserId === undefined) return true;
  return sessionUserId !== lastReadUserId;
}
