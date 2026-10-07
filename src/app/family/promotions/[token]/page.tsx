'use client';

// src/app/family/promotions/[token]/page.tsx
// #1232: 子供メンバー昇格 (家族グループ参加) の本人同意ページ。メールリンク着地。
// 状態分岐は src/app/invite/[token]/page.tsx (未ログイン/不一致/無効) を、
// 単一対象者・単一決定の構造とアクション部は
// src/app/(main)/family/transfer-accept/[proposal_id]/page.tsx を踏襲。
// 共有設定チェックボックスは FamilyInviteAcceptModal と同じ 3 種 + デフォルト値。
// (main) ルートグループの外に置く: 未ログイン・オンボーディング未完了でも到達できる必要がある
// (lib/supabase/middleware.ts の publicPaths と lib/onboarding-routing.ts で除外済み)。
import { useState, useEffect, useId, use } from 'react';
import { useRouter } from 'next/navigation';
import FocusTrap from 'focus-trap-react';
import { createClient } from '@/lib/supabase/client';
import { clearUserScopedLocalStorage, broadcastSignOut } from '@/lib/user-storage';
import { useDialogA11y } from '@/components/common/useDialogA11y';

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

export default function FamilyPromotionConsentPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [details, setDetails] = useState<PromotionDetails | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<'accept' | 'reject' | null>(null);
  const [result, setResult] = useState<'accepted' | 'rejected' | null>(null);
  const [shareMeals, setShareMeals] = useState(true);
  const [shareHealth, setShareHealth] = useState(false);
  const [shareMenu, setShareMenu] = useState(true);
  // #1057 (UX1-08): 誤タップでの即時拒否確定を防ぐ確認ステップ
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setIsLoggedIn(!!user);
      setCurrentEmail(user?.email ?? null);

      // get_promotion_details は SECURITY DEFINER + anon EXECUTE (get_invite_details と同趣旨)
      const { data, error: rpcError } = await supabase.rpc('get_promotion_details', {
        p_token: token,
      });
      if (rpcError || !data) {
        setError('参加リクエストが見つかりません');
        setLoading(false);
        return;
      }
      setDetails(data as PromotionDetails);
      setLoading(false);
    };
    init();
  }, [supabase, token]);

  const mapActionError = (code: string | undefined, fallback: string | undefined): string => {
    switch (code) {
      case 'PROMOTION_REQUEST_EXPIRED':
        return 'この参加リクエストの期限が切れています。ご家族に再送を依頼してください。';
      case 'PROMOTION_REQUEST_ALREADY_USED':
        return 'この参加リクエストは既に処理済みです。';
      case 'PROMOTION_EMAIL_MISMATCH':
        return 'この参加リクエストは現在ログイン中のアカウント宛てではありません。';
      case 'ALREADY_IN_FAMILY':
        return '既に家族グループに所属しているため参加できません。';
      case 'ALREADY_PROMOTED':
      case 'PROMOTION_MEMBER_UNAVAILABLE':
        return 'このメンバー枠は現在利用できません。ご家族にご確認ください。';
      case 'CONFLICT_RETRY':
        return '他の操作と競合しました。数秒おいてもう一度お試しください。';
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
      const json = await res.json();
      if (!res.ok) {
        setActionError(mapActionError(json.error?.code, json.error?.message));
        return;
      }
      setResult('accepted');
    } catch {
      setActionError('通信エラーが発生しました');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async () => {
    setActionError(null);
    setShowRejectConfirm(false);
    setActionLoading('reject');
    try {
      const res = await fetch(`/api/family/promotions/${token}/reject`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setActionError(mapActionError(json.error?.code, json.error?.message));
        return;
      }
      setResult('rejected');
    } catch {
      setActionError('通信エラーが発生しました');
    } finally {
      setActionLoading(null);
    }
  };

  const handleSignOutAndRetry = async () => {
    // CLAUDE.md: サインアウトでは Supabase の signOut より前に端末のユーザー別データを消す
    clearUserScopedLocalStorage();
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
            <p className="text-xs text-blue-700">
              承認すると、このメンバー枠のこれまでの食事記録があなたのアカウントに
              引き継がれ、家族グループに参加します。承認するまで何も変更されません。
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
