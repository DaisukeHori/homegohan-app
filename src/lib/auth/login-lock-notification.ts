/**
 * ログイン失敗のロックの通知 (#1165)。サーバー専用。POST /api/auth/login だけが呼ぶ。
 *
 * 設計 docs/design/cross/01-auth-session.md §8:
 *   - 10 回 → 本人へメール (renderLoginLockedEmail)。アカウントが無いメールアドレスには送らない。
 *   - 20 回 → 運営へ通知。運営への通知の手段は、このアプリにある運営の固定アドレス (ADMIN_NOTIFICATION_EMAIL) へのメールと、
 *     構造化ログ (app_logs の warn) の 2 つ。ADMIN_NOTIFICATION_EMAIL が無ければログだけ。
 * 送るのは、その段にちょうど届いた 1 回だけ (login-lock.ts の noticeFor)。
 *
 * - best-effort: 通知に失敗しても、ログインの応答 (ロック) は変えない。この関数は例外を投げない。
 *   失敗は構造化ログに残す。宛先のメールアドレスはログに残さない (伏せた形だけ)。
 * - 応答の時間からアカウントの有無が分からないよう、呼び出し側はこの関数を待たずに応答する (waitUntil で後ろで動かす)。
 * - 送信回数の制限 (invite-throttle) を通さない理由 (tests/email-send-throttle-contract.test.ts の EXEMPT_EMAIL_SENDERS):
 *   本人への宛先は、入力されたメールアドレスで登録されているアカウントの登録アドレスに限られ、送るのは 10 回目の失敗の 1 回だけ。
 *   回数はログインの成功・パスワードの再設定でしか 0 に戻らないので、同じアドレスへ繰り返し送り付けるには
 *   本人がその間にログインするか再設定する必要がある。運営への宛先は固定アドレス。
 */
import { createLogger } from '@/lib/db-logger';
import { getOptionalEnv } from '@/lib/env';
import { maskEmailAddress, sendEmail } from '@/lib/emails/send';
import { renderLoginLockedEmail } from '@/lib/emails/account/login-locked';
import { renderLoginLockAdminEmail } from '@/lib/emails/account/login-lock-admin';
import { findAccountUserId, type LoginLockNotice, type LoginLockRpcClient } from '@/lib/auth/login-lock';

export interface LoginLockNoticeInput {
  /** 入力されたメールアドレス (小文字・前後の空白なし) */
  email: string;
  notice: LoginLockNotice;
  failureCount: number;
  lockedUntil: Date;
}

/** 段に届いたときの通知を送る。例外は投げない */
export async function sendLoginLockNotice(client: LoginLockRpcClient, input: LoginLockNoticeInput): Promise<void> {
  if (input.notice === 'none') return;
  const log = createLogger('auth/login-lock');
  const maskedEmail = maskEmailAddress(input.email);

  let userId: string | null;
  try {
    userId = await findAccountUserId(client, input.email);
  } catch (error) {
    log.error('ロックの通知の宛先を引けませんでした', error, { notice: input.notice, failure_count: input.failureCount });
    return;
  }

  try {
    if (input.notice === 'account-owner') {
      // アカウントが無いメールアドレスには送らない (登録していない人へ送り付けない)
      if (!userId) return;
      await sendEmail(
        renderLoginLockedEmail({
          to_email: input.email,
          failure_count: input.failureCount,
          locked_until: input.lockedUntil,
        }),
      );
      return;
    }

    // 運営への通知
    log.warn('ログインの連続失敗で 24 時間ロックしました', {
      account_user_id: userId,
      masked_email: maskedEmail,
      failure_count: input.failureCount,
      locked_until: input.lockedUntil.toISOString(),
    });
    const adminEmail = getOptionalEnv('ADMIN_NOTIFICATION_EMAIL');
    if (!adminEmail) return;
    await sendEmail(
      renderLoginLockAdminEmail({
        to_email: adminEmail,
        user_id: userId,
        masked_email: maskedEmail,
        failure_count: input.failureCount,
        locked_until: input.lockedUntil,
      }),
    );
  } catch (error) {
    // sendEmail は配信の失敗では例外を投げない (失敗は自分でログに残す)。ここに来るのは想定外の例外だけ
    log.error('ロックの通知を送れませんでした', error, { notice: input.notice, failure_count: input.failureCount });
  }
}
