// #1917 利用者の解散の通知 (docs/design/family/11-self-dissolve.md §16.2)。route が RPC の成功のあとに呼ぶ (= 認可のあとにだけ service_role を使う)。
// - 宛先は RPC が後始末の前に集めた member_user_ids (アカウントを持つ active なメンバー。解散した本人を含む)。
//   メールアドレスは auth.users にしか無いので resolveAuthEmails (service_role。listUsers は使わない。#1204) で引く。
// - 宛名は user_profiles.nickname (service_role。id を絞って読む)。無ければ null (アドレスを宛名にする。#1649)。
// - best-effort: 失敗しても例外を投げず、route の応答を変えない。ログにメールアドレスを残さない。待つのは最長 NOTICE_TIMEOUT_MS。
// 送信回数の制限 (invite-throttle) を通さない理由 (tests/email-send-throttle-contract.test.ts の EXEMPT_EMAIL_SENDERS):
//   宛先は本人が指定できず (RPC が集めた所属メンバーの登録アドレスに固定)、送るのは解散の RPC が成功した直後の 1 回だけ
//   (同じ家族・組織は 2 回解散できない。FAMILY_ALREADY_DISSOLVED / ORG_ALREADY_DISSOLVED)。
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/emails/send';
import { emailFailureReasons, logEmailFailures } from '@/lib/emails/send-result';
import { renderSelfDissolveEmail } from '@/lib/emails/membership/self-dissolve';
import type { MembershipScope } from '@/lib/emails/membership/scope-label';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';
import { NOTICE_TIMEOUT_MS, type NoticeLogger } from '@/lib/membership/exit-notification';
import { normalizeProfileName } from '@/lib/profile-name';

export interface NotifySelfDissolveParams {
  scope: MembershipScope;
  scopeId: string;
  scopeName: string;
  memberUserIds: readonly string[];
  log: NoticeLogger;
}

/** 宛先ごとに 1 通。失敗は app_logs に残す (宛先のアドレスは残さない)。例外は投げない */
export async function notifySelfDissolve(params: NotifySelfDissolveParams): Promise<void> {
  const { scope, scopeId, scopeName, memberUserIds, log } = params;
  if (memberUserIds.length === 0) return;
  const scopeKey = scope === 'family' ? 'family_id' : 'organization_id';
  try {
    const admin = getSupabaseAdmin();
    const work = (async () => {
      const emailMap = await resolveAuthEmails(memberUserIds, { admin, logger: log });
      const { data: profiles } = await admin.from('user_profiles').select('id, nickname').in('id', [...memberUserIds]);
      const nameOf = new Map<string, string>();
      for (const p of profiles ?? []) {
        const name = normalizeProfileName(p.nickname);
        if (name) nameOf.set(p.id, name);
      }
      const tasks = memberUserIds.flatMap((uid) => {
        const to = emailMap.get(uid);
        if (!to) return [];
        return [sendEmail(renderSelfDissolveEmail({ to_email: to, to_name: nameOf.get(uid) ?? null, scope, scope_name: scopeName }))];
      });
      const results = await Promise.allSettled(tasks);
      const failures = emailFailureReasons(results);
      logEmailFailures(log, '解散の通知メールの一部を送信できませんでした (解散は完了済み)', failures, {
        [scopeKey]: scopeId,
        failed_count: failures.length,
      });
    })();
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), NOTICE_TIMEOUT_MS));
    const outcome = await Promise.race([work.then(() => 'done' as const), timeout]);
    if (outcome === 'timeout') {
      log.warn('解散の通知メールの送信が時間内に終わりませんでした (解散は完了済み。送信は続きます)', { [scopeKey]: scopeId });
    }
  } catch (error) {
    log.error('解散の通知メールの送信処理に失敗しました (解散は完了済み)', error, { [scopeKey]: scopeId });
  }
}
