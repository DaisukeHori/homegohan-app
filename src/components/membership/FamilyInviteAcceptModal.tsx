'use client';

// (設計書 02-flow-spec.md §7, 03-ui-spec.md §2.1 パターン B)
// 承諾モーダル: share_meals/share_health/share_menu の checkbox + 承諾/拒否/後で ボタン

import { useState } from 'react';

export interface FamilyInviteAcceptModalProps {
  token: string;
  familyName: string;
  inviterName: string;
  expiresAt: string;            // ISO 文字列
  onAccepted?: () => void;
  onRejected?: () => void;
  onDefer?: () => void;         // 「後で」
}

export function FamilyInviteAcceptModal({
  token,
  familyName,
  inviterName,
  expiresAt,
  onAccepted,
  onRejected,
  onDefer,
}: FamilyInviteAcceptModalProps) {
  const [shareMeals, setShareMeals] = useState(true);
  const [shareHealth, setShareHealth] = useState(false);
  const [shareMenu, setShareMenu] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #1057 (UX1-08): 誤タップでの即時拒否確定を防ぐ確認ステップ
  // (onboarding/resume ページのリセット確認モーダルと同パターン)
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);

  const expiresDate = new Date(expiresAt).toLocaleDateString('ja-JP');

  const handleAccept = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/family/invites/${token}/accept`, {
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
        const code = json.error?.code;
        switch (code) {
          case 'INVITE_EXPIRED':
            setError('この招待の期限が切れています。招待者に再送を依頼してください。');
            break;
          case 'ALREADY_IN_FAMILY':
            setError('既に家族グループに所属しています。');
            break;
          case 'INVITE_ALREADY_USED':
            setError('この招待は既に使用済みです。');
            break;
          case 'INVITE_REVOKED':
            setError('この招待は取り消されています。');
            break;
          case 'INVITE_EMAIL_MISMATCH':
            setError('招待のメールアドレスと現在のアカウントが一致しません。');
            break;
          default:
            setError(json.error?.message ?? '招待の承諾に失敗しました');
        }
        return;
      }

      onAccepted?.();
    } catch (err) {
      setError('通信エラーが発生しました');
      console.error('[FamilyInviteAcceptModal] accept error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    setError(null);
    setShowRejectConfirm(false);
    setLoading(true);
    try {
      await fetch(`/api/family/invites/${token}/reject`, { method: 'POST' });
      onRejected?.();
    } catch (err) {
      console.error('[FamilyInviteAcceptModal] reject error:', err);
      onRejected?.(); // エラーでも UI 側は遷移
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl bg-white shadow-xl border border-gray-100 overflow-hidden max-w-sm w-full mx-auto">
      {/* ヘッダー */}
      <div className="bg-green-50 px-6 py-5 border-b border-green-100">
        <h2 className="text-lg font-bold text-gray-900">
          {familyName}への招待
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          {inviterName} 様から招待が届いています
        </p>
      </div>

      <div className="px-6 py-5 space-y-5">
        {/* 共有設定 */}
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
                disabled={loading}
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
                disabled={loading}
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
                disabled={loading}
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

        {/* 期限 */}
        <p className="text-xs text-gray-400">
          期限: {expiresDate} まで
        </p>

        {/* エラー */}
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-600">
            {error}
          </div>
        )}

        {/* ボタン */}
        <div className="space-y-2">
          <button
            onClick={handleAccept}
            disabled={loading}
            className="w-full rounded-full bg-green-500 py-3 text-white font-bold text-sm hover:bg-green-600 transition-colors disabled:opacity-50"
          >
            {loading ? '処理中…' : '承諾する'}
          </button>

          <div className="flex gap-2">
            <button
              onClick={() => setShowRejectConfirm(true)}
              disabled={loading}
              className="flex-1 rounded-full border border-red-200 py-3 text-red-500 font-medium text-sm hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              拒否する
            </button>
            {onDefer && (
              <button
                onClick={onDefer}
                disabled={loading}
                className="flex-1 rounded-full border border-gray-200 py-3 text-gray-500 font-medium text-sm hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                後で
              </button>
            )}
          </div>
        </div>
      </div>

      {/* #1057 (UX1-08): 拒否確認モーダル — 誤タップでの即時確定・招待者への再送依頼のみが
          リカバリー手段になってしまう事故を防ぐ */}
      {showRejectConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-bold text-gray-900 mb-2">確認</h3>
            <p className="text-gray-600 text-sm mb-6">
              {familyName}への招待を拒否します。<br />
              取り消す場合は招待者に再送を依頼する必要があります。よろしいですか？
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowRejectConfirm(false)}
                disabled={loading}
                className="flex-1 py-3 rounded-full border-2 border-gray-200 text-gray-600 font-bold transition-colors hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleReject}
                disabled={loading}
                className="flex-1 py-3 rounded-full bg-red-500 hover:bg-red-600 text-white font-bold transition-colors disabled:opacity-50"
              >
                {loading ? '処理中…' : '拒否する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
