'use client';

// src/app/(main)/family/members/[id]/promote/page.tsx
// (設計書 03-ui-spec.md §9, 02-flow-spec.md §9)
import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface FamilyMember {
  id: string;
  display_name: string | null;
  role: string;
  user_id: string | null;
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
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

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
      setLoading(false);
    };

    init();
  }, [supabase, router, memberId]);

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
        setError(json.error?.message ?? 'アカウント発行に失敗しました');
        return;
      }

      setSuccess(true);
    } catch (err) {
      setError('通信エラーが発生しました');
      console.error('[family/members/promote] error:', err);
    } finally {
      setSubmitting(false);
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

  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-6">
        <div className="text-6xl">✅</div>
        <h1 className="text-xl font-bold text-gray-900 text-center">
          アカウントを発行しました
        </h1>
        <p className="text-sm text-gray-500 text-center">
          {email} に招待メールを送信しました。
          メールを確認してアカウントを設定してください。
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
          {member?.display_name ?? '子供'} にアカウントを発行
        </h1>
        <p className="text-xs text-gray-400 mt-1">子供メンバーが自分のアカウントで使えるようになります</p>
      </div>

      <div className="p-6">
        <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 mb-6">
          <p className="text-sm text-blue-700">
            アカウント作成後、過去の食事記録は {member?.display_name ?? '子供'} のアカウントに引き継がれます。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* メールアドレス */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              メールアドレス
              <span className="text-red-500 ml-1">*</span>
            </label>
            <input
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
            {submitting ? '発行中…' : 'アカウントを発行'}
          </button>
        </form>
      </div>
    </div>
  );
}
