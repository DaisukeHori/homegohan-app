/**
 * /admin/users/{id} — ユーザー詳細
 * operator/03-ui-spec.md §6 準拠
 *
 * DB 直叩きを廃止し GET /api/admin/users/{id} 経由に統一。
 *
 * #2093 W3: 「無い」(notFound()) にするのは API の 404 だけ。それ以外の失敗 (500 / 503 / 403・通信の失敗・壊れた応答) は
 * 「ユーザーを読み込めませんでした」と「再読み込み」を出す (以前は 404 以外の失敗も notFound() にして、利用者が消えたように見せていた)。
 *
 * #2112 Z3: プラン・契約の状態・監査ログの重要度は、英字の内部の値 (free・past_due・warn など) をやめ、表示名の表
 * (src/lib/admin/plan-key-labels.ts・subscription-status-labels.ts・audit-severity-labels.ts) を通して出す。表に無い値はそのまま出す。
 * 監査ログの操作 (action_type) は識別子として code の字体のまま出す。
 */

export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireRoleForPage } from '@/lib/auth/page-guard';
import { adminFetch } from '@/lib/admin/fetch';
import { canViewUserEmail } from '@/lib/admin/user-emails';
import { normalizeProfileName } from '@/lib/profile-name';
import { adminPlanKeyLabel } from '@/lib/admin/plan-key-labels';
import { adminSubscriptionStatusLabel } from '@/lib/admin/subscription-status-labels';
import { adminAuditSeverityLabel } from '@/lib/admin/audit-severity-labels';
import { isMfaRequiredRoleSet } from '@/lib/auth/mfa/policy';
import { OperatorMfaResetSection } from '@/components/admin/OperatorMfaResetSection';
import { ManualPlanGrantSection } from '@/components/admin/ManualPlanGrantSection';
import { z } from 'zod';
import { LoginHistoryResponseSchema, type LoginHistoryEntry } from '@/lib/auth/sessions/schemas';
import { LOGIN_HISTORY_PAGE_SIZE } from '@/lib/auth/sessions/constants';
import { loadAdminUserDetail } from '@/lib/admin/user-detail-load';
import { USER_DETAIL_LOAD_FAILED_MESSAGE } from '@/lib/admin/users-load-failure';
import ModerationLoadFailure from '@/components/operator/moderation/ModerationLoadFailure';

interface PageProps {
  params: Promise<{ id: string }>;
}

interface ActiveSubscription {
  plan_key: string;
  status: string;
  next_billing_at: string | null;
}

interface AuditLog {
  id: string;
  action_type: string;
  created_at: string;
  severity: string;
  details: unknown;
}

interface UserDetailProfile {
  id: string;
  /** メールアドレス (admin / super_admin にだけ API が返す。それ以外と、メールを持たないユーザーは null) */
  email: string | null;
  nickname: string | null;
  roles: string[];
  plan_key: string;
  is_banned: boolean;
  frozen_at: string | null;
  frozen_reason: string | null;
  last_login_at: string | null;
  registered_at: string | null;
  active_subscription: ActiveSubscription | null;
  ban_history: AuditLog[];
}

/**
 * ログイン履歴の節 (#1720 段 D。docs/design/cross/16-auth-history-sessions.md §17)。
 * API (GET /api/admin/users/{id}/login-history §14.9) を呼べるのは admin / super_admin だけ (support には節を出さず、呼びもしない)。
 */
const LOGIN_HISTORY_ROLES: ReadonlySet<string> = new Set(['admin', 'super_admin']);
/** 運営 API の成功の本文 (nested) */
const AdminLoginHistoryApiResponseSchema = z.object({ data: LoginHistoryResponseSchema });
/** 列見出し (左から。§17 の逐語。alert_sent_at の列は「通知メール」とだけ書くと配信済みに読めるため「送信待ちに登録した」を入れる) */
const LOGIN_HISTORY_COLUMNS = ['日時', '端末', 'IP', '国', '印', '通知メールを送信待ちに登録した日時', '終了'] as const;
/** サーバーのコンポーネントで描くので、timeZone を書かないと実行環境 (UTC) の時刻になる (§17) */
const LOGIN_HISTORY_DATE_OPTIONS: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Tokyo' };
const LOGIN_HISTORY_LOAD_ERROR = 'ログイン履歴を読み込めませんでした';
/** 終了の理由の言葉 (user_sessions_metadata.ended_reason) */
const ENDED_REASON_LABEL: Record<NonNullable<LoginHistoryEntry['ended_reason']>, string> = {
  signed_out: 'ログアウト',
  revoked_by_user: '本人が端末の一覧から解除',
  idle_expired: '使われずに期限切れ',
};

/** パンくずに出す、ユーザーの ID の先頭の文字数 (名前が無いときと、読み込めなかったとき) */
const USER_ID_PREFIX_LENGTH = 8;

type LoginHistoryLoad = { ok: true; entries: LoginHistoryEntry[] } | { ok: false };

/** 応答が ok でない (403 / 500)・形が違う・通信の失敗は ok: false (節に読み込めなかった旨だけを出し、ページの他の節は描く) */
async function loadLoginHistory(userId: string): Promise<LoginHistoryLoad> {
  try {
    const res = await adminFetch(`/api/admin/users/${encodeURIComponent(userId)}/login-history`);
    if (!res.ok) return { ok: false };
    const parsed = AdminLoginHistoryApiResponseSchema.safeParse(await res.json());
    return parsed.success ? { ok: true, entries: parsed.data.data.entries } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function formatLoginHistoryDate(value: string): string {
  return new Date(value).toLocaleString('ja-JP', LOGIN_HISTORY_DATE_OPTIONS);
}

/** 印 (worker の判定の結果)。判定の前 (null) と、どれも当たらないときは「-」 */
function loginHistoryMarks(entry: LoginHistoryEntry): string[] {
  const marks: string[] = [];
  if (entry.is_new_device) marks.push('新しい端末');
  if (entry.is_new_ip) marks.push('新しい接続元');
  if (entry.is_new_country) marks.push('新しい地域');
  return marks;
}

function LoginHistorySection({ load }: { load: LoginHistoryLoad }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6" data-testid="admin-user-login-history">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">ログイン履歴 (直近 {LOGIN_HISTORY_PAGE_SIZE} 回)</h2>
      {!load.ok ? (
        <p className="text-sm text-red-600" data-testid="admin-user-login-history-error">
          {LOGIN_HISTORY_LOAD_ERROR}
        </p>
      ) : load.entries.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="admin-user-login-history-empty">
          記録なし
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-100">
                {LOGIN_HISTORY_COLUMNS.map((column) => (
                  <th key={column} className="py-2 pr-3 font-medium whitespace-nowrap">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {load.entries.map((entry) => {
                const marks = loginHistoryMarks(entry);
                return (
                  <tr key={entry.session_id} className="border-b border-gray-50 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatLoginHistoryDate(entry.created_at)}</td>
                    <td className="py-2 pr-3">
                      {entry.device_label}
                      {entry.device_name ? ` (端末名: ${entry.device_name})` : ''}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{entry.ip_address ?? '-'}</td>
                    <td className="py-2 pr-3">{entry.country_code ?? '-'}</td>
                    <td className="py-2 pr-3">{marks.length > 0 ? marks.join('・') : '-'}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {entry.alert_sent_at ? formatLoginHistoryDate(entry.alert_sent_at) : 'なし'}
                    </td>
                    <td className="py-2 pr-3">
                      {entry.ended_at
                        ? `${entry.ended_reason ? ENDED_REASON_LABEL[entry.ended_reason] : '終了'} (${formatLoginHistoryDate(entry.ended_at)})`
                        : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default async function AdminUserDetailPage(props: PageProps) {
  const params = await props.params;
  const { id } = params;
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → /login (#1176。docs/design/cross/12-operator-mfa.md §13.4.2)
  const actor = await requireRoleForPage(['admin', 'super_admin', 'support'], { next: `/admin/users/${encodeURIComponent(id)}` });

  // GET /api/admin/users/{id} 経由でデータ取得。404 だけを「無い」にする (#2093 W3)
  const load = await loadAdminUserDetail<UserDetailProfile>(id, 'admin/users detail page');
  if (load.kind !== 'ok') {
    if (load.kind === 'notFound') notFound();
    // 読み込みの失敗: 一覧へ戻る道と、失敗の文と「再読み込み」だけを出す (読めていない値・続きの節は描かない)
    return (
      <div className="max-w-4xl">
        <nav className="mb-4 text-sm text-gray-500">
          <Link href="/admin/users" className="hover:text-orange-500 transition-colors">
            ユーザー管理
          </Link>
          {' / '}
          <span className="text-gray-900">{id.slice(0, USER_ID_PREFIX_LENGTH)}</span>
        </nav>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">ユーザー詳細</h1>
        <ModerationLoadFailure message={USER_DETAIL_LOAD_FAILED_MESSAGE} />
      </div>
    );
  }
  const profile = load.profile;

  const activeSubscription = profile.active_subscription;
  // 監査ログ (super_admin のみ: ban_history を使用)
  const auditLogs: AuditLog[] = actor.roles.includes('super_admin')
    ? (profile.ban_history as AuditLog[]) ?? []
    : [];

  const isBanned = profile.is_banned;
  const isSuperAdmin = actor.roles.includes('super_admin');
  const isAdmin = actor.roles.includes('admin') || isSuperAdmin;
  // メールアドレスを見られるのは admin / super_admin だけ (support には API も null を返す)
  const canSeeEmail = canViewUserEmail(actor.roles);
  // 二段階認証の解除 (段 C): 実行者が super_admin で、対象が MFA_REQUIRED_ROLES のどれかを持つときだけ出す
  // (docs/design/cross/12-operator-mfa.md §15・§15.3。API は対象のロールを見ないが、画面は必須ロールの運営にだけ出す)
  const canResetMfa = isSuperAdmin && Array.isArray(profile.roles) && isMfaRequiredRoleSet(profile.roles);
  // 手動のプラン付与 (billing/02 §10): 実行者が super_admin で、対象が自分でないときだけ出す (自分への付与は API も 403 OP_SELF_MODIFY)
  const canGrantManualPlan = isSuperAdmin && actor.id !== profile.id;
  // ログイン履歴 (段 D §17): admin / super_admin のときだけ API を呼ぶ (support は API も 403 なので呼ばず、節も出さない)
  const loginHistory = actor.roles.some((role) => LOGIN_HISTORY_ROLES.has(role)) ? await loadLoginHistory(profile.id) : null;

  return (
    <div className="max-w-4xl">
      {/* パンくず */}
      <nav className="mb-4 text-sm text-gray-500">
        <Link href="/admin/users" className="hover:text-orange-500 transition-colors">
          ユーザー管理
        </Link>
        {' / '}
        <span className="text-gray-900">{normalizeProfileName(profile.nickname) ?? profile.id.slice(0, USER_ID_PREFIX_LENGTH)}</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        {normalizeProfileName(profile.nickname) ?? '(名前なし)'}
      </h1>

      {/* 基本情報セクション */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">基本情報</h2>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500 mb-1">ユーザー ID</dt>
            <dd className="font-mono text-gray-900 text-xs">{profile.id}</dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">メールアドレス</dt>
            <dd className="text-gray-900 break-all">
              {canSeeEmail ? (
                (profile.email ?? '-')
              ) : (
                <span className="text-gray-400 text-xs">権限により非表示</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">プラン</dt>
            <dd>
              <span className="inline-block bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded">
                {adminPlanKeyLabel(profile.plan_key)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">ロール</dt>
            <dd className="flex flex-wrap gap-1">
              {(Array.isArray(profile.roles) ? profile.roles : ['user']).map((role: string) => (
                <span
                  key={role}
                  className="inline-block bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded font-mono"
                >
                  {role}
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">ステータス</dt>
            <dd>
              {isBanned ? (
                <div>
                  <span className="inline-block bg-red-50 text-red-700 text-xs px-2 py-0.5 rounded font-medium">
                    凍結中
                  </span>
                  {profile.frozen_at && (
                    <span className="ml-2 text-xs text-gray-400">
                      {new Date(profile.frozen_at).toLocaleString('ja-JP')} 〜
                    </span>
                  )}
                  {profile.frozen_reason && (
                    <p className="mt-1 text-xs text-red-600">
                      理由: {profile.frozen_reason}
                    </p>
                  )}
                </div>
              ) : (
                <span className="inline-block bg-green-50 text-green-700 text-xs px-2 py-0.5 rounded font-medium">
                  アクティブ
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">登録日</dt>
            <dd className="text-gray-900">
              {profile.registered_at
                ? new Date(profile.registered_at).toLocaleString('ja-JP')
                : '-'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">最終ログイン</dt>
            <dd className="text-gray-900">
              {profile.last_login_at
                ? new Date(profile.last_login_at).toLocaleString('ja-JP')
                : '-'}
            </dd>
          </div>
        </dl>

        {/* アクションボタン */}
        {isAdmin && (
          <div className="mt-6 flex flex-wrap gap-3 pt-4 border-t border-gray-100">
            {isBanned ? (
              <Link
                href={`/admin/users/${id}/freeze`}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-green-500 text-white text-sm font-medium hover:bg-green-600 transition-colors"
              >
                凍結解除
              </Link>
            ) : (
              <Link
                href={`/admin/users/${id}/freeze`}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors"
              >
                凍結 (BAN)
              </Link>
            )}
          </div>
        )}
      </div>

      {canResetMfa && <OperatorMfaResetSection userId={profile.id} />}
      {canGrantManualPlan && <ManualPlanGrantSection userId={profile.id} />}

      {/* サブスクリプション情報 */}
      {activeSubscription && (
        <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">現在のサブスクリプション</h2>
          <dl className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-gray-500 mb-1">プラン</dt>
              <dd>{adminPlanKeyLabel(activeSubscription.plan_key)}</dd>
            </div>
            <div>
              <dt className="text-gray-500 mb-1">ステータス</dt>
              <dd>{adminSubscriptionStatusLabel(activeSubscription.status)}</dd>
            </div>
            <div>
              <dt className="text-gray-500 mb-1">次回更新</dt>
              <dd>
                {activeSubscription.next_billing_at
                  ? new Date(activeSubscription.next_billing_at).toLocaleDateString('ja-JP')
                  : '-'}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {loginHistory && <LoginHistorySection load={loginHistory} />}

      {/* 監査ログ (super_admin のみ) */}
      {isSuperAdmin && auditLogs.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">監査ログ (直近 20 件)</h2>
          <div className="space-y-2 text-sm">
            {auditLogs.map((log) => (
              <div
                key={log.id}
                className="flex items-start gap-3 p-3 rounded-lg bg-gray-50"
              >
                <span
                  className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${
                    log.severity === 'critical'
                      ? 'bg-red-100 text-red-700'
                      : log.severity === 'warn'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {adminAuditSeverityLabel(log.severity)}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-gray-700">{log.action_type}</span>
                </div>
                <span className="text-gray-400 text-xs flex-shrink-0">
                  {new Date(log.created_at).toLocaleString('ja-JP')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
