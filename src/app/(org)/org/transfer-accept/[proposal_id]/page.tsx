"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface ProposalInfo {
  id: string;
  from_user_id: string;
  to_user_id: string;
  status: string;
  proposed_at: string;
  expires_at: string;
  reason: string | null;
  scope_id: string;
}

interface OrgInfo {
  name: string;
}

interface UserInfo {
  nickname: string | null;
}

export default function TransferAcceptPage() {
  const router = useRouter();
  const params = useParams();
  const supabase = createClient();
  const proposalId = params.proposal_id as string;

  const [proposal, setProposal] = useState<ProposalInfo | null>(null);
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [fromUser, setFromUser] = useState<UserInfo | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchProposal = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          router.push(`/login?next=/org/transfer-accept/${proposalId}`);
          return;
        }
        setCurrentUserId(user.id);

        const { data: proposalData } = await supabase
          .from('ownership_transfer_proposals')
          .select('id, from_user_id, to_user_id, status, proposed_at, expires_at, reason, scope_id')
          .eq('id', proposalId)
          .single();

        if (!proposalData) {
          setError('提案が見つかりません');
          return;
        }

        setProposal(proposalData);

        // 組織名取得
        const { data: orgData } = await supabase
          .from('organizations')
          .select('name')
          .eq('id', proposalData.scope_id)
          .single();
        setOrg(orgData);

        // 提案者のプロフィール取得
        const { data: fromUserData } = await supabase
          .from('user_profiles')
          .select('nickname')
          .eq('id', proposalData.from_user_id)
          .single();
        setFromUser(fromUserData);
      } finally {
        setLoading(false);
      }
    };

    fetchProposal();
  }, [proposalId]);

  const handleAccept = async () => {
    if (!confirm('オーナー権限を引き受けますか？')) return;
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/org/owner-transfer/${proposalId}/accept`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? '受諾に失敗しました');
        return;
      }
      alert('オーナー権限を引き受けました。');
      router.push('/org/dashboard');
    } catch {
      setError('ネットワークエラーが発生しました');
    } finally {
      setAccepting(false);
    }
  };

  const handleDecline = async () => {
    if (!confirm('この譲渡提案を拒否しますか？')) return;
    setDeclining(true);
    setError(null);
    try {
      const res = await fetch(`/api/org/owner-transfer/${proposalId}/decline`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? '拒否に失敗しました');
        return;
      }
      alert('譲渡提案を拒否しました。');
      router.push('/home');
    } catch {
      setError('ネットワークエラーが発生しました');
    } finally {
      setDeclining(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error && !proposal) {
    return (
      <div className="p-8 max-w-lg mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-2xl p-8 text-center">
          <p className="text-red-700 font-medium">{error}</p>
          <button
            onClick={() => router.push('/home')}
            className="mt-4 px-4 py-2 rounded-xl bg-gray-100 text-gray-700 font-medium hover:bg-gray-200 transition-colors"
          >
            ホームへ戻る
          </button>
        </div>
      </div>
    );
  }

  if (!proposal) return null;

  const isExpired = new Date(proposal.expires_at) < new Date();
  const isNotPending = proposal.status !== 'pending';
  const isWrongUser = currentUserId && currentUserId !== proposal.to_user_id;

  const statusMessage = () => {
    if (proposal.status === 'accepted') return 'この提案はすでに承諾済みです';
    if (proposal.status === 'rejected') return 'この提案は拒否済みです';
    if (isExpired) return 'この提案は期限切れです';
    return null;
  };

  const statusMsg = statusMessage();

  return (
    <div className="p-8 max-w-lg mx-auto">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 border-b border-gray-100 bg-amber-50">
          <h1 className="text-xl font-bold text-gray-900">オーナー譲渡の提案</h1>
          <p className="text-sm text-amber-700 mt-1">
            {org?.name ?? '組織'} のオーナー権限を引き受けるかどうか選択してください
          </p>
        </div>

        <div className="p-6 space-y-4">
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">提案者</span>
              <span className="font-medium text-gray-900">
                {fromUser?.nickname ?? '(不明)'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">対象組織</span>
              <span className="font-medium text-gray-900">{org?.name ?? '-'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">提案日時</span>
              <span className="font-medium text-gray-900">
                {new Date(proposal.proposed_at).toLocaleDateString('ja-JP')}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">有効期限</span>
              <span className={`font-medium ${isExpired ? 'text-red-600' : 'text-gray-900'}`}>
                {new Date(proposal.expires_at).toLocaleDateString('ja-JP')}
                {isExpired && ' (期限切れ)'}
              </span>
            </div>
            {proposal.reason && (
              <div className="text-sm">
                <p className="text-gray-500 mb-1">理由</p>
                <p className="text-gray-800 bg-gray-50 rounded-lg p-3 text-sm">
                  {proposal.reason}
                </p>
              </div>
            )}
          </div>

          {statusMsg && (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl text-gray-600 text-sm text-center">
              {statusMsg}
            </div>
          )}

          {isWrongUser && (
            <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-xl text-yellow-700 text-sm">
              この提案はあなた宛てではありません。正しいアカウントでログインしてください。
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
              {error}
            </div>
          )}
        </div>

        {!statusMsg && !isWrongUser && (
          <div className="p-6 pt-0 flex gap-3">
            <button
              onClick={handleDecline}
              disabled={declining || accepting}
              className="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-gray-600 font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {declining ? '処理中...' : '拒否'}
            </button>
            <button
              onClick={handleAccept}
              disabled={accepting || declining}
              className="flex-1 px-4 py-3 rounded-xl bg-amber-500 text-white font-bold hover:bg-amber-600 transition-colors disabled:opacity-50 shadow-sm shadow-amber-200"
            >
              {accepting ? '処理中...' : '承諾'}
            </button>
          </div>
        )}

        {(statusMsg || isWrongUser) && (
          <div className="p-6 pt-0">
            <button
              onClick={() => router.push('/home')}
              className="w-full px-4 py-3 rounded-xl bg-gray-100 text-gray-700 font-medium hover:bg-gray-200 transition-colors"
            >
              ホームへ戻る
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
