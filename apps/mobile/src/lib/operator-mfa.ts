/**
 * 運営ロールの MFA (二段階認証) — アプリの確認画面の I/O (#1176 / #1707 段 D)
 *
 * 正典: docs/design/cross/12-operator-mfa.md §16.2。
 * 判定そのものは mfa-gate.ts の純関数 (decideMobileOperatorGate)。ここは端末の Supabase client から AAL を読むだけ。
 */
import { supabase } from './supabase';
import { decideMobileOperatorGate, toMobileAal, type MobileOperatorGate } from './mfa-gate';

/** AAL を読めなかった (通信の失敗など)。呼び出し側 (NativeMfaVerifyModal など) は先へ進まず、再試行を出す */
export class OperatorMfaGateError extends Error {
  constructor() {
    super('二段階認証の状態を確認できませんでした。');
    this.name = 'OperatorMfaGateError';
  }
}

/**
 * いまのネイティブのセッションの AAL で判定する (ロールは読まない)。
 * WebView から確認を頼まれたとき (NativeMfaVerifyModal §16.4) に使う: 頼んだのは Web のゲートなので、ロールと猶予の判定はもう済んでいる。
 * 読めなければ (error・data が null・呼び出しの例外) OperatorMfaGateError
 */
export async function resolveSessionMfaGate(): Promise<MobileOperatorGate> {
  let result: Awaited<ReturnType<typeof supabase.auth.mfa.getAuthenticatorAssuranceLevel>>;
  try {
    result = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  } catch {
    throw new OperatorMfaGateError();
  }
  const { data, error } = result;
  if (error || !data) throw new OperatorMfaGateError();
  return decideMobileOperatorGate({
    currentLevel: toMobileAal(data.currentLevel),
    nextLevel: toMobileAal(data.nextLevel),
  });
}
