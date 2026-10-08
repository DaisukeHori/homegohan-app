// src/lib/membership/exit-notification.ts
// 家族グループ / 組織の「除名」「脱退」を、関係する人にメールで知らせる (#1160)。サーバー専用。
//
// - 除名: 外された本人にだけ送る (renderMemberRemovedEmail)。外した人・ほかのメンバーには送らない。
//   アカウントを持たない子供メンバー (family_members.user_id が NULL) には送り先が無いので送らない。
//   家族の除名 RPC はすでに外れた行にも成功するので、除名の前に active だった行にだけ送る (readFamilyMemberToNotify)。
// - 脱退: 家族グループなら代表者、組織ならオーナーにだけ送る (renderMemberLeftEmail)。脱退した本人には送らない。
// - 宛先のメールアドレスは auth.users にしか無い (user_profiles に email 列は無く、他人の行は RLS で読めない)。
//   resolveAuthEmails() だけで引く。listUsers() は先頭 50 件しか返さないので使わない (#1204)。
// - 通知は best-effort。除名・脱退の RPC はすでに完了しているので、宛先の解決や送信に失敗しても呼び出し元の
//   応答 (ステータスコード・本文) は変えない。失敗は構造化ログ (db-logger) に残す。ログにはメールアドレスを残さない。
//   このモジュールの notify* / read* は例外を投げない。
// - メール API などが応答しないときに、完了済みの除名・脱退の応答まで遅らせて関数のタイムアウトにしないよう、
//   通知を待つのは最長 NOTICE_TIMEOUT_MS まで。超えたら警告ログに残して先へ進む。
//
// 所属先の名前と通知先の ID は、必ず RPC の前に read* で読んでおくこと。除名・脱退のあとは、呼び出し元の
// セッションがその所属先を RLS で読めなくなる (family_groups / organizations の SELECT は所属メンバーだけ。
// leave_org の戻り値の organization_id も NULL になる)。RPC のあとに読み直すと名前も宛先も分からない (#1209 と同じ落とし穴)。
//
// 送信回数の制限 (invite-throttle) を通さない理由 (tests/email-send-throttle-contract.test.ts の EXEMPT_EMAIL_SENDERS):
// 宛先は利用者の指定ではなく、除名された本人 / 脱退先の代表者・オーナーの登録アドレスに固定されている。
// 送るのは除名・脱退の RPC が成功した直後の 1 回だけ (除名はそれまで active だった行に限る) で、
// メンバーになるには本人の同意 (招待の承諾) が要る。
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail, type EmailEnvelope } from '@/lib/emails/send';
import { renderMemberLeftEmail } from '@/lib/emails/membership/member-left';
import { renderMemberRemovedEmail } from '@/lib/emails/membership/member-removed';
import type { MembershipScope } from '@/lib/emails/membership/scope-label';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';
import { buildFamilyMembersUrl, buildOrgMembersUrl } from '@/lib/membership/urls';

/** ログの出力先 (createLogger(...).withUser(...) の戻り値) */
export interface NoticeLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, error?: unknown, metadata?: Record<string, unknown>): void;
}

/** RPC の前に読んでおく、通知に必要な所属先の情報 */
export interface NoticeScope {
  kind: MembershipScope;
  /** 所属先 (家族グループ / 組織) の ID。所属が見つからなかったときは null */
  id: string | null;
  /** 家族グループ名 / 組織名。読めなかったときは null (名前を省いた文面で通知する) */
  name: string | null;
  /** 脱退の通知先 (家族グループの代表者 / 組織のオーナー) の user_id。分からないときは null (脱退は通知しない) */
  leaveRecipientId: string | null;
}

function unknownScope(kind: MembershipScope, id: string | null = null): NoticeScope {
  return { kind, id, name: null, leaveRecipientId: null };
}

function describeError(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

function warnUnreadable(kind: MembershipScope, id: string | null, err: unknown, log: NoticeLogger): void {
  log.warn('通知メールに使う所属先の情報を読めませんでした (除名・脱退は続行します。通知は名前なしの文面になるか、送れません)', {
    scope: kind,
    scope_id: id,
    error: describeError(err),
  });
}

/**
 * 家族グループの名前と代表者を、除名・脱退する人のセッションで読む。RPC の前に呼ぶこと。
 * 読めなくても (または見えなくても) 例外は投げず、名前も宛先も分からない状態を返す。
 */
export async function readFamilyNotice(
  supabase: SupabaseClient,
  familyId: string,
  log: NoticeLogger,
): Promise<NoticeScope> {
  try {
    const { data, error } = await supabase
      .from('family_groups')
      .select('name, representative_id')
      .eq('id', familyId)
      .maybeSingle();
    if (error) {
      warnUnreadable('family', familyId, error, log);
      return unknownScope('family', familyId);
    }
    return {
      kind: 'family',
      id: familyId,
      name: typeof data?.name === 'string' ? data.name : null,
      leaveRecipientId: typeof data?.representative_id === 'string' ? data.representative_id : null,
    };
  } catch (err) {
    warnUnreadable('family', familyId, err, log);
    return unknownScope('family', familyId);
  }
}

/**
 * 除名しようとしている家族の行 (family_members) を、除名する人のセッションで読み、通知先の user_id を返す。
 * RPC の前に呼ぶこと。
 *
 * remove_family_member は行の status を確かめず、すでに脱退・除名済みの行にも成功する (同じ行を何度でも除名できる)。
 * 毎回通知すると、除名を繰り返し呼ぶだけで、外れた人に同じメールを何度も送り付けられてしまう。
 * そこで、除名の前に active だった行だけを通知の対象にし、通知は「active から外れた 1 回」だけにする。
 *
 * - active で、アカウントを持つ (user_id が NULL でない) ときだけ user_id を返す。
 * - アカウントを持たない子供メンバー、すでに外れている行、行が見えないときは null。
 * - 読めなかったときも null。初めての除名かどうかを確かめられないので送らない (警告ログに残す)。
 */
export async function readFamilyMemberToNotify(
  supabase: SupabaseClient,
  familyId: string,
  memberRowId: string,
  log: NoticeLogger,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('family_members')
      .select('user_id, status')
      .eq('id', memberRowId)
      .eq('family_id', familyId)
      .maybeSingle();
    if (error) {
      warnUnreadable('family', familyId, error, log);
      return null;
    }
    if (data?.status !== 'active') return null;
    return typeof data.user_id === 'string' ? data.user_id : null;
  } catch (err) {
    warnUnreadable('family', familyId, err, log);
    return null;
  }
}

/**
 * 脱退する本人が今所属している家族グループ (family_members の active な行) を読む。RPC の前に呼ぶこと。
 * どの家族にも所属していなければ、何も分からない状態を返す (RPC が NOT_IN_FAMILY で断る)。
 */
export async function readFamilyNoticeOfMember(
  supabase: SupabaseClient,
  userId: string,
  log: NoticeLogger,
): Promise<NoticeScope> {
  try {
    const { data, error } = await supabase
      .from('family_members')
      .select('family_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) {
      warnUnreadable('family', null, error, log);
      return unknownScope('family');
    }
    if (typeof data?.family_id !== 'string') return unknownScope('family');
    return await readFamilyNotice(supabase, data.family_id, log);
  } catch (err) {
    warnUnreadable('family', null, err, log);
    return unknownScope('family');
  }
}

/**
 * 組織の名前とオーナーを、除名・脱退する人のセッションで読む。RPC の前に呼ぶこと。
 * 読めなくても (または見えなくても) 例外は投げず、名前も宛先も分からない状態を返す。
 */
export async function readOrganizationNotice(
  supabase: SupabaseClient,
  organizationId: string,
  log: NoticeLogger,
): Promise<NoticeScope> {
  try {
    const { data, error } = await supabase
      .from('organizations')
      .select('name, owner_id')
      .eq('id', organizationId)
      .maybeSingle();
    if (error) {
      warnUnreadable('organization', organizationId, error, log);
      return unknownScope('organization', organizationId);
    }
    return {
      kind: 'organization',
      id: organizationId,
      name: typeof data?.name === 'string' ? data.name : null,
      // owner_id は NULL になりうる。オーナーがいなければ脱退は通知しない
      leaveRecipientId: typeof data?.owner_id === 'string' ? data.owner_id : null,
    };
  } catch (err) {
    warnUnreadable('organization', organizationId, err, log);
    return unknownScope('organization', organizationId);
  }
}

/**
 * 脱退する本人が今所属している組織 (user_profiles.organization_id) を読む。RPC の前に呼ぶこと。
 * どの組織にも所属していなければ、何も分からない状態を返す (RPC が NOT_IN_ORG で断る)。
 */
export async function readOrganizationNoticeOfMember(
  supabase: SupabaseClient,
  userId: string,
  log: NoticeLogger,
): Promise<NoticeScope> {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('organization_id')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      warnUnreadable('organization', null, error, log);
      return unknownScope('organization');
    }
    if (typeof data?.organization_id !== 'string') return unknownScope('organization');
    return await readOrganizationNotice(supabase, data.organization_id, log);
  } catch (err) {
    warnUnreadable('organization', null, err, log);
    return unknownScope('organization');
  }
}

/** 通知 (宛先の解決とメール送信) を待つ最長時間 (ミリ秒) */
export const NOTICE_TIMEOUT_MS = 5000;

/**
 * work が終わるのを最長 ms だけ待つ。時間内に終われば true、超えたら false (work はそのまま走り続ける)。
 * work は失敗を自分で記録する作りだが、ログの出力自体が失敗して reject しても、通知の失敗で呼び出し元を落とさない。
 */
async function finishesWithin(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const, () => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 宛先のアドレスを引いて、メールを 1 通送る。失敗は握りつぶして構造化ログに残す (例外は投げない)。
 * ログに残すのは所属先と宛先の user_id だけで、メールアドレスは残さない。
 */
async function deliver(args: {
  scope: NoticeScope;
  recipientId: string;
  log: NoticeLogger;
  failureMessage: string;
  build: (toEmail: string) => EmailEnvelope;
}): Promise<void> {
  const { scope, recipientId, log, failureMessage, build } = args;
  const metadata = { scope: scope.kind, scope_id: scope.id, recipient_user_id: recipientId };

  const attempt = async (): Promise<void> => {
    try {
      // resolveAuthEmails は例外を投げず、取得できなかった人 (取得に失敗・メールアドレスを持たない) は結果に入れない。
      // 取得の失敗は警告ログに残る。アドレスを持たない人 (電話番号のみなど) は、失敗ではないので何も残さない
      const emails = await resolveAuthEmails([recipientId], { logger: log });
      const toEmail = emails.get(recipientId);
      if (!toEmail) return;
      await sendEmail(build(toEmail));
    } catch (err) {
      log.error(failureMessage, err, metadata);
    }
  };

  if (!(await finishesWithin(attempt(), NOTICE_TIMEOUT_MS))) {
    log.warn('通知メールの送信が時間内に終わりませんでした (処理は完了済み。メールは届かない可能性があります)', {
      ...metadata,
      timeout_ms: NOTICE_TIMEOUT_MS,
    });
  }
}

/**
 * 除名された本人に、外されたことをメールで知らせる。除名の RPC が成功したあとに呼ぶこと。
 * アカウントを持たない子供メンバー (removedUserId が null) と、自分で自分を外した場合 (実行者 = 本人) には送らない。
 */
export async function notifyMemberRemoved(params: {
  scope: NoticeScope;
  /**
   * 外された人の user_id。除名の前に読んだ値を渡す (家族は readFamilyMemberToNotify、組織は URL の user_id)。
   * アカウントを持たない子供メンバーや、すでに外れていた行は null
   */
  removedUserId: string | null | undefined;
  /** 除名を実行した人の user_id */
  actorUserId: string;
  log: NoticeLogger;
}): Promise<void> {
  const { scope, removedUserId, actorUserId, log } = params;
  if (!removedUserId || removedUserId === actorUserId) return;

  await deliver({
    scope,
    recipientId: removedUserId,
    log,
    failureMessage: '除名の通知メールを送信できませんでした (除名は完了済み)',
    build: (toEmail) => renderMemberRemovedEmail({ to_email: toEmail, scope: scope.kind, scope_name: scope.name }),
  });
}

/**
 * 脱退したことを、家族グループの代表者 / 組織のオーナーにメールで知らせる。脱退の RPC が成功したあとに呼ぶこと。
 * 通知先 (scope.leaveRecipientId) が分からないとき (読めなかった・オーナーが未設定) は送らない。
 */
export async function notifyMemberLeft(params: { scope: NoticeScope; log: NoticeLogger }): Promise<void> {
  const { scope, log } = params;
  if (!scope.leaveRecipientId) return;

  await deliver({
    scope,
    recipientId: scope.leaveRecipientId,
    log,
    failureMessage: '脱退の通知メールを送信できませんでした (脱退は完了済み)',
    build: (toEmail) =>
      renderMemberLeftEmail({
        to_email: toEmail,
        scope: scope.kind,
        scope_name: scope.name,
        members_url: scope.kind === 'organization' ? buildOrgMembersUrl() : buildFamilyMembersUrl(),
      }),
  });
}
