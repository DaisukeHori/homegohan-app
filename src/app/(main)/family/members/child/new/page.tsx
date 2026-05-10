'use client';

// src/app/(main)/family/members/child/new/page.tsx
// (設計書 03-ui-spec.md §8, 02-flow-spec.md §8)
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

const GENDER_OPTIONS = [
  { value: '', label: '未設定' },
  { value: 'male', label: '男の子' },
  { value: 'female', label: '女の子' },
  { value: 'other', label: 'その他' },
];

export default function FamilyChildNewPage() {
  const router = useRouter();
  const supabase = createClient();

  const [familyId, setFamilyId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    };

    init();
  }, [supabase, router]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!displayName.trim()) {
      setError('名前を入力してください');
      return;
    }
    if (!familyId) {
      setError('家族グループが見つかりません');
      return;
    }

    const childProfile: Record<string, unknown> = {};
    if (birthDate) childProfile.birth_date = birthDate;
    if (gender) childProfile.gender = gender;

    setLoading(true);
    try {
      const res = await fetch('/api/family/members/child', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          family_id: familyId,
          display_name: displayName.trim(),
          child_profile: childProfile,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        if (json.error?.code === 'MEMBER_LIMIT_EXCEEDED') {
          setError('メンバー数の上限に達しています');
        } else {
          setError(json.error?.message ?? '子供の追加に失敗しました');
        }
        return;
      }

      router.push('/family/members');
    } catch (err) {
      setError('通信エラーが発生しました');
      console.error('[family/members/child/new] error:', err);
    } finally {
      setLoading(false);
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
        <h1 className="text-2xl font-bold text-gray-900">子供を追加</h1>
        <p className="text-xs text-gray-400 mt-1">アカウントを作成せずに家族に追加できます</p>
      </div>

      <div className="p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* 名前 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              名前 (家族での呼称)
              <span className="text-red-500 ml-1">*</span>
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="例: 太郎"
              maxLength={60}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
              disabled={loading}
            />
            <p className="text-xs text-gray-400 mt-1">{displayName.length}/60 文字</p>
          </div>

          {/* 生年月日 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              生年月日 (任意)
            </label>
            <input
              type="date"
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
              disabled={loading}
            />
          </div>

          {/* 性別 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              性別 (任意)
            </label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
              disabled={loading}
            >
              {GENDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* 注意書き */}
          <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4">
            <p className="text-sm text-blue-700">
              ※ 子供本人のアカウントは作成しません。
              親が代わりに食事記録を管理します。
              後でアカウントを発行することもできます。
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
            disabled={loading || !displayName.trim()}
            className="w-full rounded-full bg-green-500 py-4 text-white font-bold text-base hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '追加中…' : '追加する'}
          </button>
        </form>
      </div>
    </div>
  );
}
