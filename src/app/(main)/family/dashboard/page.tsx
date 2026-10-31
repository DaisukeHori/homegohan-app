'use client';

// (設計書 03-ui-spec.md §3.2, 12.2)
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { loginPathWithNext, readSignedInUser } from '@/lib/auth/signed-in-user';
import { applyFamilyMemberNames, fetchFamilyMemberNames } from '@/lib/membership/family-member-names';
import { familyRoleLabel } from '@/lib/membership/role-labels';

/**
 * 自分のプロフィールを読み込めなかった・問い合わせが例外を投げたときの文 (#2073 S3)。家族に入っていない (家族の作成の画面へ移す) と
 * 見分けるために出す (家族のメンバーの画面の FAMILY_MEMBERS_LOAD_ERROR と同じ扱い)。失敗の理由 (英語の内部の文) は画面に出さない
 */
const FAMILY_DASHBOARD_LOAD_ERROR = '家族の情報を読み込めませんでした。しばらくしてから、もう一度お試しください。';

/** この画面のパス (ログインのあとに戻る先) */
const FAMILY_DASHBOARD_PATH = '/family/dashboard';

/** 家族グループの行が無い (または RLS で見えない) ときの文 (これまでどおり) */
const FAMILY_GROUP_NOT_FOUND_MESSAGE = '家族グループの取得に失敗しました';

/**
 * .single() で行が 0 件 (または RLS で見えない) ときの PostgREST の失敗のコード。
 * 行が無いのは「読み込めなかった」ではないので、これだけは読み込みの失敗と分ける (家族のメンバーの画面と同じ)
 */
const POSTGREST_NO_ROWS_CODE = 'PGRST116';

/** 問い合わせの失敗が「行が無い」ではない (= 読み込めなかった) か */
function isLoadFailure(error: { code?: string } | null): boolean {
  return error !== null && error.code !== POSTGREST_NO_ROWS_CODE;
}

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
  // 読み込めなかったときの文。あるあいだは画面の代わりにこの文と「再試行」を出す (#2073 S3。以前は自分のプロフィールを読めないと
  // 家族に入っていないとして家族の作成の画面へ移し、try / catch が無く、問い合わせが例外を投げると読み込み中の表示のまま止まり、未処理の reject になっていた)
  const [loadError, setLoadError] = useState<string | null>(null);

  // 家族グループとメンバーを読む。画面を開いたときと「再試行」で呼ぶ
  const loadDashboard = useCallback(async () => {
    setLoading(true);
    // 別の画面へ移るときは、移るまで読み込み中の表示のままにする (これまでどおり)
    let redirecting = false;
    try {
      // getUser は通信の失敗を投げずに { user: null, error } で返す。ログインの画面へ移すのはログインしていないときだけにし、
      // 確かめられなかったときは読み込みの失敗と「再試行」を出す (#2093 W4。以前は通信が切れているだけでもログインの画面へ移していた)。
      // ログインのあとにこの画面へ戻れるよう next を付ける
      const signedIn = await readSignedInUser(supabase);
      if (signedIn.kind === 'load-failed') {
        setLoadError(FAMILY_DASHBOARD_LOAD_ERROR);
        return;
      }
      if (signedIn.kind === 'signed-out') {
        redirecting = true;
        router.push(loginPathWithNext(FAMILY_DASHBOARD_PATH));
        return;
      }
      const { user } = signedIn;

      // user_profiles から family_id を取得
      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('family_id')
        .eq('id', user.id)
        .single();

      if (profileError) {
        // 自分のプロフィールを読めなかった (家族に入っていないのとは別。家族の作成の画面へ送らない)
        setLoadError(FAMILY_DASHBOARD_LOAD_ERROR);
        return;
      }
      if (!profile?.family_id) {
        // 家族グループ未参加 → setup へ
        redirecting = true;
        router.replace('/family/setup');
        return;
      }

      // family_groups を取得
      const { data: group, error: groupError } = await supabase
        .from('family_groups')
        .select('id, name, member_limit, status')
        .eq('id', profile.family_id)
        .single();

      if (isLoadFailure(groupError)) {
        // 読み込めなかった (行が無いのとは別。「再試行」を出す。#2080 U3)
        setLoadError(FAMILY_DASHBOARD_LOAD_ERROR);
        return;
      }
      if (!group) {
        // 行が無い (PGRST116) か、RLS で見えない (これまでどおり)
        setError(FAMILY_GROUP_NOT_FOUND_MESSAGE);
        setLoadError(null);
        return;
      }

      // family_members を取得
      const { data: membersData, error: membersError } = await supabase
        .from('family_members')
        .select('id, role, display_name, user_id')
        .eq('family_id', profile.family_id)
        .eq('status', 'active');

      if (membersError) {
        // 読み込めなかった (メンバーがいないのとは別。家族グループの名前だけの画面・空の一覧と見せず、「再試行」を出す。#2080 U3)
        setLoadError(FAMILY_DASHBOARD_LOAD_ERROR);
        return;
      }

      // 画面に出す名前 (display_name が無ければ本人のプロフィールの今の名前) は API で決める (#1584)
      const names = await fetchFamilyMemberNames();
      // 全部読めてから出す
      setFamilyGroup(group as FamilyGroup);
      setMembers(applyFamilyMemberNames((membersData ?? []) as FamilyMember[], names));
      setError(null);
      setLoadError(null);
    } catch (loadFailure) {
      console.error('[family/dashboard] load error:', loadFailure);
      setLoadError(FAMILY_DASHBOARD_LOAD_ERROR);
    } finally {
      if (!redirecting) setLoading(false);
    }
  }, [supabase, router]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

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

  if (loadError) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div
          role="alert"
          data-testid="family-dashboard-load-error"
          className="w-full max-w-md rounded-2xl bg-red-50 border border-red-200 p-6 text-center"
        >
          <p className="text-sm text-red-600">{loadError}</p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void loadDashboard()}
              className="px-4 py-2 rounded-full bg-white border border-red-300 text-red-600 text-sm"
            >
              再試行
            </button>
          </div>
        </div>
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
                    <div className="text-xs text-gray-400">{familyRoleLabel(member.role)}</div>
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
