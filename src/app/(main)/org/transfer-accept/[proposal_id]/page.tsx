"use client";

// 組織のオーナーの譲渡の承諾の画面 (/org/transfer-accept/[proposal_id]。提案のメールのリンクの行き先)。
// 譲渡先は一般メンバー (org_role = member) のこともあるので、組織の管理画面の枠 (src/app/(org)/layout.tsx。owner / admin でない人を
// /home へ送る) の外の、ログインした利用者の枠 (src/app/(main)/) に置く (#2068。家族の譲渡の承諾の画面と同じ枠)。
// ルートグループの名前は URL に出ないので、URL は変わらない。提案の本人かどうかは、この画面 (to_user_id と自分の比較) と、
// API・DB (ownership_transfer_proposals の RLS・承諾と拒否の関数の to_user_id = auth.uid() の確かめ) が受け持つ

import { useCallback, useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { normalizeProfileName } from "@/lib/profile-name";

/** 提案が無い (または RLS で見えない) ときの文 */
const PROPOSAL_NOT_FOUND_MESSAGE = '提案が見つかりません';

/**
 * 提案 (と組織名・提案者) を読み込めなかったときの文。提案が無い (「提案が見つかりません」) と見分けるために出す
 * (#2064 R4 と同じ型。組織のオーナーの譲渡の画面の CANDIDATES_LOAD_ERROR と同じ扱い)。
 * 読み込みは Supabase の問い合わせで、失敗の理由 (英語の内部の文) は画面に出さない
 */
const PROPOSAL_LOAD_ERROR = '譲渡の提案を読み込めませんでした。しばらくしてから、もう一度お試しください。';

/** 承諾・拒否の通信そのものが失敗した (fetch が reject した) ときの文 */
const NETWORK_FAILURE_MESSAGE = 'ネットワークエラーが発生しました';

/**
 * .single() で行が 0 件 (または RLS で見えない) ときの PostgREST の失敗のコード。
 * 行が無いのは「読み込めなかった」ではないので、これだけは読み込みの失敗と分ける
 */
const POSTGREST_NO_ROWS_CODE = 'PGRST116';

/** 問い合わせの失敗が「行が無い」ではない (= 読み込めなかった) か */
function isLoadFailure(error: { code?: string } | null): boolean {
  return error !== null && error.code !== POSTGREST_NO_ROWS_CODE;
}

interface ProposalInfo {
  id: string;
  from_user_id: string;
  to_user_id: string;
  status: string;
  proposed_at: string;
  expires_at: string;
  scope_id: string;
}

interface OrgInfo {
  name: string;
}

interface UserInfo {
  nickname: string | null;
}

export default function TransferAcceptPage() {
  const router = useRouter();
  const params = useParams();
  const supabase = createClient();
  const proposalId = params.proposal_id as string;

  const [proposal, setProposal] = useState<ProposalInfo | null>(null);
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [fromUser, setFromUser] = useState<UserInfo | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);
  // 承諾・拒否が失敗したときの文
  const [error, setError] = useState<string | null>(null);
  // 提案が無い (または RLS で見えない) か。あるあいだは提案の代わりに「提案が見つかりません」と「ホームへ戻る」を出す
  const [notFound, setNotFound] = useState(false);
  // 提案を読み込めなかったときの文。あるあいだは提案の代わりにこの文と「再試行」を出す
  // (#2064 R4 と同じ型。以前は error を見ず、読み込めなかったのを「提案が見つかりません」と見せていた)
  const [loadError, setLoadError] = useState<string | null>(null);

  // 提案・組織名・提案者を読む。画面を開いたとき・「再試行」・承諾 / 拒否の通信エラーのあとに呼ぶ。
  // 読み込み中の表示 (loading) は呼び出し側が決める (承諾 / 拒否のあとの読み直しは、提案の表示を残したまま読み直す)
  const fetchProposal = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push(`/login?next=/org/transfer-accept/${proposalId}`);
        return;
      }
      setCurrentUserId(user.id);

      // ownership_transfer_proposals に reason 列は無い (存在しない列を select すると PostgREST が失敗し、
      // 提案が「見つかりません」になっていた)。提案理由は DB に保存されず、提案メールにだけ載る
      const { data: proposalData, error: proposalError } = await supabase
        .from('ownership_transfer_proposals')
        .select('id, from_user_id, to_user_id, status, proposed_at, expires_at, scope_id')
        .eq('id', proposalId)
        .single();

      if (isLoadFailure(proposalError)) {
        // 読み込めなかった (提案が無いのとは別。「提案が見つかりません」と見せない)
        setLoadError(PROPOSAL_LOAD_ERROR);
        return;
      }
      if (!proposalData) {
        // 行が無い (PGRST116) か、RLS で見えない
        setNotFound(true);
        setLoadError(null);
        return;
      }

      // 組織名取得 (行が無い・RLS で見えないときは「組織」「-」と出す。読み込めなかったときは読み込みの失敗)
      const { data: orgData, error: orgError } = await supabase
        .from('organizations')
        .select('name')
        .eq('id', proposalData.scope_id)
        .single();
      if (isLoadFailure(orgError)) {
        setLoadError(PROPOSAL_LOAD_ERROR);
        return;
      }

      // 提案者のプロフィール取得 (他人の user_profiles は RLS で読めないことが多い。そのときは「(不明)」と出す。
      // 読み込めなかったときは読み込みの失敗)
      const { data: fromUserData, error: fromUserError } = await supabase
        .from('user_profiles')
        .select('nickname')
        .eq('id', proposalData.from_user_id)
        .single();
      if (isLoadFailure(fromUserError)) {
        setLoadError(PROPOSAL_LOAD_ERROR);
        return;
      }

      // 3 つとも読めてから出す (一部だけ読めた状態で承諾・拒否を出さない)
      setProposal(proposalData);
      setOrg(orgData);
      setFromUser(fromUserData);
      setNotFound(false);
      setLoadError(null);
    } catch (fetchError) {
      // 問い合わせが例外を投げた (以前は try / finally だけで catch が無く、未処理の reject になっていた)
      console.error('Failed to fetch ownership transfer proposal:', fetchError);
      setLoadError(PROPOSAL_LOAD_ERROR);
    }
  }, [supabase, router, proposalId]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    try {
      await fetchProposal();
    } finally {
      setLoading(false);
    }
  }, [fetchProposal]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  // 読み込みをやり直す (読み込めなかったときの「再試行」)。
  // 「再試行」は読み込めなかったとき (承諾・拒否のボタンを出していないとき) だけ出すので、承諾・拒否とは重ならない
  const retryLoad = () => {
    setError(null);
    void loadPage();
  };

  const handleAccept = async () => {
    if (!confirm('オーナー権限を引き受けますか？')) return;
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/org/owner-transfer/${proposalId}/accept`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? '受諾に失敗しました');
        return;
      }
      alert('オーナー権限を引き受けました。');
      router.push('/org/dashboard');
    } catch {
      setError(NETWORK_FAILURE_MESSAGE);
      // サーバーが承諾を済ませてから応答が切れたこともあるので、提案を読み直して今の状態を見せる (#2064 R5 と同じ型。
      // 読み直さないと、承諾済みの提案に承諾・拒否のボタンが残り、もう一度押すと失敗の文が出ていた)。
      // 読み直しの応答を待つあいだもボタンを止めたままにする (accepting を戻さない)。読み直しが失敗したら「読み込めませんでした」を出す
      await fetchProposal();
    } finally {
      setAccepting(false);
    }
  };

  const handleDecline = async () => {
    if (!confirm('この譲渡提案を拒否しますか？')) return;
    setDeclining(true);
    setError(null);
    try {
      const res = await fetch(`/api/org/owner-transfer/${proposalId}/decline`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? '拒否に失敗しました');
        return;
      }
      alert('譲渡提案を拒否しました。');
      router.push('/home');
    } catch {
      setError(NETWORK_FAILURE_MESSAGE);
      // サーバーが拒否を済ませてから応答が切れたこともあるので、提案を読み直す (承諾の通信エラーと同じ。#2064 R5 と同じ型)
      await fetchProposal();
    } finally {
      setDeclining(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-8 max-w-lg mx-auto">
        <div
          role="alert"
          data-testid="transfer-accept-load-error"
          className="bg-red-50 border border-red-200 rounded-2xl p-8 text-center"
        >
          {/* 承諾・拒否の通信エラーのあとの読み直しが失敗したときは、通信エラーの文も残す */}
          {error && <p className="text-red-700 text-sm mb-2">{error}</p>}
          <p className="text-red-700 font-medium">{loadError}</p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={retryLoad}
              className="px-4 py-2 rounded-xl bg-white border border-red-300 text-red-700 font-medium hover:bg-red-100 transition-colors"
            >
              再試行
            </button>
            <button
              type="button"
              onClick={() => router.push('/home')}
              className="px-4 py-2 rounded-xl bg-gray-100 text-gray-700 font-medium hover:bg-gray-200 transition-colors"
            >
              ホームへ戻る
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="p-8 max-w-lg mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-2xl p-8 text-center">
          <p className="text-red-700 font-medium">{PROPOSAL_NOT_FOUND_MESSAGE}</p>
          <button
            onClick={() => router.push('/home')}
            className="mt-4 px-4 py-2 rounded-xl bg-gray-100 text-gray-700 font-medium hover:bg-gray-200 transition-colors"
          >
            ホームへ戻る
          </button>
        </div>
      </div>
    );
  }

  if (!proposal) return null;

  const isExpired = new Date(proposal.expires_at) < new Date();
  const isNotPending = proposal.status !== 'pending';
  const isWrongUser = currentUserId && currentUserId !== proposal.to_user_id;

  const statusMessage = () => {
    if (proposal.status === 'accepted') return 'この提案はすでに承諾済みです';
    if (proposal.status === 'rejected') return 'この提案は拒否済みです';
    if (isExpired) return 'この提案は期限切れです';
    return null;
  };

  const statusMsg = statusMessage();

  return (
    <div className="p-8 max-w-lg mx-auto">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 border-b border-gray-100 bg-amber-50">
          <h1 className="text-xl font-bold text-gray-900">オーナー譲渡の提案</h1>
          <p className="text-sm text-amber-700 mt-1">
            {org?.name ?? '組織'} のオーナー権限を引き受けるかどうか選択してください
          </p>
        </div>

        <div className="p-6 space-y-4">
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">提案者</span>
              <span className="font-medium text-gray-900">
                {normalizeProfileName(fromUser?.nickname) ?? '(不明)'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">対象組織</span>
              <span className="font-medium text-gray-900">{org?.name ?? '-'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">提案日時</span>
              <span className="font-medium text-gray-900">
                {new Date(proposal.proposed_at).toLocaleDateString('ja-JP')}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">有効期限</span>
              <span className={`font-medium ${isExpired ? 'text-red-600' : 'text-gray-900'}`}>
                {new Date(proposal.expires_at).toLocaleDateString('ja-JP')}
                {isExpired && ' (期限切れ)'}
              </span>
            </div>
          </div>

          {statusMsg && (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl text-gray-600 text-sm text-center">
              {statusMsg}
            </div>
          )}

          {isWrongUser && (
            <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-xl text-yellow-700 text-sm">
              この提案はあなた宛てではありません。正しいアカウントでログインしてください。
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
              {error}
            </div>
          )}
        </div>

        {!statusMsg && !isWrongUser && (
          <div className="p-6 pt-0 flex gap-3">
            <button
              onClick={handleDecline}
              disabled={declining || accepting}
              className="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-gray-600 font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {declining ? '処理中...' : '拒否'}
            </button>
            <button
              onClick={handleAccept}
              disabled={accepting || declining}
              className="flex-1 px-4 py-3 rounded-xl bg-amber-500 text-white font-bold hover:bg-amber-600 transition-colors disabled:opacity-50 shadow-sm shadow-amber-200"
            >
              {accepting ? '処理中...' : '承諾'}
            </button>
          </div>
        )}

        {(statusMsg || isWrongUser) && (
          <div className="p-6 pt-0">
            <button
              onClick={() => router.push('/home')}
              className="w-full px-4 py-3 rounded-xl bg-gray-100 text-gray-700 font-medium hover:bg-gray-200 transition-colors"
            >
              ホームへ戻る
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
