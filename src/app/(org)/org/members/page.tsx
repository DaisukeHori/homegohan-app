"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { membershipErrorMessageOfBody } from "@/lib/errors/membership-errors";
import { normalizeProfileName } from "@/lib/profile-name";
import { readOwnMembershipAfterNetworkFailure, withMembershipStateNote } from "@/lib/membership/leave-state";
import { OrgMemberNamesResponseSchema, type OrgMemberName } from "@/schemas/membership/organization-member-name";

/**
 * メンバーの一覧を読み込めなかったときの文。空の一覧 (「メンバーがいません」) と見分けるために出す (#2050)。
 * 読み込みは自分のプロフィール (Supabase の問い合わせ) と一覧の API (GET /api/org/members) で、失敗の理由 (英語の内部の文) は画面に出さない
 */
const MEMBERS_LOAD_ERROR = 'メンバーの一覧を読み込めませんでした。しばらくしてから、もう一度お試しください。';

/**
 * 除名・脱退の通信そのものが失敗した (fetch が reject した: オフライン・接続が切れたなど) ときに「除名失敗: 」「脱退失敗: 」の後ろに出す理由 (#2059)。
 * 応答が届かないので、除名・脱退できたかどうかは応答からは分からない。黙っていると、できたかどうかが分からないまま終わるため。
 * 除名は、サーバーが済ませてから応答が切れたこともあるので、この文を出したあとに一覧を読み直して今の状態を見せる (#2064 R5)。
 * 脱退も同じ理由で、この文を出す前に自分のプロフィールを読み直し、組織を抜けていれば成功のときと同じくホームへ移る (#2064)
 */
const MEMBERSHIP_NETWORK_FAILURE_REASON = '通信エラーが発生しました。通信状況を確認して、もう一度お試しください';

/** 一覧の 1 人。API が返す 4 つの項目 (id・表示名・組織内の役割・参加した日) だけ (#2073 S4) */
type Member = OrgMemberName;

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
  // 除名か脱退のどちらかの書き込み (除名はそのあとの読み直しまで) の応答を待っているか (10/26 の整合ゲート 1026e。#2050)。
  // 除名のあとの読み直しは一覧を丸ごと差し替えるので、別のメンバーの除名を重ねると、先に送った読み直しの応答が後に届いたとき、
  // その古い一覧 (除名したメンバーがまだいる一覧) で表示が上書きされ、除名したメンバーの「除名」をもう一度押せてしまう
  // (#2053 のクーポン・機能パッケージと同じ型)。待つあいだはすべての除名と脱退のボタン (と一覧の「再試行」。#2059) を止め、押されても送らない。
  // ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const writeInFlightRef = useRef(false);
  const isWriting = removingId !== null || leaving;
  // 一覧を読み込めなかったときの文。あるあいだは一覧と「メンバーがいません」の代わりにこの文と「再試行」を出す (#2050)
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('org_role, organization_id')
        .eq('id', user.id)
        .single();

      if (profileError) {
        // 自分のプロフィールを読めなかった (組織に属していないのとは別。空の一覧と見せない)
        setLoadError(MEMBERS_LOAD_ERROR);
        return;
      }
      if (!profile?.organization_id) {
        setLoadError(null);
        setLoading(false);
        return;
      }

      setCurrentUser({ id: user.id, org_role: profile.org_role ?? 'member' });

      // ほかのメンバーの行は RLS で読めないので、サーバーの API が確かめてから返す (#2073 S4。
      // 以前は user_profiles を直接読み、本番では自分の行しか返らなかった)。返る項目は表示名・組織内の役割・参加した日・id だけ
      const res = await fetch('/api/org/members', { cache: 'no-store' });
      if (!res.ok) {
        setLoadError(MEMBERS_LOAD_ERROR);
        return;
      }
      const parsed = OrgMemberNamesResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        // 応答の形が違う (読み込めなかったのと同じに扱う。空の一覧と見せない)
        setLoadError(MEMBERS_LOAD_ERROR);
        return;
      }
      setMembers(parsed.data.members);
      setLoadError(null);
    } catch (error) {
      console.error('Failed to fetch members:', error);
      setLoadError(MEMBERS_LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleRemove = async (memberId: string, memberNickname: string | null) => {
    if (writeInFlightRef.current) return;
    if (!confirm(`「${normalizeProfileName(memberNickname) ?? 'このメンバー'}」を組織から除名しますか？`)) return;
    writeInFlightRef.current = true;
    setRemovingId(memberId);
    try {
      const res = await fetch(`/api/org/members/${memberId}/remove`, {
        method: 'POST',
      });
      if (!res.ok) {
        // 本文の message は操作ごとの固定の文なので、理由は code から引く (#1478)
        const err = await res.json().catch(() => null);
        alert(`除名失敗: ${membershipErrorMessageOfBody(err)}`);
        return;
      }
      await fetchData();
    } catch (error) {
      // 通信が失敗した (#2059。catch が無いと失敗の文が出ず、onClick の promise が reject のまま終わっていた)
      console.error('Failed to remove member:', error);
      alert(`除名失敗: ${MEMBERSHIP_NETWORK_FAILURE_REASON}`);
      // サーバーが除名を済ませてから応答が切れたこともあるので、一覧を読み直す (#2064 R5。読み直さないと、除名したメンバーが一覧に残り、
      // もう一度「除名」を押すとエラーの文が出ていた)。読み直しが失敗したときは fetchData が一覧の「読み込めませんでした」を出す。
      // 成功のときの読み直しと同じく、読み直しの応答を待つあいだも書き込みの待ち (writeInFlightRef) を戻さない (上の writeInFlightRef の理由と同じ)
      await fetchData();
    } finally {
      writeInFlightRef.current = false;
      setRemovingId(null);
    }
  };

  const handleLeave = async () => {
    if (writeInFlightRef.current) return;
    if (!confirm('組織から脱退しますか？この操作は元に戻せません。')) return;
    writeInFlightRef.current = true;
    setLeaving(true);
    try {
      const res = await fetch('/api/org/leave', { method: 'POST' });
      if (!res.ok) {
        // 本文の message は操作ごとの固定の文なので、理由は code から引く (#1478)
        const err = await res.json().catch(() => null);
        alert(`脱退失敗: ${membershipErrorMessageOfBody(err)}`);
        return;
      }
      router.push('/home');
    } catch (error) {
      // 通信が失敗した (#2059。catch が無いと失敗の文が出ず、onClick の promise が reject のまま終わっていた)
      console.error('Failed to leave organization:', error);
      // サーバーが脱退を済ませてから応答が切れたこともあるので、自分のプロフィールを読み直して確かめる (#2064。除名の読み直しと同じ型。
      // 確かめないと、画面は組織のまま残り、もう一度押すと「脱退失敗」が出ていた)。
      // 読み直しの応答を待つあいだも書き込みの待ち (writeInFlightRef / leaving) を戻さない (ボタンを止めたままにする)
      const membership = await readOwnMembershipAfterNetworkFailure(supabase, 'org');
      if (membership === 'left') {
        // 組織を抜けている: 成功のときと同じ遷移
        router.push('/home');
        return;
      }
      // 抜けていない: これまでどおり失敗の文。確かめられなかったときは「状態を確かめられませんでした」を添える
      alert(withMembershipStateNote(`脱退失敗: ${MEMBERSHIP_NETWORK_FAILURE_REASON}`, membership));
    } finally {
      writeInFlightRef.current = false;
      setLeaving(false);
    }
  };

  // 一覧の読み込みをやり直す (読み込めなかったときの「再試行」)。
  // 書き込みの応答を待つあいだは送らない (#2059。チャレンジ・部署・招待の画面と同じ形)。読み込み中の表示 (fetchData の setLoading) で
  // 脱退の「処理中...」を隠さないため。ボタンも isWriting で止める。ref は再描画の前に押されたとき (ボタンがまだ止まっていない) の守り
  const retryLoad = () => {
    if (writeInFlightRef.current) return;
    void fetchData();
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
          {/* 読み込めなかったときは人数を出さない (「0 名」と見せない) */}
          <h1 className="text-2xl font-bold text-gray-900">{loadError ? '組織メンバー' : `組織メンバー (${members.length} 名)`}</h1>
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
              disabled={isWriting}
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
            {loadError ? (
              <tr>
                <td colSpan={4} className="p-8">
                  <div
                    role="alert"
                    data-testid="member-load-error"
                    className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm"
                  >
                    <span>{loadError}</span>
                    <button
                      type="button"
                      onClick={retryLoad}
                      disabled={isWriting}
                      className="shrink-0 px-3 py-1.5 bg-white border border-red-300 rounded-lg text-red-700 hover:bg-red-100 transition-colors disabled:opacity-50"
                    >
                      再試行
                    </button>
                  </div>
                </td>
              </tr>
            ) : members.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-8 text-center text-gray-400">メンバーがいません</td>
              </tr>
            ) : (
              members.map((member) => (
                <tr key={member.id} className="hover:bg-gray-50 transition-colors">
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-100 to-blue-50 flex items-center justify-center font-bold text-blue-500 text-xs">
                        {(normalizeProfileName(member.nickname) ?? 'U')[0].toUpperCase()}
                      </div>
                      <span className="font-medium text-gray-900">
                        {normalizeProfileName(member.nickname) ?? '(名前なし)'}
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
                        disabled={isWriting}
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
