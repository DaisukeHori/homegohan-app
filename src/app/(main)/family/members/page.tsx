'use client';

// src/app/(main)/family/members/page.tsx
// (設計書 03-ui-spec.md §3.2, 02-flow-spec.md §11)
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { loginPathWithNext, readSignedInUser } from '@/lib/auth/signed-in-user';
import { applyFamilyMemberNames, fetchFamilyMemberNamesResult } from '@/lib/membership/family-member-names';
import { familyRoleLabel } from '@/lib/membership/role-labels';
import { membershipErrorMessageOfBody } from '@/lib/errors/membership-errors';
import { readOwnMembershipAfterNetworkFailure, withMembershipStateNote } from '@/lib/membership/leave-state';
import { useAiConsultationReceiver, type AiConsultationRead } from '@/hooks/useAiConsultationReceiver';

/**
 * 家族のメンバーを読み込めなかったときの文。家族に入っていない (家族の作成の画面へ移す) ・空の一覧と見分けるために出す
 * (#2064。家族の代表者の譲渡の画面の CANDIDATES_LOAD_ERROR と同じ扱い)。失敗の理由 (英語の内部の文) は画面に出さない
 */
const FAMILY_MEMBERS_LOAD_ERROR = '家族のメンバーを読み込めませんでした。しばらくしてから、もう一度お試しください。';

/** 家族グループの行が無い (または RLS で見えない) ときの文 (これまでどおり) */
const FAMILY_GROUP_NOT_FOUND_MESSAGE = '家族グループの取得に失敗しました';

/** この画面のパス (ログインのあとに戻る先) */
const FAMILY_MEMBERS_PATH = '/family/members';

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

/** 読み込みの置き場所の鍵 (群・一覧と名前・自分の id と役割・失敗の表示・別の画面への移動を 1 つの鍵で置く。#2206 G1 §9 #4) */
const KEY_MEMBERS = 'members';

export default function FamilyMembersPage() {
  const router = useRouter();
  const supabase = createClient();

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
  /**
   * 別の画面へ移っているか (#2206 G1 §6.8)。移る読み取りが読み込み中の表示を出していたときだけ立てる (移るまで読み込み中の表示のまま。
   * 取り直し (読み込み中の表示を出していない) が移すときは、今の画面のまま移る)
   */
  const [redirecting, setRedirecting] = useState(false);
  /**
   * receiver.isLoading の写し。loadMembers は receiver より先に宣言する (receiver の引数) ので ref で引く。
   * place の apply の中で呼ぶと、その鍵を下ろす前の値を返す (hook は apply が戻ってから印を下ろす)
   */
  const isLoadingRef = useRef<(key: string) => boolean>(() => false);
  // 除名か脱退のどちらかの書き込み (除名の通信エラーのあとの読み直しまで) の応答を待っているか (#2064)。二重押しの守り。
  // 除名の通信エラーのあとは一覧を丸ごと読み直すので、別のメンバーの除名を重ねると、先に送った読み直しの応答が後に届いたとき、
  // その古い一覧で表示が上書きされる (組織のメンバーの画面の #2050 と同じ型)。待つあいだはすべての除名と脱退のボタンを止め、押されても送らない。
  // ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り。AI 相談の成功の取り直しとの重なりは、書き込みの窓
  // (receiver.beginWrite) が受け持つ (窓の間は取り直さず、終わったら 1 回取り直す。#2206 G1)
  const busyRef = useRef(false);
  const isWriting = actionLoading !== null;

  // 家族グループとメンバーの一覧を読む。画面を開いたとき・「再試行」・除名の通信エラーのあと・AI 相談の成功 (#2195 V1) のあとに呼ぶ。
  // 応答は全部を読んでから最後に 1 回だけ置く (自分の id も最後の apply の中。順序・番兵の判断は read.place の中。#2206 G1)。
  // read.mode が 'refetch' (AI 相談の成功の取り直し。#2201 U1) なら、読み込めなかったとき (エラー・通信の失敗) は何も置かずに今の表示を残し、
  // 名前の API を読めなかったときも何も置かない (出ている群・一覧・名前を残す。「名前未設定」に落とさない)
  const loadMembers = useCallback(async (read: AiConsultationRead): Promise<void> => {
    /** 読み込めなかった: 開いたとき・「再試行」・除名の通信エラーのあとは「読み込めませんでした」を出し、取り直しは今の表示を残す */
    const loadFailed = () => {
      if (read.mode === 'mount') read.place(KEY_MEMBERS, () => setLoadError(FAMILY_MEMBERS_LOAD_ERROR));
    };
    try {
      // getUser は通信の失敗を投げずに { user: null, error } で返す。ログインの画面へ移すのはログインしていないときだけにし、
      // 確かめられなかったときは読み込みの失敗と「再試行」を出す (#2093 W4。以前は通信が切れているだけでもログインの画面へ移していた)。
      // ログインのあとにこの画面へ戻れるよう next を付ける
      const signedIn = await readSignedInUser(supabase);
      if (signedIn.kind === 'load-failed') return loadFailed();
      if (signedIn.kind === 'signed-out') {
        // 移動も置く (古い応答では移らない。#2206 G1)
        read.place(KEY_MEMBERS, () => {
          if (isLoadingRef.current(KEY_MEMBERS)) setRedirecting(true);
          router.push(loginPathWithNext(FAMILY_MEMBERS_PATH));
        });
        return;
      }
      const { user } = signedIn;
      // 自分の id はここでは置かない (最後の apply でまとめて置く。途中で置くと、その時点で KEY_MEMBERS の読み込み中の印が下りて
      // 移るときに redirecting が立たず、置いた世代も進む。#2206 G1 §6.2)

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('family_id')
        .eq('id', user.id)
        .single();

      if (profileError) {
        // 自分のプロフィールを読めなかった (家族に入っていないのとは別。家族の作成の画面へ送らない)
        return loadFailed();
      }
      if (!profile?.family_id) {
        read.place(KEY_MEMBERS, () => {
          if (isLoadingRef.current(KEY_MEMBERS)) setRedirecting(true);
          router.replace('/family/setup');
        });
        return;
      }

      const { data: group, error: groupError } = await supabase
        .from('family_groups')
        .select('id, name, member_limit')
        .eq('id', profile.family_id)
        .single();

      if (isLoadFailure(groupError)) return loadFailed();
      if (!group) {
        // 行が無い (PGRST116) か、RLS で見えない (これまでどおり)
        read.place(KEY_MEMBERS, () => {
          setCurrentUserId(user.id);
          setError(FAMILY_GROUP_NOT_FOUND_MESSAGE);
          setLoadError(null);
        });
        return;
      }

      const { data: membersData, error: membersError } = await supabase
        .from('family_members')
        .select('id, role, display_name, user_id, child_profile, status')
        .eq('family_id', profile.family_id)
        .eq('status', 'active');

      if (membersError) {
        // 読み込めなかった (メンバーがいないのとは別。空の一覧と見せない)
        return loadFailed();
      }

      // 画面に出す名前 (display_name が無ければ本人のプロフィールの今の名前) は API で決める (#1584)
      const namesResult = await fetchFamilyMemberNamesResult();
      // 取り直しで名前の API を読めなかった: 何も置かない (出ている群・一覧・名前を残す。「名前未設定」に落とさない #2201 U1。
      // 読めた一覧に今の名前を当てて同じ鍵に置くと、先に始めた開いたときの名前つきの応答が古いとして捨てられる。#2206 G1 §6.2)
      if (!namesResult.ok && read.mode === 'refetch') return;
      const rows = (membersData ?? []) as FamilyMember[];
      const myMember = rows.find((m) => m.user_id === user.id);

      // 全部読めてから出す
      read.place(KEY_MEMBERS, () => {
        setCurrentUserId(user.id);
        setFamilyGroup(group as FamilyGroup);
        setMembers(applyFamilyMemberNames(rows, namesResult.ok ? namesResult.names : new Map()));
        setCurrentRole(myMember?.role ?? null);
        setError(null);
        setLoadError(null);
      });
    } catch (loadFailure) {
      // 問い合わせが例外を投げた (以前は try / catch が無く、読み込み中の表示のまま止まり、未処理の reject になっていた)
      console.error('[family/members] load error:', loadFailure);
      loadFailed();
    }
  }, [supabase, router]);

  // AI 相談の提案の実行が成功したら (#2195 V1)、読み込み中の表示を出さずに家族グループとメンバーの一覧を読み直す。
  // 一覧に出す名前は、display_name の無いメンバー (自分を含む) に名前の API がプロフィールの今の名前 (user_profiles.nickname) を
  // 当てたもので、AI 相談の update_profile_preferences は自分の nickname を書く。
  // 家族を抜けていた・ログアウトしていたときの扱いは、除名の通信エラーのあとの読み直しと同じ (loadMembers が決める)。
  // 読み直しの失敗では今の表示を残す (#2201 U1)。
  // 書き込み (除名・脱退) の窓の間は取り直さず、終わったあとに 1 回取り直す。取り直しを始めたあとに書き込みが始まったら、
  // その取り直しの応答は置かずにもう 1 回取り直す (#2206 G1。窓は receiver.beginWrite)。
  // 開いたとき・「再試行」の読み込み中に来た成功は、その読み込みの役を引き継がない (開いたときの読み込みが自分の応答を置き、
  // 自分の読み込み中の表示を下ろす。#2206 G1)。最初の描画から読み込み中の表示を出す (initialLoadingKeys)
  const receiver = useAiConsultationReceiver(loadMembers, { initialLoadingKeys: [KEY_MEMBERS] });
  isLoadingRef.current = receiver.isLoading;
  // 移っている間も読み込み中の表示 (これまでどおり)
  const loading = receiver.isLoading(KEY_MEMBERS) || redirecting;

  const loadPage = useCallback(
    () => receiver.read({ loadingKeys: [KEY_MEMBERS] }, loadMembers),
    [receiver, loadMembers],
  );

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  // 読み込みをやり直す (読み込めなかったときの「再試行」)。書き込みの応答を待つあいだは送らない
  const retryLoad = () => {
    if (busyRef.current) return;
    void loadPage();
  };

  const isOwnerOrAdmin = currentRole === 'representative' || currentRole === 'adult';

  const handleRemove = async (member: FamilyMember) => {
    if (!familyGroup) return;
    if (busyRef.current) return;
    if (!window.confirm(`${member.display_name ?? 'このメンバー'} を家族グループから外しますか？`)) return;

    busyRef.current = true;
    setActionLoading(member.id);
    // 書き込みの窓 (除名の通信エラーのあとの読み直しまで)。窓の間は AI 相談の成功の取り直しを止める (#2206 G1)
    const endWrite = receiver.beginWrite();
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
      // 読み直しの応答を待つあいだも書き込みの待ち (busyRef / actionLoading) を戻さない (上の busyRef の理由と同じ)
      await receiver.read({}, loadMembers);
    } finally {
      busyRef.current = false;
      setActionLoading(null);
      endWrite();
    }
  };

  const handleLeave = async () => {
    if (busyRef.current) return;
    if (!window.confirm('家族グループから脱退しますか？')) return;

    busyRef.current = true;
    setActionLoading('leave');
    // 書き込みの窓 (通信エラーのあとの確かめまで)。窓の間は AI 相談の成功の取り直しを止める (#2206 G1)
    const endWrite = receiver.beginWrite();
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
      busyRef.current = false;
      setActionLoading(null);
      endWrite();
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
