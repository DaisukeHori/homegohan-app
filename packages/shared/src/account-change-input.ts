/**
 * ログイン中のパスワード変更・メールアドレス変更 (#1187) の、送信前の入力の検証 (Web とモバイルで同じ規則・同じ文言)
 *
 * 画面 (Web: src/app/(main)/settings/account/page.tsx・モバイル: apps/mobile/app/settings/account.tsx) は、
 * ここで弾けるものは Supabase のどの API も呼ばずに止める。
 */

import { validatePassword } from './password-policy';

/** 形式の大まかな確認だけ行う (厳密な検証は Supabase 側がする) */
export const EMAIL_CHANGE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  if (!EMAIL_CHANGE_PATTERN.test(normalized)) return { ok: false, message: 'メールアドレスの形式が正しくありません' };
  // Supabase は今と同じアドレスを指定してもエラーにせず何もしない。確認メールが届かないまま
  // 「送りました」と表示してしまわないよう、ここで止める
  if (normalized === currentEmail.trim().toLowerCase()) {
    return { ok: false, message: '現在のメールアドレスと同じです。別のメールアドレスを入力してください' };
  }
  return { ok: true, email: normalized };
}
