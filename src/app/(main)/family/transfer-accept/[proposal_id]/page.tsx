'use client';

// src/app/(main)/family/transfer-accept/[proposal_id]/page.tsx
// (設計書 03-ui-spec.md §10.2, 02-flow-spec.md §10)
import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { normalizeProfileName } from '@/lib/profile-name';
import { transferProposalStatusMessage } from '@/lib/membership/transfer-proposal-status';
import { readSignedInUser } from '@/lib/auth/signed-in-user';
import { useAiConsultationReceiver, type AiConsultationRead } from '@/hooks/useAiConsultationReceiver';

/** 提案が無い (または RLS で見えない) ときの文 */
const PROPOSAL_NOT_FOUND_MESSAGE = '譲渡提案が見つかりません';

/**
 * 提案 (と提案者・家族名) を読み込めなかったときの文。提案が無い (「譲渡提案が見つかりません」) と見分けるために出す
 * (#2064。組織のオーナーの譲渡の承諾の画面の PROPOSAL_LOAD_ERROR と同じ文・同じ扱い)。
 * 読み込みは Supabase の問い合わせで、失敗の理由 (英語の内部の文) は画面に出さない
 */
const PROPOSAL_LOAD_ERROR = '譲渡の提案を読み込めませんでした。しばらくしてから、もう一度お試しください。';

/** 承諾・拒否の通信そのものが失敗した (fetch が reject した) ときの文 */
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

interface TransferProposal {
  id: string;
  scope: string;
  scope_id: string;
  from_user_id: string;
  to_user_id: string;
  status: string;
  proposed_at: string;
  expires_at: string;
}

/** 読み込みの置き場所の鍵 (提案・提案者・家族名・自分の id・失敗の表示・ログインへの移動を 1 つの鍵で置く。#2206 G1 §9 #6) */
const KEY_PROPOSAL = 'proposal';

export default function FamilyTransferAcceptPage() {
  // パスの値は useParams で読む。props の params は Next 15 から Promise で、Next 14 では use(params) が例外になった (#1275)。
  // useParams はどちらでも同じに使えるので、こちらにそろえている (#1444)。
  const { proposal_id } = useParams<{ proposal_id: string }>();
  const router = useRouter();
  const supabase = createClient();

  const [proposal, setProposal] = useState<TransferProposal | null>(null);
  const [fromName, setFromName] = useState<string | null>(null);
  const [familyName, setFamilyName] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  // 承諾・拒否が失敗したときの文
  const [error, setError] = useState<string | null>(null);
  // 提案が無い (または RLS で見えない) か。あるあいだは提案の代わりに「譲渡提案が見つかりません」と「戻る」を出す
  const [notFound, setNotFound] = useState(false);
  // 提案を読み込めなかったときの文。あるあいだは提案の代わりにこの文と「再試行」を出す
  // (#2064。以前は error を見ず、読み込めなかったのを「譲渡提案が見つかりません」と見せていた)
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<'accept' | 'decline' | null>(null);
  const [result, setResult] = useState<'accepted' | 'declined' | null>(null);
  /**
   * ログインの画面へ移っているか (#2206 G1 §6.8)。移る読み取りが読み込み中の表示を出していたときだけ立てる (移るまで読み込み中の表示のまま。
   * 取り直し (読み込み中の表示を出していない) が移すときは、今の画面のまま移る)
   */
  const [redirecting, setRedirecting] = useState(false);
  /**
   * receiver.isLoading の写し。fetchProposal は receiver より先に宣言する (receiver の引数) ので ref で引く。
   * place の apply の中で呼ぶと、その鍵を下ろす前の値を返す (hook は apply が戻ってから印を下ろす)
   */
  const isLoadingRef = useRef<(key: string) => boolean>(() => false);
  // 承諾・拒否の書き込み (通信エラーのあとの読み直しまで) の応答を待っているか。待つあいだは、ほかの書き込みを始めない (二重押しの守り)。
  // ref は再描画の前に続けて起きたとき (ボタンがまだ止まっていない) の守り。AI 相談の成功の取り直しとの重なりは、書き込みの窓
  // (receiver.beginWrite) が受け持つ (窓の間は取り直さず、終わったら 1 回取り直す。読み直しの応答があとから届いて、承諾・拒否の
  // 通信エラーのあとの読み直し (今の状態) を書き込む前の提案で上書きしない。#2206 G1)
  const busyRef = useRef(false);

  // 提案・提案者・家族名を読む。画面を開いたとき・「再試行」・承諾 / 拒否の通信エラーのあと・AI 相談の成功 (#2195 V1) のあとに呼ぶ。
  // 応答は全部を読んでから最後に 1 回だけ置く (自分の id も最後の apply の中。順序・番兵の判断は read.place の中。#2206 G1)。
  // read.mode が 'refetch' (AI 相談の成功の取り直し。#2201 U1) なら、読み込めなかったときは何も置かずに今の表示を残す
  const fetchProposal = useCallback(async (read: AiConsultationRead): Promise<void> => {
    /** 読み込めなかった: 開いたとき・「再試行」・承諾 / 拒否の通信エラーのあとは「読み込めませんでした」を出し、取り直しは今の表示を残す */
    const loadFailed = () => {
      if (read.mode === 'mount') read.place(KEY_PROPOSAL, () => setLoadError(PROPOSAL_LOAD_ERROR));
    };
    try {
      // getUser は通信の失敗を投げずに { user: null, error } で返す。ログインの画面へ移すのはログインしていないときだけにし、
      // 確かめられなかったときは読み込みの失敗と「再試行」を出す (#2086 V3。以前は通信が切れているだけでもログインの画面へ移し、
      // 承諾・拒否の通信が切れたあとの読み直しでもここを通るので、今の状態を見せられなかった)。
      // ログインのあとにこの画面へ戻れるよう next を付ける (組織の譲渡の承諾の画面と同じ)
      const signedIn = await readSignedInUser(supabase);
      if (signedIn.kind === 'load-failed') return loadFailed();
      if (signedIn.kind === 'signed-out') {
        // 移動も置く (古い応答では移らない。#2206 G1)
        read.place(KEY_PROPOSAL, () => {
          if (isLoadingRef.current(KEY_PROPOSAL)) setRedirecting(true);
          router.push(`/login?next=/family/transfer-accept/${proposal_id}`);
        });
        return;
      }
      const { user } = signedIn;
      // 自分の id はここでは置かない (最後の apply でまとめて置く。途中で置くと、その時点で KEY_PROPOSAL の読み込み中の印が下り、
      // 置いた世代も進む。#2206 G1 §6.2)

      const { data: proposalData, error: proposalError } = await supabase
        .from('ownership_transfer_proposals')
        .select('*')
        .eq('id', proposal_id)
        .single();

      if (isLoadFailure(proposalError)) {
        // 読み込めなかった (提案が無いのとは別。「譲渡提案が見つかりません」と見せない)
        return loadFailed();
      }
      if (!proposalData) {
        // 行が無い (PGRST116) か、RLS で見えない
        read.place(KEY_PROPOSAL, () => {
          setCurrentUserId(user.id);
          setNotFound(true);
          setLoadError(null);
        });
        return;
      }

      // 提案者情報
      // user_profiles に email 列は無い (メールアドレスは auth.users にしか無く、他人のものは画面にも出さない)。
      // 他人の行は RLS で読めない (user_profiles の SELECT は本人の行だけ) ので、読めなければ (PGRST116)「代表者」と表示する。
      // 名前が出るのは、申し出た本人が自分の申し出の画面を開いたとき (自分の名前。AI 相談の update_profile_preferences が書く)。
      // 読み込めなかったときは読み込みの失敗
      const { data: fromProfile, error: fromProfileError } = await supabase
        .from('user_profiles')
        .select('nickname')
        .eq('id', proposalData.from_user_id)
        .single();
      if (isLoadFailure(fromProfileError)) return loadFailed();

      // 家族グループ名 (行が無い・RLS で見えないときは「家族グループ」と出す。読み込めなかったときは読み込みの失敗)
      let nextFamilyName: string | null = null;
      if (proposalData.scope === 'family') {
        const { data: group, error: groupError } = await supabase
          .from('family_groups')
          .select('name')
          .eq('id', proposalData.scope_id)
          .single();
        if (isLoadFailure(groupError)) return loadFailed();
        nextFamilyName = group?.name ?? '家族グループ';
      }

      // 3 つとも読めてから出す (一部だけ読めた状態で承諾・拒否を出さない)
      read.place(KEY_PROPOSAL, () => {
        setCurrentUserId(user.id);
        setProposal(proposalData as TransferProposal);
        setFromName(normalizeProfileName(fromProfile?.nickname) ?? '代表者');
        setFamilyName(nextFamilyName);
        setNotFound(false);
        setLoadError(null);
      });
    } catch (fetchError) {
      // 問い合わせが例外を投げた (以前は try / catch が無く、読み込み中の表示のまま止まり、未処理の reject になっていた)
      console.error('[family/transfer-accept] failed to fetch ownership transfer proposal:', fetchError);
      loadFailed();
    }
  }, [supabase, router, proposal_id]);

  // AI 相談の提案の実行が成功したら (#2195 V1)、読み込み中の表示を出さずに提案を読み直す。提案者の名前は、申し出た本人が開いたときは
  // 自分のプロフィールの名前 (user_profiles.nickname) で、AI 相談の update_profile_preferences が書く。
  // ログアウトしていたときは、開いたときと同じ扱い (fetchProposal が決める)。読み直しの失敗では今の表示を残す (#2201 U1)。
  // 承諾・拒否の窓の間は取り直さず、終わったあとに 1 回取り直す。取り直しを始めたあとに承諾・拒否が始まったら、
  // その取り直しの応答は置かずにもう 1 回取り直す (#2206 G1。窓は receiver.beginWrite)。
  // 開いたとき・「再試行」の読み込み中に来た成功は、その読み込みの役を引き継がない (開いたときの読み込みが自分の応答を置き、
  // 自分の読み込み中の表示を下ろす。#2206 G1)。最初の描画から読み込み中の表示を出す (initialLoadingKeys)
  const receiver = useAiConsultationReceiver(fetchProposal, { initialLoadingKeys: [KEY_PROPOSAL] });
  isLoadingRef.current = receiver.isLoading;
  // ログインの画面へ移っている間も読み込み中の表示 (これまでどおり)
  const loading = receiver.isLoading(KEY_PROPOSAL) || redirecting;

  const loadPage = useCallback(
    () => receiver.read({ loadingKeys: [KEY_PROPOSAL] }, fetchProposal),
    [receiver, fetchProposal],
  );

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
    if (busyRef.current) return;
    busyRef.current = true;
    setActionLoading('accept');
    setError(null);
    // 書き込みの窓 (通信エラーのあとの読み直しまで)。窓の間は AI 相談の成功の取り直しを止める (#2206 G1)
    const endWrite = receiver.beginWrite();
    try {
      const res = await fetch(`/api/family/representative-transfer/${proposal_id}/accept`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? '承諾に失敗しました');
        return;
      }
      setResult('accepted');
    } catch {
      setError(NETWORK_FAILURE_MESSAGE);
      // サーバーが承諾を済ませてから応答が切れたこともあるので、提案を読み直して今の状態を見せる (#2064。組織の承諾の画面と同じ形。
      // 読み直さないと、承諾済みの提案に承諾・拒否のボタンが残り、もう一度押すと失敗の文が出ていた)。
      // 読み直しの応答を待つあいだもボタンを止めたままにする (actionLoading を戻さない)。読み直しが失敗したら「読み込めませんでした」を出す
      await receiver.read({}, fetchProposal);
    } finally {
      busyRef.current = false;
      setActionLoading(null);
      endWrite();
    }
  };

  const handleDecline = async () => {
    if (busyRef.current) return;
    if (!window.confirm('譲渡提案を拒否しますか？')) return;
    busyRef.current = true;
    setActionLoading('decline');
    setError(null);
    // 書き込みの窓 (通信エラーのあとの読み直しまで)。窓の間は AI 相談の成功の取り直しを止める (#2206 G1)
    const endWrite = receiver.beginWrite();
    try {
      const res = await fetch(`/api/family/representative-transfer/${proposal_id}/decline`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? '拒否に失敗しました');
        return;
      }
      setResult('declined');
    } catch {
      setError(NETWORK_FAILURE_MESSAGE);
      // サーバーが拒否を済ませてから応答が切れたこともあるので、提案を読み直す (承諾の通信エラーと同じ)
      await receiver.read({}, fetchProposal);
    } finally {
      busyRef.current = false;
      setActionLoading(null);
      endWrite();
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">読み込み中…</div>
      </div>
    );
  }

  if (result === 'accepted') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-6">
        <div className="text-6xl">✅</div>
        <h1 className="text-xl font-bold text-gray-900 text-center">
          代表者を引き継ぎました
        </h1>
        <p className="text-sm text-gray-500 text-center">
          あなたが「{familyName}」の新しい代表者になりました。
        </p>
        <button
          onClick={() => router.push('/family/members')}
          className="px-6 py-3 rounded-full bg-green-500 text-white font-bold text-sm hover:bg-green-600 transition-colors"
        >
          メンバー一覧を確認
        </button>
      </div>
    );
  }

  if (result === 'declined') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-6">
        <div className="text-6xl">🚫</div>
        <h1 className="text-xl font-bold text-gray-900 text-center">
          譲渡提案を拒否しました
        </h1>
        <p className="text-sm text-gray-500 text-center">
          {fromName} 様に拒否のご連絡が届きます。
        </p>
        <button
          onClick={() => router.push('/family/members')}
          className="px-6 py-3 rounded-full bg-gray-200 text-gray-800 font-bold text-sm hover:bg-gray-300 transition-colors"
        >
          メンバー一覧へ戻る
        </button>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div
          role="alert"
          data-testid="family-transfer-accept-load-error"
          className="w-full max-w-md rounded-2xl bg-red-50 border border-red-200 p-6 text-center"
        >
          {/* 承諾・拒否の通信エラーのあとの読み直しが失敗したときは、通信エラーの文も残す */}
          {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
          <p className="text-sm text-red-600">{loadError}</p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={retryLoad}
              className="px-4 py-2 rounded-full bg-white border border-red-300 text-red-600 text-sm"
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

  if (notFound) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-gray-600 text-sm text-center">{PROPOSAL_NOT_FOUND_MESSAGE}</p>
        <button
          onClick={() => router.back()}
          className="px-4 py-2 rounded-full bg-gray-100 text-gray-600 text-sm"
        >
          戻る
        </button>
      </div>
    );
  }

  if (!proposal) return null;

  const isExpired = new Date(proposal.expires_at) < new Date();
  // 承諾・拒否ができない提案の理由の文 (#2073 S5。以前は処理済みの提案に「既に処理されています (ステータス: accepted)」と
  // 内部の英字の値をそのまま出していた。組織の承諾の画面と同じ対応表の日本語の文にする)
  const statusMsg = transferProposalStatusMessage(proposal.status, isExpired);
  const isNotRecipient = currentUserId && proposal.to_user_id !== currentUserId;

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* ヘッダー */}
      <div className="bg-white p-6 pb-4 border-b border-gray-100 sticky top-0 z-20">
        <h1 className="text-2xl font-bold text-gray-900">代表者譲渡の提案</h1>
      </div>

      <div className="p-6 space-y-6">
        {/* 提案内容 */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <div className="text-center space-y-3">
            <div className="text-4xl">🔄</div>
            <p className="text-gray-800">
              <span className="font-bold">{fromName}</span> 様から
            </p>
            <p className="text-gray-800">
              「<span className="font-bold">{familyName}</span>」の
              <span className="font-bold text-green-600">代表者</span> を引き継ぐよう依頼されています
            </p>
            <p className="text-xs text-gray-400">
              提案日時: {proposal ? new Date(proposal.proposed_at).toLocaleDateString('ja-JP') : ''}
            </p>
            <p className="text-xs text-gray-400">
              期限: {proposal ? new Date(proposal.expires_at).toLocaleDateString('ja-JP') : ''}
            </p>
          </div>
        </div>

        {/* 状態に応じたメッセージ */}
        {statusMsg && (
          <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 text-center" data-testid="transfer-proposal-status">
            <p className="text-sm text-gray-500">{statusMsg}</p>
          </div>
        )}

        {isNotRecipient && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-4">
            <p className="text-sm text-yellow-700">この提案はあなた宛てではありません</p>
          </div>
        )}

        {/* エラー */}
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
            {error}
          </div>
        )}

        {/* アクションボタン (pending かつ自分宛て かつ 期限内) */}
        {statusMsg === null && !isNotRecipient && (
          <div className="space-y-3">
            <button
              onClick={handleAccept}
              disabled={!!actionLoading}
              className="w-full rounded-full bg-green-500 py-4 text-white font-bold text-base hover:bg-green-600 transition-colors disabled:opacity-50"
            >
              {actionLoading === 'accept' ? '承諾中…' : '承諾する (代表者になる)'}
            </button>
            <button
              onClick={handleDecline}
              disabled={!!actionLoading}
              className="w-full rounded-full bg-gray-100 py-4 text-gray-700 font-bold text-base hover:bg-gray-200 transition-colors disabled:opacity-50"
            >
              {actionLoading === 'decline' ? '拒否中…' : '拒否する'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
