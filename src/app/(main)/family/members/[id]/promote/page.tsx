'use client';

// src/app/(main)/family/members/[id]/promote/page.tsx
// #1232: 旧・即時「アカウント発行」UI を、本人同意フロー (参加リクエスト送信) UI へ全面書換。
// - 送信成功時の文言を非同期フローに合わせて修正 (「発行しました」→「リクエストを送信しました」)
// - 既存 pending リクエストの表示 / 取消 (DELETE) / 再送 (フォーム再表示) を追加
import { useState, useEffect, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface FamilyMember {
  id: string;
  display_name: string | null;
  role: string;
  user_id: string | null;
}

interface PendingPromotionRequest {
  id: string;
  email: string;
  status: string;
  expires_at: string;
}

export default function PromoteMemberPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: memberId } = use(params);
  const router = useRouter();
  const supabase = createClient();

  const [member, setMember] = useState<FamilyMember | null>(null);
  const [pendingRequest, setPendingRequest] = useState<PendingPromotionRequest | null>(null);
  const [showForm, setShowForm] = useState(false); // pending があっても再送フォームを開ける
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null); // 送信先 email

  const loadPendingRequest = useCallback(async () => {
    // ★#1232: token 列は列単位 GRANT で読めないため select('*') 禁止。明示列リストで取得。
    const { data } = await supabase
      .from('family_promotion_requests')
      .select('id, email, status, expires_at')
      .eq('member_id', memberId)
      .eq('status', 'pending')
      .maybeSingle();
    setPendingRequest((data as PendingPromotionRequest | null) ?? null);
  }, [supabase, memberId]);

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

      const { data: memberData, error: memberError } = await supabase
        .from('family_members')
        .select('id, display_name, role, user_id')
        .eq('id', memberId)
        .eq('family_id', profile.family_id)
        .single();

      if (memberError || !memberData) {
        setError('メンバーが見つかりません');
        setLoading(false);
        return;
      }

      if (memberData.role !== 'child') {
        setError('この操作は子供メンバーにのみ使用できます');
        setLoading(false);
        return;
      }

      if (memberData.user_id) {
        setError('このメンバーは既にアカウントを持っています');
        setLoading(false);
        return;
      }

      setMember(memberData as FamilyMember);
      await loadPendingRequest();
      setLoading(false);
    };

    init();
  }, [supabase, router, memberId, loadPendingRequest]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError('メールアドレスを入力してください');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/family/members/${memberId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error?.message ?? 'リクエストの送信に失敗しました');
        return;
      }

      setSuccess(json.data?.request?.email ?? email.trim().toLowerCase());
    } catch (err) {
      setError('通信エラーが発生しました');
      console.error('[family/members/promote] error:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async () => {
    setError(null);
    setRevoking(true);
    try {
      const res = await fetch(`/api/family/members/${memberId}/promote`, { method: 'DELETE' });
      const json = await res.json();

      if (!res.ok) {
        setError(json.error?.message ?? 'リクエストの取消に失敗しました');
        return;
      }

      setPendingRequest(null);
      setShowForm(false);
    } catch (err) {
      setError('通信エラーが発生しました');
      console.error('[family/members/promote] revoke error:', err);
    } finally {
      setRevoking(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">読み込み中…</div>
      </div>
    );
  }

  if (error && !member) {
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

  // ★#1232: 成功画面 — 旧「アカウントを発行しました」を非同期フローの事実に合わせて全面差し替え
  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-6">
        <div className="text-6xl">📨</div>
        <h1 className="text-xl font-bold text-gray-900 text-center">
          参加リクエストを送信しました
        </h1>
        <p className="text-sm text-gray-500 text-center">
          {success} 宛に、ご本人確認のメールをお送りしました。
          ご本人がメールのリンクから承認すると、メンバーとして追加されます。
          承認されるまでメンバーは追加されません。
        </p>
        <p className="text-xs text-gray-400 text-center">
          リクエストの有効期限は 14 日間です。このページからいつでも取り消せます。
        </p>
        <button
          onClick={() => router.push('/family/members')}
          className="px-6 py-3 rounded-full bg-green-500 text-white font-bold text-sm hover:bg-green-600 transition-colors"
        >
          メンバー一覧に戻る
        </button>
      </div>
    );
  }

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
        <h1 className="text-2xl font-bold text-gray-900">
          {member?.display_name ?? '子供'} の参加リクエスト
        </h1>
        <p className="text-xs text-gray-400 mt-1">
          ご本人のメールアドレスに確認メールを送り、本人が承認すると自分のアカウントで使えるようになります
        </p>
      </div>

      <div className="p-6">
        {/* pending リクエストがある場合の管理カード */}
        {pendingRequest && !showForm && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6 space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-2xl">⏳</span>
              <h2 className="text-base font-bold text-gray-900">承認待ちのリクエストがあります</h2>
            </div>
            <div className="text-sm text-gray-600 space-y-1">
              <p>送信先: <span className="font-medium">{pendingRequest.email}</span></p>
              <p>
                期限: {new Date(pendingRequest.expires_at).toLocaleDateString('ja-JP')} まで
              </p>
            </div>
            <p className="text-xs text-gray-400">
              ご本人がメールのリンクから承認するとメンバーに追加されます。
            </p>
            {error && (
              <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <button
                onClick={handleRevoke}
                disabled={revoking}
                className="w-full rounded-full border border-red-200 py-3 text-red-500 font-medium text-sm hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                {revoking ? '取消中…' : 'リクエストを取り消す'}
              </button>
              <button
                onClick={() => {
                  setError(null);
                  setShowForm(true);
                }}
                disabled={revoking}
                className="w-full rounded-full border border-gray-200 py-3 text-gray-500 font-medium text-sm hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                別のメールアドレスで再送する
              </button>
            </div>
          </div>
        )}

        {/* 新規送信 / 再送フォーム */}
        {(!pendingRequest || showForm) && (
          <>
            <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 mb-6">
              <p className="text-sm text-blue-700">
                ご本人が承認すると、これまでの食事記録は
                {member?.display_name ?? '子供'} さんのアカウントに引き継がれます。
                承認されるまでメンバーの状態は変わりません。
                {pendingRequest && showForm
                  ? ' 再送すると、承認待ちの現在のリクエストは自動的に取り消されます。'
                  : ''}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              {/* メールアドレス */}
              <div>
                <label htmlFor="promotion-email" className="block text-sm font-medium text-gray-700 mb-2">
                  メールアドレス
                  <span className="text-red-500 ml-1">*</span>
                </label>
                <input
                  id="promotion-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="子供本人のメールアドレス"
                  className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
                  disabled={submitting}
                />
              </div>

              {/* エラー */}
              {error && (
                <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
                  {error}
                </div>
              )}

              {/* 送信ボタン */}
              <button
                type="submit"
                disabled={submitting || !email.trim()}
                className="w-full rounded-full bg-green-500 py-4 text-white font-bold text-base hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? '送信中…' : '参加リクエストを送信'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
