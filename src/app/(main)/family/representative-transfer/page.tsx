'use client';

// src/app/(main)/family/representative-transfer/page.tsx
// (設計書 03-ui-spec.md §10.2, 02-flow-spec.md §10)
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface FamilyMember {
  id: string;
  role: 'representative' | 'adult' | 'child';
  display_name: string | null;
  user_id: string | null;
}

export default function FamilyRepresentativeTransferPage() {
  const router = useRouter();
  const supabase = createClient();

  const [familyId, setFamilyId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<FamilyMember[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return;
      }
      setCurrentUserId(user.id);

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

      // 自分のロールを確認
      const { data: myMember } = await supabase
        .from('family_members')
        .select('role')
        .eq('family_id', profile.family_id)
        .eq('user_id', user.id)
        .single();

      if (myMember?.role !== 'representative') {
        setError('この操作は代表者のみが行えます');
        setLoading(false);
        return;
      }

      // 候補 (adult のみ、自分を除く)
      const { data: membersData } = await supabase
        .from('family_members')
        .select('id, role, display_name, user_id')
        .eq('family_id', profile.family_id)
        .eq('status', 'active')
        .in('role', ['adult'])
        .neq('user_id', user.id);

      setCandidates((membersData ?? []) as FamilyMember[]);
      setLoading(false);
    };

    init();
  }, [supabase, router]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!selectedUserId) {
      setError('譲渡先のメンバーを選択してください');
      return;
    }
    if (!familyId) {
      setError('家族グループが見つかりません');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/family/representative-transfer/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          family_id: familyId,
          to_user_id: selectedUserId,
          reason: reason.trim() || undefined,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error?.message ?? '代表者譲渡の提案に失敗しました');
        return;
      }

      setSuccess(true);
    } catch (err) {
      setError('通信エラーが発生しました');
      console.error('[family/representative-transfer] error:', err);
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

  if (error && candidates.length === 0 && !familyId) {
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
          譲渡提案を送信しました
        </h1>
        <p className="text-sm text-gray-500 text-center">
          選択したメンバーに確認メールを送信しました。
          承諾されると代表者が変更されます。
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
        <h1 className="text-2xl font-bold text-gray-900">代表者を譲渡</h1>
        <p className="text-xs text-gray-400 mt-1">新しい代表者候補に承諾確認メールを送信します</p>
      </div>

      <div className="p-6">
        {candidates.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
            <p className="text-gray-400 text-sm">
              代表者を引き継げるメンバーがいません。
              まず大人メンバーを招待してください。
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* 候補者選択 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                新しい代表者候補
                <span className="text-red-500 ml-1">*</span>
              </label>
              <div className="space-y-2">
                {candidates.map((candidate) => (
                  <label
                    key={candidate.id}
                    className={`flex items-center gap-3 p-4 rounded-2xl border cursor-pointer transition-colors ${
                      selectedUserId === candidate.user_id
                        ? 'border-green-400 bg-green-50'
                        : 'border-gray-100 bg-white hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="candidate"
                      value={candidate.user_id ?? ''}
                      checked={selectedUserId === candidate.user_id}
                      onChange={() => setSelectedUserId(candidate.user_id)}
                      className="text-green-500"
                    />
                    <div>
                      <div className="font-medium text-gray-800">
                        {candidate.display_name ?? '名前未設定'}
                      </div>
                      <div className="text-xs text-gray-400">大人メンバー</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* 理由 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                理由 (任意)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="譲渡の理由を入力してください（任意）"
                rows={3}
                maxLength={500}
                className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100 resize-none"
                disabled={submitting}
              />
              <p className="text-xs text-gray-400 mt-1">{reason.length}/500 文字</p>
            </div>

            <div className="bg-yellow-50 border border-yellow-100 rounded-2xl p-4">
              <p className="text-sm text-yellow-700">
                ※ 譲渡後、あなたの役割は「大人」に変わります。
                相手が承諾するまで現在の代表者のままです。
              </p>
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
              disabled={submitting || !selectedUserId}
              className="w-full rounded-full bg-green-500 py-4 text-white font-bold text-base hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? '提案中…' : '譲渡を提案'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
