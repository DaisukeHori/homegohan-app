'use client';

// src/app/(main)/family/members/page.tsx
// (設計書 03-ui-spec.md §3.2, 02-flow-spec.md §11)
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { applyFamilyMemberNames, fetchFamilyMemberNames } from '@/lib/membership/family-member-names';
import { familyRoleLabel } from '@/lib/membership/role-labels';
import { membershipErrorMessageOfBody } from '@/lib/errors/membership-errors';
import { readOwnMembershipAfterNetworkFailure, withMembershipStateNote } from '@/lib/membership/leave-state';

/**
 * 家族のメンバーを読み込めなかったときの文。家族に入っていない (家族の作成の画面へ移す) ・空の一覧と見分けるために出す
 * (#2064。家族の代表者の譲渡の画面の CANDIDATES_LOAD_ERROR と同じ扱い)。失敗の理由 (英語の内部の文) は画面に出さない
 */
const FAMILY_MEMBERS_LOAD_ERROR = '家族のメンバーを読み込めませんでした。しばらくしてから、もう一度お試しください。';

/** 家族グループの行が無い (または RLS で見えない) ときの文 (これまでどおり) */
const FAMILY_GROUP_NOT_FOUND_MESSAGE = '家族グループの取得に失敗しました';

/** 除名・脱退の通信そのものが失敗した (fetch が reject した) ときの文 */
const NETWORK_FAILURE_MESSAGE = '通信エラーが発生しました';

/**
 * .single() で行が 0 件 (または RLS で見えない) ときの PostgREST の失敗のコード。
 * 行が無いのは「読み込めなかった」ではないので、これだけは読み込みの失敗と分ける
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
  // 家族グループの行が無いときの文。あるあいだは画面の代わりにこの文と「戻る」を出す (これまでどおり)
  const [error, setError] = useState<string | null>(null);
  // 読み込めなかったときの文。あるあいだは画面の代わりにこの文と「再試行」を出す (#2064。以前は自分のプロフィールを読めないと
  // 家族の作成の画面へ移し、一覧を読めないと空の一覧と見せ、問い合わせが例外を投げると読み込み中の表示のまま止まっていた)
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // 除名か脱退のどちらかの書き込み (除名の通信エラーのあとの読み直しまで) の応答を待っているか (#2064)。
  // 除名の通信エラーのあとは一覧を丸ごと読み直すので、別のメンバーの除名を重ねると、先に送った読み直しの応答が後に届いたとき、
  // その古い一覧で表示が上書きされる (組織のメンバーの画面の #2050 と同じ型)。待つあいだはすべての除名と脱退のボタンを止め、押されても送らない。
  // ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const writeInFlightRef = useRef(false);
  const isWriting = actionLoading !== null;

  // 家族グループとメンバーの一覧を読む。画面を開いたとき・「再試行」・除名の通信エラーのあとに呼ぶ。
  // 読み込み中の表示 (loading) は呼び出し側が決める (除名のあとの読み直しは、一覧の表示を残したまま読み直す)。
  // 戻り値は、別の画面へ移ったか (移るときは、移るまで読み込み中の表示のままにする。これまでどおり)
  const loadMembers = useCallback(async (): Promise<{ redirecting: boolean }> => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return { redirecting: true };
      }
      setCurrentUserId(user.id);

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('family_id')
        .eq('id', user.id)
        .single();

      if (profileError) {
        // 自分のプロフィールを読めなかった (家族に入っていないのとは別。家族の作成の画面へ送らない)
        setLoadError(FAMILY_MEMBERS_LOAD_ERROR);
        return { redirecting: false };
      }
      if (!profile?.family_id) {
        router.replace('/family/setup');
        return { redirecting: true };
      }

      const { data: group, error: groupError } = await supabase
        .from('family_groups')
        .select('id, name, member_limit')
        .eq('id', profile.family_id)
        .single();

      if (isLoadFailure(groupError)) {
        setLoadError(FAMILY_MEMBERS_LOAD_ERROR);
        return { redirecting: false };
      }
      if (!group) {
        // 行が無い (PGRST116) か、RLS で見えない (これまでどおり)
        setError(FAMILY_GROUP_NOT_FOUND_MESSAGE);
        setLoadError(null);
        return { redirecting: false };
      }

      const { data: membersData, error: membersError } = await supabase
        .from('family_members')
        .select('id, role, display_name, user_id, child_profile, status')
        .eq('family_id', profile.family_id)
        .eq('status', 'active');

      if (membersError) {
        // 読み込めなかった (メンバーがいないのとは別。空の一覧と見せない)
        setLoadError(FAMILY_MEMBERS_LOAD_ERROR);
        return { redirecting: false };
      }

      // 画面に出す名前 (display_name が無ければ本人のプロフィールの今の名前) は API で決める (#1584)
      const names = await fetchFamilyMemberNames();
      const membersList = applyFamilyMemberNames((membersData ?? []) as FamilyMember[], names);

      // 全部読めてから出す
      setFamilyGroup(group as FamilyGroup);
      setMembers(membersList);
      const myMember = membersList.find((m) => m.user_id === user.id);
      setCurrentRole(myMember?.role ?? null);
      setError(null);
      setLoadError(null);
      return { redirecting: false };
    } catch (loadFailure) {
      // 問い合わせが例外を投げた (以前は try / catch が無く、読み込み中の表示のまま止まり、未処理の reject になっていた)
      console.error('[family/members] load error:', loadFailure);
      setLoadError(FAMILY_MEMBERS_LOAD_ERROR);
      return { redirecting: false };
    }
  }, [supabase, router]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    const { redirecting } = await loadMembers();
    if (!redirecting) setLoading(false);
  }, [loadMembers]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  // 読み込みをやり直す (読み込めなかったときの「再試行」)。書き込みの応答を待つあいだは送らない
  const retryLoad = () => {
    if (writeInFlightRef.current) return;
    void loadPage();
  };

  const isOwnerOrAdmin = currentRole === 'representative' || currentRole === 'adult';

  const handleRemove = async (member: FamilyMember) => {
    if (!familyGroup) return;
    if (writeInFlightRef.current) return;
    if (!window.confirm(`${member.display_name ?? 'このメンバー'} を家族グループから外しますか？`)) return;

    writeInFlightRef.current = true;
    setActionLoading(member.id);
    try {
      const res = await fetch(`/api/family/members/${member.id}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ family_id: familyGroup.id }),
      });
      if (!res.ok) {
        // 理由は本文の code から引く (本文の message は操作ごとの固定の文で理由が読めない。#1576)
        const json: unknown = await res.json().catch(() => null);
        alert(`除名に失敗しました: ${membershipErrorMessageOfBody(json)}`);
        return;
      }
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
    } catch {
      alert(NETWORK_FAILURE_MESSAGE);
      // サーバーが除名を済ませてから応答が切れたこともあるので、一覧を読み直す (#2064。組織のメンバーの画面の除名と同じ形。
      // 読み直さないと、除名したメンバーが一覧に残り、もう一度「除名」を押すとエラーの文が出ていた)。
      // 読み直しが失敗したときは loadMembers が「読み込めませんでした」を出す。
      // 読み直しの応答を待つあいだも書き込みの待ち (writeInFlightRef / actionLoading) を戻さない (上の writeInFlightRef の理由と同じ)
      await loadMembers();
    } finally {
      writeInFlightRef.current = false;
      setActionLoading(null);
    }
  };

  const handleLeave = async () => {
    if (writeInFlightRef.current) return;
    if (!window.confirm('家族グループから脱退しますか？')) return;

    writeInFlightRef.current = true;
    setActionLoading('leave');
    try {
      const res = await fetch('/api/family/leave', { method: 'POST' });
      if (!res.ok) {
        // 理由は本文の code から引く (#1576)
        const json: unknown = await res.json().catch(() => null);
        alert(`脱退に失敗しました: ${membershipErrorMessageOfBody(json)}`);
        return;
      }
      router.replace('/family/setup');
    } catch {
      // サーバーが脱退を済ませてから応答が切れたこともあるので、自分のプロフィールを読み直して確かめる (#2064)。
      // 読み直しの応答を待つあいだも脱退のボタンを止めたままにする
      const membership = await readOwnMembershipAfterNetworkFailure(supabase, 'family');
      if (membership === 'left') {
        // 家族を抜けている: 成功のときと同じ遷移
        router.replace('/family/setup');
        return;
      }
      // 抜けていない: これまでどおり通信エラーの文。確かめられなかったときは「状態を確かめられませんでした」を添える
      alert(withMembershipStateNote(NETWORK_FAILURE_MESSAGE, membership));
    } finally {
      writeInFlightRef.current = false;
      setActionLoading(null);
    }
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

  if (loadError) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div
          role="alert"
          data-testid="family-members-load-error"
          className="w-full max-w-md rounded-2xl bg-red-50 border border-red-200 p-6 text-center"
        >
          <p className="text-sm text-red-600">{loadError}</p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={retryLoad}
              disabled={isWriting}
              className="px-4 py-2 rounded-full bg-white border border-red-300 text-red-600 text-sm disabled:opacity-50"
            >
              再試行
            </button>
            <button
              type="button"
              onClick={() => router.back()}
              className="px-4 py-2 rounded-full bg-gray-100 text-gray-600 text-sm"
            >
              戻る
            </button>
          </div>
        </div>
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
                    <div className="text-xs text-gray-400">{familyRoleLabel(member.role)}</div>
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
                        disabled={isWriting}
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
                        disabled={isWriting}
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
              disabled={isWriting}
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
