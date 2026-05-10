'use client';

// src/app/(main)/family/members/page.tsx
// (設計書 03-ui-spec.md §3.2, 02-flow-spec.md §11)
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface FamilyMember {
  id: string;
  role: 'representative' | 'adult' | 'child';
  display_name: string | null;
  user_id: string | null;
  child_profile: Record<string, unknown> | null;
  status: string;
}

interface FamilyGroup {
  id: string;
  name: string;
  member_limit: number;
}

export default function FamilyMembersPage() {
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [familyGroup, setFamilyGroup] = useState<FamilyGroup | null>(null);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentRole, setCurrentRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

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

      const { data: group, error: groupError } = await supabase
        .from('family_groups')
        .select('id, name, member_limit')
        .eq('id', profile.family_id)
        .single();

      if (groupError || !group) {
        setError('家族グループの取得に失敗しました');
        setLoading(false);
        return;
      }

      setFamilyGroup(group as FamilyGroup);

      const { data: membersData } = await supabase
        .from('family_members')
        .select('id, role, display_name, user_id, child_profile, status')
        .eq('family_id', profile.family_id)
        .eq('status', 'active');

      const membersList = (membersData ?? []) as FamilyMember[];
      setMembers(membersList);

      const myMember = membersList.find((m) => m.user_id === user.id);
      setCurrentRole(myMember?.role ?? null);

      setLoading(false);
    };

    init();
  }, [supabase, router]);

  const isOwnerOrAdmin = currentRole === 'representative' || currentRole === 'adult';

  const handleRemove = async (member: FamilyMember) => {
    if (!familyGroup) return;
    if (!window.confirm(`${member.display_name ?? 'このメンバー'} を家族グループから外しますか？`)) return;

    setActionLoading(member.id);
    try {
      const res = await fetch(`/api/family/members/${member.id}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ family_id: familyGroup.id }),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error?.message ?? '除名に失敗しました');
        return;
      }
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
    } catch {
      alert('通信エラーが発生しました');
    } finally {
      setActionLoading(null);
    }
  };

  const handleLeave = async () => {
    if (!window.confirm('家族グループから脱退しますか？')) return;

    setActionLoading('leave');
    try {
      const res = await fetch('/api/family/leave', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error?.message ?? '脱退に失敗しました');
        return;
      }
      router.replace('/family/setup');
    } catch {
      alert('通信エラーが発生しました');
    } finally {
      setActionLoading(null);
    }
  };

  const roleLabel = (role: string) => {
    if (role === 'representative') return '代表';
    if (role === 'adult') return '大人';
    return '子供';
  };

  const roleIcon = (role: string, childProfile: Record<string, unknown> | null) => {
    if (role === 'representative') return '👑';
    if (role === 'adult') return '👤';
    if (childProfile) return '🧒';
    return '🧒';
  };

  const adults = members.filter((m) => m.role === 'representative' || m.role === 'adult');
  const children = members.filter((m) => m.role === 'child');

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
        <button
          onClick={() => router.back()}
          className="text-sm text-gray-400 mb-2 flex items-center gap-1"
        >
          ← 戻る
        </button>
        <h1 className="text-2xl font-bold text-gray-900">
          {familyGroup?.name ?? '家族グループ'}
        </h1>
        <p className="text-xs text-gray-400 mt-1">
          {members.length}/{familyGroup?.member_limit ?? '-'} 人
        </p>
      </div>

      <div className="p-6 space-y-6">
        {/* 大人メンバー */}
        {adults.length > 0 && (
          <div>
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">
              大人
            </h2>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              {adults.map((member, idx) => (
                <div
                  key={member.id}
                  className={`flex items-center gap-3 p-4 ${
                    idx < adults.length - 1 ? 'border-b border-gray-50' : ''
                  }`}
                >
                  <span className="text-2xl">{roleIcon(member.role, member.child_profile)}</span>
                  <div className="flex-1">
                    <div className="font-medium text-gray-800">
                      {member.display_name ?? '名前未設定'}
                    </div>
                    <div className="text-xs text-gray-400">{roleLabel(member.role)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => router.push(`/family/members/${member.id}`)}
                      className="text-xs text-gray-400 px-3 py-1.5 rounded-full bg-gray-50 hover:bg-gray-100 transition-colors"
                    >
                      詳細
                    </button>
                    {isOwnerOrAdmin && member.role !== 'representative' && member.user_id !== currentUserId && (
                      <button
                        onClick={() => handleRemove(member)}
                        disabled={actionLoading === member.id}
                        className="text-xs text-red-400 px-3 py-1.5 rounded-full bg-red-50 hover:bg-red-100 transition-colors disabled:opacity-50"
                      >
                        除名
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 子供メンバー */}
        {children.length > 0 && (
          <div>
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">
              子供
            </h2>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              {children.map((member, idx) => (
                <div
                  key={member.id}
                  className={`flex items-center gap-3 p-4 ${
                    idx < children.length - 1 ? 'border-b border-gray-50' : ''
                  }`}
                >
                  <span className="text-2xl">{roleIcon(member.role, member.child_profile)}</span>
                  <div className="flex-1">
                    <div className="font-medium text-gray-800">
                      {member.display_name ?? '名前未設定'}
                    </div>
                    <div className="text-xs text-gray-400">
                      {member.user_id ? '子供 (アカウント有)' : '子供 (アカウント無)'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => router.push(`/family/members/${member.id}`)}
                      className="text-xs text-gray-400 px-3 py-1.5 rounded-full bg-gray-50 hover:bg-gray-100 transition-colors"
                    >
                      詳細
                    </button>
                    {isOwnerOrAdmin && !member.user_id && (
                      <button
                        onClick={() => router.push(`/family/members/${member.id}/promote`)}
                        className="text-xs text-blue-400 px-3 py-1.5 rounded-full bg-blue-50 hover:bg-blue-100 transition-colors"
                      >
                        促進
                      </button>
                    )}
                    {isOwnerOrAdmin && (
                      <button
                        onClick={() => handleRemove(member)}
                        disabled={actionLoading === member.id}
                        className="text-xs text-red-400 px-3 py-1.5 rounded-full bg-red-50 hover:bg-red-100 transition-colors disabled:opacity-50"
                      >
                        除名
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* アクションボタン */}
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

          {isOwnerOrAdmin && (
            <button
              onClick={() => router.push('/family/members/child/new')}
              className="w-full rounded-2xl bg-white border border-gray-100 shadow-sm p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
            >
              <span className="text-2xl">🧒</span>
              <div>
                <div className="font-medium text-gray-800">子供を追加</div>
                <div className="text-xs text-gray-400">アカウント不要で追加できます</div>
              </div>
            </button>
          )}

          {currentRole === 'representative' && (
            <button
              onClick={() => router.push('/family/representative-transfer')}
              className="w-full rounded-2xl bg-white border border-gray-100 shadow-sm p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
            >
              <span className="text-2xl">🔄</span>
              <div>
                <div className="font-medium text-gray-800">代表者を譲渡</div>
                <div className="text-xs text-gray-400">他のメンバーに代表者を引き継ぐ</div>
              </div>
            </button>
          )}

          {currentRole !== 'representative' && (
            <button
              onClick={handleLeave}
              disabled={actionLoading === 'leave'}
              className="w-full rounded-2xl bg-white border border-red-100 shadow-sm p-4 flex items-center gap-3 hover:bg-red-50 transition-colors text-left disabled:opacity-50"
            >
              <span className="text-2xl">🚪</span>
              <div>
                <div className="font-medium text-red-600">家族グループから脱退</div>
                <div className="text-xs text-gray-400">この操作は取り消せません</div>
              </div>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
