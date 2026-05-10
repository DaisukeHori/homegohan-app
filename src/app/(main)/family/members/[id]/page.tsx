'use client';

// src/app/(main)/family/members/[id]/page.tsx
// (設計書 03-ui-spec.md §3.2, 02-flow-spec.md §13)
import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface FamilyMember {
  id: string;
  role: 'representative' | 'adult' | 'child';
  display_name: string | null;
  user_id: string | null;
  child_profile: Record<string, unknown> | null;
  share_meals: boolean;
  share_health: boolean;
  share_menu: boolean;
  joined_at: string;
}

export default function FamilyMemberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: memberId } = use(params);
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [member, setMember] = useState<FamilyMember | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentRole, setCurrentRole] = useState<string | null>(null);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [shareMeals, setShareMeals] = useState(true);
  const [shareHealth, setShareHealth] = useState(false);
  const [shareMenu, setShareMenu] = useState(true);
  const [savingShare, setSavingShare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

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

      const { data: memberData, error: memberError } = await supabase
        .from('family_members')
        .select('id, role, display_name, user_id, child_profile, share_meals, share_health, share_menu, joined_at')
        .eq('id', memberId)
        .eq('family_id', profile.family_id)
        .single();

      if (memberError || !memberData) {
        setError('メンバー情報の取得に失敗しました');
        setLoading(false);
        return;
      }

      setMember(memberData as FamilyMember);
      setShareMeals(memberData.share_meals);
      setShareHealth(memberData.share_health);
      setShareMenu(memberData.share_menu);

      // 現在ユーザーのロールを取得
      const { data: myMember } = await supabase
        .from('family_members')
        .select('role')
        .eq('family_id', profile.family_id)
        .eq('user_id', user.id)
        .single();

      setCurrentRole(myMember?.role ?? null);
      setLoading(false);
    };

    init();
  }, [supabase, router, memberId]);

  const isSelf = member?.user_id === currentUserId;
  const isOwnerOrAdmin = currentRole === 'representative' || currentRole === 'adult';

  const handleShareUpdate = async (field: 'share_meals' | 'share_health' | 'share_menu', value: boolean) => {
    if (field === 'share_meals') setShareMeals(value);
    if (field === 'share_health') setShareHealth(value);
    if (field === 'share_menu') setShareMenu(value);

    setSavingShare(true);
    try {
      const res = await fetch('/api/family/members/me/share', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        // ロールバック
        if (field === 'share_meals') setShareMeals(!value);
        if (field === 'share_health') setShareHealth(!value);
        if (field === 'share_menu') setShareMenu(!value);
        alert('共有設定の更新に失敗しました');
      }
    } catch {
      if (field === 'share_meals') setShareMeals(!value);
      if (field === 'share_health') setShareHealth(!value);
      if (field === 'share_menu') setShareMenu(!value);
      alert('通信エラーが発生しました');
    } finally {
      setSavingShare(false);
    }
  };

  const handleRemove = async () => {
    if (!familyId || !member) return;
    if (!window.confirm(`${member.display_name ?? 'このメンバー'} を家族グループから外しますか？`)) return;

    setActionLoading(true);
    try {
      const res = await fetch(`/api/family/members/${member.id}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ family_id: familyId }),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error?.message ?? '除名に失敗しました');
        return;
      }
      router.replace('/family/members');
    } catch {
      alert('通信エラーが発生しました');
    } finally {
      setActionLoading(false);
    }
  };

  const roleLabel = (role: string) => {
    if (role === 'representative') return '代表';
    if (role === 'adult') return '大人';
    return '子供';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">読み込み中…</div>
      </div>
    );
  }

  if (error || !member) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-gray-600 text-sm text-center">{error ?? 'メンバーが見つかりません'}</p>
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
        <div className="flex items-center gap-3">
          <span className="text-3xl">
            {member.role === 'representative' ? '👑' : member.role === 'adult' ? '👤' : '🧒'}
          </span>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {member.display_name ?? '名前未設定'}
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">{roleLabel(member.role)}</p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* 基本情報 */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">
            基本情報
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">役割</span>
              <span className="text-gray-800 font-medium">{roleLabel(member.role)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">参加日</span>
              <span className="text-gray-800">
                {new Date(member.joined_at).toLocaleDateString('ja-JP')}
              </span>
            </div>
            {member.role === 'child' && (
              <div className="flex justify-between">
                <span className="text-gray-500">アカウント</span>
                <span className="text-gray-800">{member.user_id ? 'あり' : 'なし'}</span>
              </div>
            )}
          </div>
        </div>

        {/* 自分の場合: 共有設定 */}
        {isSelf && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">
              共有設定
            </h2>
            <p className="text-xs text-gray-400 mb-4">家族に公開する情報を選択できます</p>
            <div className="space-y-4">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-gray-800">食事記録</div>
                  <div className="text-xs text-gray-400">献立・食べたものを共有</div>
                </div>
                <button
                  role="switch"
                  aria-checked={shareMeals}
                  onClick={() => handleShareUpdate('share_meals', !shareMeals)}
                  disabled={savingShare}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                    shareMeals ? 'bg-green-500' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      shareMeals ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-gray-800">健康記録</div>
                  <div className="text-xs text-gray-400">体重・血圧などを共有</div>
                </div>
                <button
                  role="switch"
                  aria-checked={shareHealth}
                  onClick={() => handleShareUpdate('share_health', !shareHealth)}
                  disabled={savingShare}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                    shareHealth ? 'bg-green-500' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      shareHealth ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-gray-800">週間献立</div>
                  <div className="text-xs text-gray-400">週間献立プランを共有</div>
                </div>
                <button
                  role="switch"
                  aria-checked={shareMenu}
                  onClick={() => handleShareUpdate('share_menu', !shareMenu)}
                  disabled={savingShare}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                    shareMenu ? 'bg-green-500' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      shareMenu ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>
          </div>
        )}

        {/* 他人で権限あり: アクション */}
        {!isSelf && isOwnerOrAdmin && (
          <div className="space-y-3">
            {/* 子供 promote */}
            {member.role === 'child' && !member.user_id && (
              <button
                onClick={() => router.push(`/family/members/${member.id}/promote`)}
                className="w-full rounded-2xl bg-white border border-gray-100 shadow-sm p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
              >
                <span className="text-2xl">🎓</span>
                <div>
                  <div className="font-medium text-gray-800">アカウントを発行する</div>
                  <div className="text-xs text-gray-400">子供が自分でアカウントを使えるようになります</div>
                </div>
              </button>
            )}

            {/* 除名 (代表は除名不可) */}
            {member.role !== 'representative' && (
              <button
                onClick={handleRemove}
                disabled={actionLoading}
                className="w-full rounded-2xl bg-white border border-red-100 shadow-sm p-4 flex items-center gap-3 hover:bg-red-50 transition-colors text-left disabled:opacity-50"
              >
                <span className="text-2xl">🚫</span>
                <div>
                  <div className="font-medium text-red-600">家族から外す</div>
                  <div className="text-xs text-gray-400">この操作は取り消せません</div>
                </div>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
