"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

interface Member {
  id: string;
  nickname: string | null;
  org_role: string;
  joined_org_at: string | null;
}

interface CurrentUser {
  id: string;
  org_role: string;
}

export default function MembersPage() {
  const router = useRouter();
  const supabase = createClient();
  const [members, setMembers] = useState<Member[]>([]);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('org_role, organization_id')
        .eq('id', user.id)
        .single();

      if (!profile?.organization_id) {
        setLoading(false);
        return;
      }

      setCurrentUser({ id: user.id, org_role: profile.org_role ?? 'member' });

      const { data: membersData } = await supabase
        .from('user_profiles')
        .select('id, nickname, org_role, joined_org_at')
        .eq('organization_id', profile.organization_id)
        .order('joined_org_at', { ascending: true });

      setMembers(membersData ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleRemove = async (memberId: string, memberNickname: string | null) => {
    if (!confirm(`「${memberNickname ?? 'このメンバー'}」を組織から除名しますか？`)) return;
    setRemovingId(memberId);
    try {
      const res = await fetch(`/api/org/members/${memberId}/remove`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`除名失敗: ${err.error?.message ?? '不明なエラー'}`);
        return;
      }
      await fetchData();
    } finally {
      setRemovingId(null);
    }
  };

  const handleLeave = async () => {
    if (!confirm('組織から脱退しますか？この操作は元に戻せません。')) return;
    setLeaving(true);
    try {
      const res = await fetch('/api/org/leave', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        alert(`脱退失敗: ${err.error?.message ?? '不明なエラー'}`);
        return;
      }
      router.push('/home');
    } finally {
      setLeaving(false);
    }
  };

  const roleLabel = (role: string) => {
    switch (role) {
      case 'owner': return 'オーナー';
      case 'admin': return '管理者';
      default: return 'メンバー';
    }
  };

  const canRemove = (targetRole: string, targetId: string): boolean => {
    if (!currentUser) return false;
    if (targetId === currentUser.id) return false;
    if (targetRole === 'owner') return false;
    if (currentUser.org_role === 'owner') return true;
    if (currentUser.org_role === 'admin' && targetRole === 'member') return true;
    return false;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">組織メンバー ({members.length} 名)</h1>
          <p className="text-gray-500 text-sm">メンバーの管理・除名・脱退</p>
        </div>
        <div className="flex gap-3">
          {currentUser?.org_role === 'owner' && (
            <Link
              href="/org/settings/owner-transfer"
              className="px-4 py-2 rounded-xl border border-amber-300 text-amber-700 font-medium hover:bg-amber-50 transition-colors text-sm"
            >
              オーナーを譲渡
            </Link>
          )}
          {currentUser && currentUser.org_role !== 'owner' && (
            <button
              onClick={handleLeave}
              disabled={leaving}
              className="px-4 py-2 rounded-xl border border-red-300 text-red-600 font-medium hover:bg-red-50 transition-colors text-sm disabled:opacity-50"
            >
              {leaving ? '処理中...' : '組織を脱退'}
            </button>
          )}
          <Link
            href="/org/invites"
            className="px-4 py-2 rounded-xl bg-blue-600 text-white font-medium hover:bg-blue-700 transition-colors text-sm shadow-sm shadow-blue-200"
          >
            + メンバーを招待
          </Link>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">ユーザー</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">役割</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">参加日</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {members.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-8 text-center text-gray-400">メンバーがいません</td>
              </tr>
            ) : (
              members.map((member) => (
                <tr key={member.id} className="hover:bg-gray-50 transition-colors">
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-100 to-blue-50 flex items-center justify-center font-bold text-blue-500 text-xs">
                        {(member.nickname ?? 'U')[0].toUpperCase()}
                      </div>
                      <span className="font-medium text-gray-900">
                        {member.nickname ?? '(名前なし)'}
                        {member.id === currentUser?.id && (
                          <span className="ml-2 text-xs text-gray-400">(あなた)</span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                      member.org_role === 'owner'
                        ? 'bg-amber-100 text-amber-700'
                        : member.org_role === 'admin'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {roleLabel(member.org_role)}
                    </span>
                  </td>
                  <td className="p-4 text-sm text-gray-500 font-mono">
                    {member.joined_org_at
                      ? new Date(member.joined_org_at).toLocaleDateString('ja-JP')
                      : '-'}
                  </td>
                  <td className="p-4 text-right">
                    {canRemove(member.org_role, member.id) && (
                      <button
                        onClick={() => handleRemove(member.id, member.nickname)}
                        disabled={removingId === member.id}
                        className="px-3 py-1 rounded-lg text-xs font-medium text-red-600 border border-red-200 hover:bg-red-50 transition-colors disabled:opacity-50"
                      >
                        {removingId === member.id ? '処理中...' : '除名'}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
