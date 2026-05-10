'use client';

// (設計書 03-ui-spec.md §3.2, 12.2)
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface FamilyMember {
  id: string;
  role: 'representative' | 'adult' | 'child';
  display_name: string | null;
  user_id: string | null;
}

interface FamilyGroup {
  id: string;
  name: string;
  member_limit: number;
  status: string;
}

export default function FamilyDashboardPage() {
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [familyGroup, setFamilyGroup] = useState<FamilyGroup | null>(null);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return;
      }

      // user_profiles から family_id を取得
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('family_id')
        .eq('id', user.id)
        .single();

      if (!profile?.family_id) {
        // 家族グループ未参加 → setup へ
        router.replace('/family/setup');
        return;
      }

      // family_groups を取得
      const { data: group, error: groupError } = await supabase
        .from('family_groups')
        .select('id, name, member_limit, status')
        .eq('id', profile.family_id)
        .single();

      if (groupError || !group) {
        setError('家族グループの取得に失敗しました');
        setLoading(false);
        return;
      }

      setFamilyGroup(group as FamilyGroup);

      // family_members を取得
      const { data: membersData, error: membersError } = await supabase
        .from('family_members')
        .select('id, role, display_name, user_id')
        .eq('family_id', profile.family_id)
        .eq('status', 'active');

      if (membersError) {
        setError('メンバー情報の取得に失敗しました');
      } else {
        setMembers((membersData ?? []) as FamilyMember[]);
      }

      setLoading(false);
    };

    init();
  }, [supabase, router]);

  const roleLabel = (role: string) => {
    if (role === 'representative') return '代表';
    if (role === 'adult') return '大人';
    return '子供';
  };

  const roleIcon = (role: string) => {
    if (role === 'representative') return '👑';
    if (role === 'adult') return '👤';
    return '🧒';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">読み込み中…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div className="text-4xl">⚠️</div>
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

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* ヘッダー */}
      <div className="bg-white p-6 pb-4 border-b border-gray-100 sticky top-0 z-20">
        <h1 className="text-2xl font-bold text-gray-900">
          {familyGroup?.name ?? '家族グループ'}
        </h1>
        <p className="text-xs text-gray-400 mt-1">
          {members.length}/{familyGroup?.member_limit ?? '-'} 人
        </p>
      </div>

      <div className="p-6 space-y-6">
        {/* メンバー一覧 */}
        <div>
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">
            メンバー
          </h2>
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            {members.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">
                メンバーがいません
              </div>
            ) : (
              members.map((member, idx) => (
                <div
                  key={member.id}
                  className={`flex items-center gap-3 p-4 ${
                    idx < members.length - 1 ? 'border-b border-gray-50' : ''
                  }`}
                >
                  <span className="text-2xl">{roleIcon(member.role)}</span>
                  <div className="flex-1">
                    <div className="font-medium text-gray-800">
                      {member.display_name ?? '名前未設定'}
                    </div>
                    <div className="text-xs text-gray-400">{roleLabel(member.role)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* アクション */}
        <div className="space-y-3">
          <button
            onClick={() => router.push('/family/members/invite')}
            className="w-full rounded-2xl bg-white border border-gray-100 shadow-sm p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
          >
            <span className="text-2xl">✉️</span>
            <div>
              <div className="font-medium text-gray-800">大人メンバーを招待</div>
              <div className="text-xs text-gray-400">メールで招待リンクを送信</div>
            </div>
          </button>

          <button
            onClick={() => router.push('/settings/membership')}
            className="w-full rounded-2xl bg-white border border-gray-100 shadow-sm p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
          >
            <span className="text-2xl">⚙️</span>
            <div>
              <div className="font-medium text-gray-800">共有設定</div>
              <div className="text-xs text-gray-400">家族への情報共有を管理</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
