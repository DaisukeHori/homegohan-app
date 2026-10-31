'use client';

// src/app/family/promotions/[token]/page.tsx
// #1232: 子供メンバー昇格 (家族グループ参加) の本人同意ページ。メールリンク着地。
// 状態分岐は src/app/invite/[token]/page.tsx (未ログイン/不一致/無効) を、
// 単一対象者・単一決定の構造とアクション部は
// src/app/(main)/family/transfer-accept/[proposal_id]/page.tsx を踏襲。
// 共有設定チェックボックスは FamilyInviteAcceptModal と同じ 3 種 + デフォルト値。
// (main) ルートグループの外に置く: 未ログイン・オンボーディング未完了でも到達できる必要がある
// (lib/supabase/middleware.ts の publicPaths と lib/onboarding-routing.ts で除外済み)。
import { useState, useEffect, useId, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { PARENTAL_CONSENT_COPY } from '@homegohan/shared';
import FocusTrap from 'focus-trap-react';
import { createClient } from '@/lib/supabase/client';
import { clearUserScopedLocalStorage, broadcastSignOut } from '@/lib/user-storage';
import { notifyNativeSignOut } from '@/lib/native-auth-bridge';
import { useDialogA11y } from '@/components/common/useDialogA11y';
import { readSignedInUser } from '@/lib/auth/signed-in-user';
import { MEMBERSHIP_STATE_UNCONFIRMED_NOTE } from '@/lib/membership/leave-state';

/** 失敗の応答の本文 ({ error: { code, message } }) のコード。読めない・形が違うときは null */
function errorCodeOfBody(body: unknown): string | null {
  const error = errorObjectOfBody(body);
  return error !== null && typeof error.code === 'string' ? error.code : null;
}

/** 失敗の応答の本文の message。読めない・形が違うときは undefined */
function errorMessageOfBody(body: unknown): string | undefined {
  const error = errorObjectOfBody(body);
  return error !== null && typeof error.message === 'string' ? error.message : undefined;
}

function errorObjectOfBody(body: unknown): { code?: unknown; message?: unknown } | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const { error } = body;
  return typeof error === 'object' && error !== null ? error : null;
}

interface PromotionDetails {
  family_name: string | null;
  member_display_name: string | null;
  requested_by_name: string | null;
  email: string;
  status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';
  expires_at: string;
  current_user_email_matches: boolean;
}

const STATUS_MESSAGES: Record<string, string> = {
  accepted: '承認済み',
  rejected: '拒否済み',
  revoked: '取り消し済み',
  expired: '期限切れ',
};

/** 承諾・拒否の通信そのものが失敗した (fetch が reject した・失敗の応答の本文を読めなかった) ときの文 */
const NETWORK_FAILURE_MESSAGE = '通信エラーが発生しました';

/** 参加リクエストが承認済み・拒否済み (409 PROMOTION_REQUEST_ALREADY_USED) のときの文 */
const PROMOTION_ALREADY_USED_MESSAGE = 'この参加リクエストは既に処理済みです。';

/**
 * 承諾・拒否の応答を受け取れず、読み直すとまだ承認待ち (pending) だったときの文 (#2086 V2)。
 * サーバーで承諾も拒否もされていないので、もう一度押してよい
 */
const PROMOTION_NOT_PROCESSED_MESSAGE =
  '応答を受け取れませんでした。参加リクエストはまだ処理されていません。もう一度お試しください。';

/**
 * 参加リクエスト (get_promotion_details) を読み込めなかったときの文 (#2086 V3 と同じ型)。
 * リクエストが無い (「参加リクエストが見つかりません」) と見分けるために出す。失敗の理由 (英語の内部の文) は画面に出さない
 */
const PROMOTION_LOAD_ERROR = '参加リクエストを読み込めませんでした。しばらくしてから、もう一度お試しください。';

/** get_promotion_details の読み込みの結果 (例外は投げない。読み込めなかったときは ok: false) */
type PromotionDetailsRead =
  | { ok: true; details: PromotionDetails | null }
  | { ok: false };

/**
 * #1057 (UX1-08): 拒否確認モーダル。誤タップでの即時拒否確定を防ぐ。
 * #1052 の a11y の仕組み (Escape で閉じる・背景スクロールのロック・フォーカストラップ) を使う。
 */
function RejectConfirmDialog({
  familyName,
  loading,
  onCancel,
  onConfirm,
}: {
  familyName: string;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  useDialogA11y({ onClose: onCancel, closeOnEscape: !loading });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <FocusTrap focusTrapOptions={{ allowOutsideClick: true, escapeDeactivates: false }}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl"
        >
          <h3 id={titleId} className="text-lg font-bold text-gray-900 mb-2">確認</h3>
          <p className="text-gray-600 text-sm mb-6">
            「{familyName}」への参加を拒否します。<br />
            取り消す場合はご家族に再送を依頼する必要があります。よろしいですか？
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={loading}
              className="flex-1 py-3 rounded-full border-2 border-gray-200 text-gray-600 font-bold transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={loading}
              className="flex-1 py-3 rounded-full bg-red-500 hover:bg-red-600 text-white font-bold transition-colors disabled:opacity-50"
            >
              {loading ? '処理中…' : '拒否する'}
            </button>
          </div>
        </div>
      </FocusTrap>
    </div>
  );
}

export default function FamilyPromotionConsentPage() {
  // パスの値は useParams で読む。props の params は Next 15 から Promise で、Next 14 では use(params) が例外になった (#1275)。
  // useParams はどちらでも同じに使えるので、こちらにそろえている (#1444)。
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [details, setDetails] = useState<PromotionDetails | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 参加リクエスト (または自分) を読み込めなかったときの文。あるあいだは画面の代わりにこの文と「再試行」を出す (#2086)
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<'accept' | 'reject' | null>(null);
  const [result, setResult] = useState<'accepted' | 'rejected' | null>(null);
  const [shareMeals, setShareMeals] = useState(true);
  const [shareHealth, setShareHealth] = useState(false);
  const [shareMenu, setShareMenu] = useState(true);
  // #1057 (UX1-08): 誤タップでの即時拒否確定を防ぐ確認ステップ
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);

  // 参加リクエストを読む。画面を開いたとき・「再試行」・承諾 / 拒否の通信が失敗したあとに呼ぶ。例外は投げない。
  // get_promotion_details は SECURITY DEFINER + anon EXECUTE (get_invite_details と同趣旨)。リクエストが無ければ data は null
  const readPromotionDetails = useCallback(async (): Promise<PromotionDetailsRead> => {
    try {
      const { data, error: rpcError } = await supabase.rpc('get_promotion_details', {
        p_token: token,
      });
      if (rpcError) return { ok: false };
      return { ok: true, details: (data as PromotionDetails | null) ?? null };
    } catch (readFailure) {
      console.error('[family/promotions] failed to read promotion details:', readFailure);
      return { ok: false };
    }
  }, [supabase, token]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setError(null);
    // getUser は通信の失敗を投げずに { user: null, error } で返す。確かめられなかったときは、ログインしていないとして
    // ログインの案内を出さず、読み込みの失敗と「再試行」を出す (#2086 V3 と同じ型)
    const signedIn = await readSignedInUser(supabase);
    if (signedIn.kind === 'load-failed') {
      setLoadError(PROMOTION_LOAD_ERROR);
      setLoading(false);
      return;
    }
    const user = signedIn.kind === 'signed-in' ? signedIn.user : null;
    setIsLoggedIn(user !== null);
    setCurrentEmail(user?.email ?? null);

    const read = await readPromotionDetails();
    if (!read.ok) {
      // 読み込めなかった (リクエストが無いのとは別。「参加リクエストが見つかりません」と見せない)
      setLoadError(PROMOTION_LOAD_ERROR);
      setLoading(false);
      return;
    }
    if (!read.details) {
      setError('参加リクエストが見つかりません');
      setLoading(false);
      return;
    }
    setDetails(read.details);
    setLoading(false);
  }, [supabase, readPromotionDetails]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  /**
   * 承諾・拒否の通信が失敗したあと (または PROMOTION_REQUEST_ALREADY_USED で断られたあと) に、参加リクエストを読み直して
   * 今の状態を見せる (#2086 V2。招待の承諾 (FamilyInviteAcceptModal の confirmAcceptedOrShow。#2080 U1) と同じ型)。
   * サーバーが承諾 / 拒否を済ませてから応答が切れたこともあり、確かめずに文を出すと、承諾できたのか拒否されたのか分からず、
   * もう一度押すと「既に処理済みです」と出ていた。
   *   - 承認済み: 承諾の成功のときと同じ画面 (家族ダッシュボードへの導線)
   *   - 拒否済み: 拒否の成功のときと同じ画面
   *   - 取り消し済み・期限切れ: 読み直した状態を出す (「このリクエストは無効です」)
   *   - 承認待ちのまま: pendingMessage を出す (もう一度押せる)
   *   - 読み直せなかった: unconfirmedMessage に「状態を確かめられませんでした」を添える
   * 読み直しの応答を待つあいだもボタンを止めたままにする (呼ぶ側の finally まで actionLoading を戻さない)
   */
  const showStateAfterFailure = async (pendingMessage: string, unconfirmedMessage: string) => {
    const read = await readPromotionDetails();
    if (!read.ok || !read.details) {
      setActionError(`${unconfirmedMessage} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})`);
      return;
    }
    const fresh = read.details;
    setDetails(fresh);
    if (fresh.status === 'accepted') {
      setResult('accepted');
      return;
    }
    if (fresh.status === 'rejected') {
      setResult('rejected');
      return;
    }
    if (fresh.status === 'pending') {
      setActionError(pendingMessage);
    }
    // 取り消し済み・期限切れは、読み直した details で「このリクエストは無効です」を出す (文は要らない)
  };

  const mapActionError = (code: string | undefined, fallback: string | undefined): string => {
    switch (code) {
      case 'PROMOTION_REQUEST_EXPIRED':
        return 'この参加リクエストの期限が切れています。ご家族に再送を依頼してください。';
      case 'PROMOTION_REQUEST_ALREADY_USED':
        return PROMOTION_ALREADY_USED_MESSAGE;
      case 'PROMOTION_EMAIL_MISMATCH':
        return 'この参加リクエストは現在ログイン中のアカウント宛てではありません。';
      case 'ALREADY_IN_FAMILY':
        return '既に家族グループに所属しているため参加できません。';
      case 'ALREADY_PROMOTED':
      case 'PROMOTION_MEMBER_UNAVAILABLE':
        return 'このメンバー枠は現在利用できません。ご家族にご確認ください。';
      case 'CONFLICT_RETRY':
        return '他の操作と競合しました。数秒おいてもう一度お試しください。';
      // #1173: 保護者の同意が無い 13〜17 歳の子供 / 13 歳未満の子供の昇格
      case 'PARENTAL_CONSENT_REQUIRED':
        return PARENTAL_CONSENT_COPY.promotionConsentMissing;
      case 'PROMOTION_UNDER_COPPA_AGE':
        return PARENTAL_CONSENT_COPY.promotionUnderCoppaAge;
      default:
        return fallback ?? '処理に失敗しました';
    }
  };

  const handleAccept = async () => {
    setActionError(null);
    setActionLoading('accept');
    try {
      const res = await fetch(`/api/family/promotions/${token}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          share_meals: shareMeals,
          share_health: shareHealth,
          share_menu: shareMenu,
        }),
      });
      if (res.ok) {
        // 応答が成功なら承諾できている (本文は使わない。本文を読めなくても成功として扱う)
        setResult('accepted');
        return;
      }
      await showStateAfterFailedResponse(res);
    } catch {
      // サーバーが承諾を済ませてから応答が切れたこともあるので、参加リクエストを読み直して確かめる (#2086 V2)
      await showStateAfterFailure(PROMOTION_NOT_PROCESSED_MESSAGE, NETWORK_FAILURE_MESSAGE);
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * 承諾・拒否の失敗の応答を出す。本文は ok を確かめたあとに .catch(() => null) で読む (#2086 V2。以前は ok の確認より先に
   * res.json() を読み、本文が JSON でない失敗の応答 (プロキシの 502 など) で例外になり、通信エラーの文だけを出していた)。
   *   - 本文に失敗のコードが無い (読めない・形が違う): サーバーが処理したか分からないので、読み直して確かめる
   *   - PROMOTION_REQUEST_ALREADY_USED: 前に押した承諾 / 拒否をサーバーが済ませてから応答が切れたときも、押し直すとこれになる。
   *     読み直して、承認済みなら承諾の成功、拒否済みなら拒否の成功と同じ画面にする
   *   - それ以外のコード: これまでどおりコードごとの文
   */
  const showStateAfterFailedResponse = async (res: Response) => {
    const json: unknown = await res.json().catch(() => null);
    const code = errorCodeOfBody(json);
    if (code === null) {
      await showStateAfterFailure(PROMOTION_NOT_PROCESSED_MESSAGE, NETWORK_FAILURE_MESSAGE);
      return;
    }
    if (code === 'PROMOTION_REQUEST_ALREADY_USED') {
      await showStateAfterFailure(PROMOTION_ALREADY_USED_MESSAGE, PROMOTION_ALREADY_USED_MESSAGE);
      return;
    }
    setActionError(mapActionError(code, errorMessageOfBody(json)));
  };

  const handleReject = async () => {
    setActionError(null);
    setShowRejectConfirm(false);
    setActionLoading('reject');
    try {
      const res = await fetch(`/api/family/promotions/${token}/reject`, { method: 'POST' });
      if (res.ok) {
        setResult('rejected');
        return;
      }
      await showStateAfterFailedResponse(res);
    } catch {
      // サーバーが拒否を済ませてから応答が切れたこともあるので、参加リクエストを読み直して確かめる (#2086 V2。承諾と同じ)
      await showStateAfterFailure(PROMOTION_NOT_PROCESSED_MESSAGE, NETWORK_FAILURE_MESSAGE);
    } finally {
      setActionLoading(null);
    }
  };

  const handleSignOutAndRetry = async () => {
    // CLAUDE.md: サインアウトでは Supabase の signOut より前に端末のユーザー別データを消す
    clearUserScopedLocalStorage();
    // WebView ならネイティブへも signOut の前に知らせる (#1038 F7-10。理由は native-auth-bridge.ts の notifyNativeSignOut)
    notifyNativeSignOut();
    await supabase.auth.signOut();
    broadcastSignOut();
    router.push(`/login?redirect=/family/promotions/${token}`);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">参加リクエストを確認しています…</div>
      </div>
    );
  }

  // 終端: 承認完了
  if (result === 'accepted') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-6">
        <div className="text-6xl">✅</div>
        <h1 className="text-xl font-bold text-gray-900 text-center">
          家族グループに参加しました
        </h1>
        <p className="text-sm text-gray-500 text-center">
          「{details?.family_name ?? '家族グループ'}」のメンバーになりました。
          これまでの食事記録は引き続きご利用いただけます。
        </p>
        <button
          onClick={() => router.push('/family/dashboard')}
          className="px-6 py-3 rounded-full bg-green-500 text-white font-bold text-sm hover:bg-green-600 transition-colors"
        >
          家族ダッシュボードへ
        </button>
      </div>
    );
  }

  // 終端: 拒否完了
  if (result === 'rejected') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-6">
        <div className="text-6xl">🚫</div>
        <h1 className="text-xl font-bold text-gray-900 text-center">
          参加リクエストを拒否しました
        </h1>
        <p className="text-sm text-gray-500 text-center">
          家族グループへの追加は行われません。あなたのデータが共有されることもありません。
        </p>
        <button
          onClick={() => router.push('/')}
          className="px-6 py-3 rounded-full bg-gray-200 text-gray-800 font-bold text-sm hover:bg-gray-300 transition-colors"
        >
          ホームへ戻る
        </button>
      </div>
    );
  }

  // 読み込めなかった (リクエストが無いのとは別。「再試行」を出す)
  if (loadError) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div
          role="alert"
          data-testid="promotion-load-error"
          className="w-full max-w-sm rounded-2xl bg-red-50 border border-red-200 p-6 text-center"
        >
          <p className="text-red-700 text-sm font-medium">{loadError}</p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void loadPage()}
              className="px-4 py-2 rounded-full bg-white border border-red-300 text-red-700 font-medium text-sm hover:bg-red-100 transition-colors"
            >
              再試行
            </button>
            <button
              type="button"
              onClick={() => router.push('/')}
              className="px-4 py-2 rounded-full bg-gray-200 text-gray-600 font-medium text-sm hover:bg-gray-300 transition-colors"
            >
              ホームへ戻る
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 見つからない
  if (error || !details) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div className="text-5xl">📩</div>
        <h1 className="text-xl font-bold text-gray-700">参加リクエストが見つかりません</h1>
        <p className="text-gray-500 text-sm text-center">
          {error ?? 'リンクが無効です'}
        </p>
        <button
          onClick={() => router.push('/')}
          className="px-6 py-3 rounded-full bg-gray-200 text-gray-600 font-medium text-sm hover:bg-gray-300 transition-colors"
        >
          ホームへ戻る
        </button>
      </div>
    );
  }

  // 処理済み (accepted/rejected/revoked/expired)
  if (details.status !== 'pending') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div className="text-5xl">📩</div>
        <h1 className="text-xl font-bold text-gray-700">このリクエストは無効です</h1>
        <p className="text-gray-500 text-sm text-center">
          この参加リクエストは{STATUS_MESSAGES[details.status] ?? details.status}です。
        </p>
        <p className="text-xs text-gray-400">必要な場合はご家族に再送を依頼してください</p>
        <button
          onClick={() => router.push('/')}
          className="px-6 py-3 rounded-full bg-gray-200 text-gray-600 font-medium text-sm hover:bg-gray-300 transition-colors"
        >
          ホームへ戻る
        </button>
      </div>
    );
  }

  // 期限切れ (status='pending' のまま日付超過。accept しても 410 になるため先に案内)
  const isExpired = new Date(details.expires_at) < new Date();
  if (isExpired) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div className="text-5xl">⌛</div>
        <h1 className="text-xl font-bold text-gray-700">期限切れです</h1>
        <p className="text-gray-500 text-sm text-center">
          この参加リクエストの有効期限が切れています。ご家族に再送を依頼してください。
        </p>
        <button
          onClick={() => router.push('/')}
          className="px-6 py-3 rounded-full bg-gray-200 text-gray-600 font-medium text-sm hover:bg-gray-300 transition-colors"
        >
          ホームへ戻る
        </button>
      </div>
    );
  }

  // 未ログイン: 内容を提示してログイン/サインアップへ誘導 (invite ページ パターン A と同型)
  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
        <div className="max-w-sm w-full rounded-2xl bg-white shadow-lg border border-gray-100 overflow-hidden">
          <div className="bg-green-50 px-6 py-5 border-b border-green-100">
            <div className="text-3xl mb-2">🏠</div>
            <h1 className="text-lg font-bold text-gray-900">家族グループ参加の確認</h1>
            <p className="text-sm text-gray-500 mt-1">
              {details.requested_by_name ?? 'ご家族'} 様から「
              {details.family_name ?? '家族グループ'}」への参加確認が届いています
            </p>
          </div>
          <div className="px-6 py-5 space-y-4">
            <p className="text-sm text-gray-500">
              内容の確認と承認には、このリクエストの宛先メールアドレス
              ({details.email})でのログインまたはアカウント作成が必要です。
              承認するまで、家族グループへの追加やデータの共有は行われません。
            </p>
            <div className="space-y-2">
              <button
                onClick={() =>
                  router.push(
                    `/login?redirect=/family/promotions/${token}&email=${encodeURIComponent(details.email)}`,
                  )
                }
                className="w-full rounded-full bg-green-500 py-3 text-white font-bold text-sm hover:bg-green-600 transition-colors"
              >
                ログインする
              </button>
              <button
                onClick={() =>
                  router.push(
                    `/signup?redirect=/family/promotions/${token}&email=${encodeURIComponent(details.email)}`,
                  )
                }
                className="w-full rounded-full border border-green-300 py-3 text-green-600 font-medium text-sm hover:bg-green-50 transition-colors"
              >
                アカウントを作成
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ログイン中 + email 不一致 (invite ページ パターン C と同型)
  if (!details.current_user_email_matches) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
        <div className="max-w-sm w-full rounded-2xl bg-white shadow-lg border border-gray-100 p-6 space-y-4">
          <h1 className="text-lg font-bold text-gray-900">このリクエストは他の方宛てです</h1>
          <div className="text-sm text-gray-600 space-y-1">
            <p>宛先: <span className="font-medium">{details.email}</span></p>
            <p>あなた: <span className="font-medium">{currentEmail}</span></p>
          </div>
          <p className="text-sm text-gray-500">正しいアカウントでログインし直してください</p>
          <button
            onClick={handleSignOutAndRetry}
            className="w-full rounded-full bg-gray-700 py-3 text-white font-medium text-sm hover:bg-gray-800 transition-colors"
          >
            ログアウトしてやり直す
          </button>
        </div>
      </div>
    );
  }

  // pending + ログイン中 + email 一致: 同意カード本体
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
      <div className="max-w-sm w-full rounded-2xl bg-white shadow-xl border border-gray-100 overflow-hidden">
        <div className="bg-green-50 px-6 py-5 border-b border-green-100">
          <h1 className="text-lg font-bold text-gray-900">
            「{details.family_name ?? '家族グループ'}」への参加確認
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {details.requested_by_name ?? 'ご家族'} 様が、あなたをメンバー「
            {details.member_display_name ?? '子供メンバー'}」として登録しようとしています
          </p>
        </div>
        <div className="px-6 py-5 space-y-5">
          <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4">
            {/* #1232: 子供メンバーの枠には食事記録が無く、引き継がれるものは無い。承認で起きること
                (大人のメンバーとして参加し、共有をオンにした記録は過去の分も家族が見られる) を正確に伝える */}
            <p className="text-xs text-blue-700">
              承認すると、あなたのアカウントがメンバー「{details.member_display_name ?? '子供メンバー'}」として
              (大人のメンバーとして) 家族グループに参加します。下で共有をオンにした情報は、
              これまでの記録も含めて家族のメンバーが見られるようになります。承認するまで何も変更されません。
            </p>
          </div>

          {/* 共有設定 (FamilyInviteAcceptModal と同一 UI・同一デフォルト) */}
          <div>
            <p className="text-sm font-medium text-gray-700 mb-3">
              あなたが家族に共有する情報:
            </p>
            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={shareMeals}
                  onChange={(e) => setShareMeals(e.target.checked)}
                  disabled={!!actionLoading}
                  className="w-5 h-5 rounded accent-green-500"
                />
                <div>
                  <span className="text-sm font-medium text-gray-800">食事記録</span>
                  <span className="text-xs text-gray-400 ml-2">献立・食べたもの</span>
                </div>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={shareHealth}
                  onChange={(e) => setShareHealth(e.target.checked)}
                  disabled={!!actionLoading}
                  className="w-5 h-5 rounded accent-green-500"
                />
                <div>
                  <span className="text-sm font-medium text-gray-800">健康記録</span>
                  <span className="text-xs text-gray-400 ml-2">体重・血圧</span>
                </div>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={shareMenu}
                  onChange={(e) => setShareMenu(e.target.checked)}
                  disabled={!!actionLoading}
                  className="w-5 h-5 rounded accent-green-500"
                />
                <div>
                  <span className="text-sm font-medium text-gray-800">週間献立</span>
                  <span className="text-xs text-gray-400 ml-2">予定している献立</span>
                </div>
              </label>
            </div>
            <p className="text-xs text-gray-400 mt-3">※ 後で変更できます</p>
          </div>

          <p className="text-xs text-gray-400">
            期限: {new Date(details.expires_at).toLocaleDateString('ja-JP')} まで
          </p>

          {actionError && (
            <div role="alert" className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-600">
              {actionError}
            </div>
          )}

          <div className="space-y-2">
            <button
              onClick={handleAccept}
              disabled={!!actionLoading}
              className="w-full rounded-full bg-green-500 py-3 text-white font-bold text-sm hover:bg-green-600 transition-colors disabled:opacity-50"
            >
              {actionLoading === 'accept' ? '処理中…' : '参加を承認する'}
            </button>
            <button
              onClick={() => setShowRejectConfirm(true)}
              disabled={!!actionLoading}
              className="w-full rounded-full border border-red-200 py-3 text-red-500 font-medium text-sm hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              拒否する
            </button>
          </div>
        </div>
      </div>

      {/* #1057 (UX1-08): 拒否確認モーダル */}
      {showRejectConfirm && (
        <RejectConfirmDialog
          familyName={details.family_name ?? '家族グループ'}
          loading={!!actionLoading}
          onCancel={() => setShowRejectConfirm(false)}
          onConfirm={handleReject}
        />
      )}
    </div>
  );
}
