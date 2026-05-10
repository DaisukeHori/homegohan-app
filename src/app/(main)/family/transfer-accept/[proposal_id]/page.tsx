'use client';

// src/app/(main)/family/transfer-accept/[proposal_id]/page.tsx
// (設計書 03-ui-spec.md §10.2, 02-flow-spec.md §10)
import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface TransferProposal {
  id: string;
  scope: string;
  scope_id: string;
  from_user_id: string;
  to_user_id: string;
  status: string;
  proposed_at: string;
  expires_at: string;
}

export default function FamilyTransferAcceptPage({
  params,
}: {
  params: Promise<{ proposal_id: string }>;
}) {
  const { proposal_id } = use(params);
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [proposal, setProposal] = useState<TransferProposal | null>(null);
  const [fromName, setFromName] = useState<string | null>(null);
  const [familyName, setFamilyName] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<'accept' | 'decline' | null>(null);
  const [result, setResult] = useState<'accepted' | 'declined' | null>(null);

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return;
      }
      setCurrentUserId(user.id);

      const { data: proposalData, error: proposalError } = await supabase
        .from('ownership_transfer_proposals')
        .select('*')
        .eq('id', proposal_id)
        .single();

      if (proposalError || !proposalData) {
        setError('譲渡提案が見つかりません');
        setLoading(false);
        return;
      }

      setProposal(proposalData as TransferProposal);

      // 提案者情報
      const { data: fromProfile } = await supabase
        .from('user_profiles')
        .select('nickname, email')
        .eq('id', proposalData.from_user_id)
        .single();
      setFromName(fromProfile?.nickname ?? fromProfile?.email ?? '代表者');

      // 家族グループ名
      if (proposalData.scope === 'family') {
        const { data: group } = await supabase
          .from('family_groups')
          .select('name')
          .eq('id', proposalData.scope_id)
          .single();
        setFamilyName(group?.name ?? '家族グループ');
      }

      setLoading(false);
    };

    init();
  }, [supabase, router, proposal_id]);

  const handleAccept = async () => {
    setActionLoading('accept');
    try {
      const res = await fetch(`/api/family/representative-transfer/${proposal_id}/accept`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? '承諾に失敗しました');
        return;
      }
      setResult('accepted');
    } catch {
      setError('通信エラーが発生しました');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDecline = async () => {
    if (!window.confirm('譲渡提案を拒否しますか？')) return;
    setActionLoading('decline');
    try {
      const res = await fetch(`/api/family/representative-transfer/${proposal_id}/decline`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? '拒否に失敗しました');
        return;
      }
      setResult('declined');
    } catch {
      setError('通信エラーが発生しました');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">読み込み中…</div>
      </div>
    );
  }

  if (result === 'accepted') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-6">
        <div className="text-6xl">✅</div>
        <h1 className="text-xl font-bold text-gray-900 text-center">
          代表者を引き継ぎました
        </h1>
        <p className="text-sm text-gray-500 text-center">
          あなたが「{familyName}」の新しい代表者になりました。
        </p>
        <button
          onClick={() => router.push('/family/members')}
          className="px-6 py-3 rounded-full bg-green-500 text-white font-bold text-sm hover:bg-green-600 transition-colors"
        >
          メンバー一覧を確認
        </button>
      </div>
    );
  }

  if (result === 'declined') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-6">
        <div className="text-6xl">🚫</div>
        <h1 className="text-xl font-bold text-gray-900 text-center">
          譲渡提案を拒否しました
        </h1>
        <p className="text-sm text-gray-500 text-center">
          {fromName} 様に拒否のご連絡が届きます。
        </p>
        <button
          onClick={() => router.push('/family/members')}
          className="px-6 py-3 rounded-full bg-gray-200 text-gray-800 font-bold text-sm hover:bg-gray-300 transition-colors"
        >
          メンバー一覧へ戻る
        </button>
      </div>
    );
  }

  if (error && !proposal) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-gray-600 text-sm text-center">{error}</p>
        <button
          onClick={() => router.back()}
          className="px-4 py-2 rounded-full bg-gray-100 text-gray-600 text-sm"
        >
          戻る
        </button>
      </div>
    );
  }

  const isExpired = proposal && new Date(proposal.expires_at) < new Date();
  const isNotPending = proposal && proposal.status !== 'pending';
  const isNotRecipient = proposal && currentUserId && proposal.to_user_id !== currentUserId;

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* ヘッダー */}
      <div className="bg-white p-6 pb-4 border-b border-gray-100 sticky top-0 z-20">
        <h1 className="text-2xl font-bold text-gray-900">代表者譲渡の提案</h1>
      </div>

      <div className="p-6 space-y-6">
        {/* 提案内容 */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <div className="text-center space-y-3">
            <div className="text-4xl">🔄</div>
            <p className="text-gray-800">
              <span className="font-bold">{fromName}</span> 様から
            </p>
            <p className="text-gray-800">
              「<span className="font-bold">{familyName}</span>」の
              <span className="font-bold text-green-600">代表者</span> を引き継ぐよう依頼されています
            </p>
            <p className="text-xs text-gray-400">
              提案日時: {proposal ? new Date(proposal.proposed_at).toLocaleDateString('ja-JP') : ''}
            </p>
            <p className="text-xs text-gray-400">
              期限: {proposal ? new Date(proposal.expires_at).toLocaleDateString('ja-JP') : ''}
            </p>
          </div>
        </div>

        {/* 状態に応じたメッセージ */}
        {isExpired && (
          <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 text-center">
            <p className="text-sm text-gray-500">この提案は期限切れです</p>
          </div>
        )}

        {isNotPending && !isExpired && (
          <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 text-center">
            <p className="text-sm text-gray-500">この提案は既に処理されています (ステータス: {proposal?.status})</p>
          </div>
        )}

        {isNotRecipient && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-4">
            <p className="text-sm text-yellow-700">この提案はあなた宛てではありません</p>
          </div>
        )}

        {/* エラー */}
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
            {error}
          </div>
        )}

        {/* アクションボタン (pending かつ自分宛て かつ 期限内) */}
        {proposal?.status === 'pending' && !isExpired && !isNotRecipient && (
          <div className="space-y-3">
            <button
              onClick={handleAccept}
              disabled={!!actionLoading}
              className="w-full rounded-full bg-green-500 py-4 text-white font-bold text-base hover:bg-green-600 transition-colors disabled:opacity-50"
            >
              {actionLoading === 'accept' ? '承諾中…' : '承諾する (代表者になる)'}
            </button>
            <button
              onClick={handleDecline}
              disabled={!!actionLoading}
              className="w-full rounded-full bg-gray-100 py-4 text-gray-700 font-bold text-base hover:bg-gray-200 transition-colors disabled:opacity-50"
            >
              {actionLoading === 'decline' ? '拒否中…' : '拒否する'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
