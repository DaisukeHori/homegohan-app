'use client';

// (設計書 03-ui-spec.md §1.2, 12.2)
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface FamilyInvite {
  id: string;
  email: string;
  status: string;
  expires_at: string;
  created_at: string;
}

export default function FamilyInvitePage() {
  const router = useRouter();
  const supabase = createClient();

  const [familyId, setFamilyId] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [customMessage, setCustomMessage] = useState('');
  const [invites, setInvites] = useState<FamilyInvite[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchingInvites, setFetchingInvites] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return;
      }

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('family_id')
        .eq('id', user.id)
        .single();

      if (!profile?.family_id) {
        router.replace('/family/setup');
        return;
      }

      setFamilyId(profile.family_id);

      // 招待履歴取得
      const res = await fetch('/api/family/invites');
      if (res.ok) {
        const json = await res.json();
        setInvites(json.data?.invites ?? []);
      }
      setFetchingInvites(false);
    };

    init();
  }, [supabase, router]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (!email.trim()) {
      setError('メールアドレスを入力してください');
      return;
    }
    if (!familyId) {
      setError('家族グループが見つかりません');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/family/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          family_id: familyId,
          email: email.trim().toLowerCase(),
          custom_message: customMessage.trim() || undefined,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        if (json.error?.code === 'ALREADY_IN_FAMILY') {
          setError('このメールアドレスは既に家族グループのメンバーです');
        } else if (json.error?.code === 'MEMBER_LIMIT_EXCEEDED') {
          setError('メンバー数の上限に達しています');
        } else {
          setError(json.error?.message ?? '招待の送信に失敗しました');
        }
        return;
      }

      setSuccessMsg(`${email} に招待メールを送信しました`);
      setEmail('');
      setCustomMessage('');

      // 招待履歴を再取得
      const refreshRes = await fetch('/api/family/invites');
      if (refreshRes.ok) {
        const refreshJson = await refreshRes.json();
        setInvites(refreshJson.data?.invites ?? []);
      }
    } catch (err) {
      setError('通信エラーが発生しました');
      console.error('[family/invite] error:', err);
    } finally {
      setLoading(false);
    }
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case 'pending': return '待機中';
      case 'accepted': return '承諾済';
      case 'rejected': return '拒否済';
      case 'expired': return '期限切れ';
      case 'revoked': return '取消済';
      default: return status;
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'text-yellow-600 bg-yellow-50';
      case 'accepted': return 'text-green-600 bg-green-50';
      case 'rejected': return 'text-red-600 bg-red-50';
      case 'expired': return 'text-gray-500 bg-gray-50';
      case 'revoked': return 'text-gray-400 bg-gray-50';
      default: return 'text-gray-500 bg-gray-50';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* ヘッダー */}
      <div className="bg-white p-6 pb-4 border-b border-gray-100 sticky top-0 z-20">
        <button
          onClick={() => router.back()}
          className="text-sm text-gray-400 mb-2 flex items-center gap-1"
        >
          ← 戻る
        </button>
        <h1 className="text-2xl font-bold text-gray-900">大人メンバーを招待</h1>
        <p className="text-xs text-gray-400 mt-1">メールアドレスに招待リンクを送信します</p>
      </div>

      <div className="p-6 space-y-8">
        {/* 招待フォーム */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              メールアドレス
              <span className="text-red-500 ml-1">*</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="招待したい方のメールアドレス"
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
              disabled={loading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              メッセージ (任意)
            </label>
            <textarea
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              placeholder="招待メールに添えるメッセージ"
              rows={3}
              maxLength={500}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100 resize-none"
              disabled={loading}
            />
            <p className="text-xs text-gray-400 mt-1">{customMessage.length}/500 文字</p>
          </div>

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="rounded-xl bg-green-50 border border-green-200 p-4 text-sm text-green-700">
              {successMsg}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email.trim()}
            className="w-full rounded-full bg-green-500 py-4 text-white font-bold text-base hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '送信中…' : '招待を送信'}
          </button>
        </form>

        {/* 子供追加へのリンク */}
        <button
          onClick={() => router.push('/family/members/child/new')}
          className="w-full rounded-2xl bg-white border border-dashed border-gray-300 p-4 text-gray-500 text-sm flex items-center justify-center gap-2 hover:bg-gray-50 transition-colors"
        >
          <span>🧒</span>
          <span>子供を追加 (アカウント不要)</span>
        </button>

        {/* 招待履歴 */}
        {!fetchingInvites && invites.length > 0 && (
          <div>
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">
              招待履歴
            </h2>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              {invites.map((invite, idx) => (
                <div
                  key={invite.id}
                  className={`flex items-center justify-between p-4 ${
                    idx < invites.length - 1 ? 'border-b border-gray-50' : ''
                  }`}
                >
                  <div>
                    <div className="font-medium text-gray-800 text-sm">{invite.email}</div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      期限: {new Date(invite.expires_at).toLocaleDateString('ja-JP')}
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColor(invite.status)}`}>
                    {statusLabel(invite.status)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
