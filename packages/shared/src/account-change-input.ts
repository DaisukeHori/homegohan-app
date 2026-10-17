/**
 * ログイン中のパスワード変更・メールアドレス変更 (#1187) の、送信前の入力の検証 (Web とモバイルで同じ規則・同じ文言)
 *
 * 画面 (Web: src/app/(main)/settings/account/page.tsx・モバイル: apps/mobile/app/settings/account.tsx に載る
 * apps/mobile/src/components/settings/AccountCredentialsSection.tsx が、apps/mobile/src/lib/account-credentials.ts を通して呼ぶ) は、
 * ここで弾けるものは Supabase のどの API も呼ばずに止める。
 */

import { validatePassword } from './password-policy';

/** 空白 (正規表現の \s と同じ範囲) を 1 文字でも含むか */
const WHITESPACE_PATTERN = /\s/;

/**
 * メールアドレスの形式の大まかな確認だけ行う (厳密な検証は Supabase 側がする)。
 * 空白を含まず、@ がちょうど 1 つで、その前に 1 文字以上あり、@ の後ろ (ドメイン) の
 * 先頭と末尾以外のどこかに . があること。
 *
 * 以前は `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` で判定していた。ドメインの部分の `[^\s@]+\.[^\s@]+` は、
 * "." が何度も続き、最後に合わない文字 (空白など) がある長い文字列で、"." の出現ごとに末尾まで読み直すため、
 * 時間が長さの 2 乗で増える (CodeQL js/polynomial-redos #42)。入力は利用者が打ったメールアドレスなので、
 * 同じ判定を、先頭から 1 回ずつ探すだけの書き方 (長さに比例する時間) に直した。判定の結果は以前の正規表現と同じ
 * (account-change-input.test.ts が以前の正規表現と突き合わせる)。
 */
export function isEmailChangeFormat(value: string): boolean {
  if (WHITESPACE_PATTERN.test(value)) return false;
  const at = value.indexOf('@');
  // @ の前に 1 文字以上・@ は 1 つだけ
  if (at < 1 || value.indexOf('@', at + 1) !== -1) return false;
  const domain = value.slice(at + 1);
  // ドメインの 2 文字目以降で最初の "." が、末尾の 1 文字より前にあること (= 前後に 1 文字以上ある "." がある)
  const dot = domain.indexOf('.', 1);
  return dot !== -1 && dot < domain.length - 1;
}

export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/** 入力に問題があれば利用者向けの理由を、無ければ null を返す。確かめる順番は画面に出す順番と同じ */
export function validatePasswordChangeInput(input: PasswordChangeInput): string | null {
  const { currentPassword, newPassword, confirmPassword } = input;
  if (!currentPassword) return '現在のパスワードを入力してください';
  if (!newPassword) return '新しいパスワードを入力してください';
  if (newPassword !== confirmPassword) return '新しいパスワードと確認用のパスワードが一致しません';
  const weakReason = validatePassword(newPassword);
  if (weakReason) return weakReason;
  if (newPassword === currentPassword) return '新しいパスワードは、現在のパスワードと違うものにしてください';
  return null;
}

export type EmailChangeInputResult = { ok: true; email: string } | { ok: false; message: string };

/**
 * 新しいメールアドレスを検証し、送る形 (前後の空白を除き小文字にそろえたもの) にする。
 * login / forgot-password と同じく、大文字小文字の違いで別のアドレスと取り違えないよう小文字にそろえる (#288)。
 */
export function normalizeEmailChangeInput(newEmail: string, currentEmail: string): EmailChangeInputResult {
  const normalized = newEmail.trim().toLowerCase();
  if (!normalized) return { ok: false, message: '新しいメールアドレスを入力してください' };
  if (!isEmailChangeFormat(normalized)) return { ok: false, message: 'メールアドレスの形式が正しくありません' };
  // Supabase は今と同じアドレスを指定してもエラーにせず何もしない。確認メールが届かないまま
  // 「送りました」と表示してしまわないよう、ここで止める
  if (normalized === currentEmail.trim().toLowerCase()) {
    return { ok: false, message: '現在のメールアドレスと同じです。別のメールアドレスを入力してください' };
  }
  return { ok: true, email: normalized };
}
