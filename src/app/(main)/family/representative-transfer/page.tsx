'use client';

// src/app/(main)/family/representative-transfer/page.tsx
// (設計書 03-ui-spec.md §10.2, 02-flow-spec.md §10)
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { loginPathWithNext, readSignedInUser } from '@/lib/auth/signed-in-user';
import { applyFamilyMemberNames, fetchFamilyMemberNames } from '@/lib/membership/family-member-names';
import { MEMBERSHIP_STATE_UNCONFIRMED_NOTE } from '@/lib/membership/leave-state';
import {
  readPendingTransferProposal,
  transferProposalStateAfterNetworkFailure,
} from '@/lib/membership/transfer-proposal-state';

/** 提案の送信の通信そのものが失敗した (fetch が reject した) ときの文 */
const NETWORK_FAILURE_MESSAGE = '通信エラーが発生しました';

/**
 * 譲渡の候補 (または自分のプロフィール・家族の中の自分の役割) を読み込めなかったときの文。
 * 候補がいない (「代表者を引き継げるメンバーがいません」) ・代表者でない (「この操作は代表者のみが行えます」) と見分けるために出す
 * (#2064 R4 と同じ形。組織のオーナーの譲渡の画面の CANDIDATES_LOAD_ERROR と同じ扱い)。失敗の理由 (英語の内部の文) は画面に出さない
 */
const CANDIDATES_LOAD_ERROR = '代表者の譲渡の候補を読み込めませんでした。しばらくしてから、もう一度お試しください。';

/** 代表者でない人が開いたときの文 */
const REPRESENTATIVE_ONLY_MESSAGE = 'この操作は代表者のみが行えます';

/** この画面のパス (ログインのあとに戻る先) */
const REPRESENTATIVE_TRANSFER_PATH = '/family/representative-transfer';

interface FamilyMember {
  id: string;
  role: 'representative' | 'adult' | 'child';
  display_name: string | null;
  user_id: string | null;
}

export default function FamilyRepresentativeTransferPage() {
  const router = useRouter();
  const supabase = createClient();

  const [familyId, setFamilyId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<FamilyMember[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  // 代表者でないときの文。あるあいだは画面の代わりにこの文と「戻る」を出す (送信の失敗の error とは別にする。
  // 以前は error に入れていたが、家族の ID を入れたあとなので表示の条件 (!familyId) に合わず、「引き継げるメンバーがいません」と出ていた)
  const [accessError, setAccessError] = useState<string | null>(null);
  // 候補を読み込めなかったときの文。あるあいだは候補の一覧と「引き継げるメンバーがいません」の代わりにこの文と「再試行」を出す (#2064 R4 と同じ形)
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadCandidates = useCallback(async () => {
    setLoading(true);
    // 別の画面へ移るときは、移るまで読み込み中の表示のままにする (これまでどおり)
    let redirecting = false;
    try {
      // getUser は通信の失敗を投げずに { user: null, error } で返す。ログインの画面へ移すのはログインしていないときだけにし、
      // 確かめられなかったときは読み込みの失敗と「再試行」を出す (#2093 W4。以前は通信が切れているだけでもログインの画面へ移していた)。
      // ログインのあとにこの画面へ戻れるよう next を付ける
      const signedIn = await readSignedInUser(supabase);
      if (signedIn.kind === 'load-failed') {
        setLoadError(CANDIDATES_LOAD_ERROR);
        return;
      }
      if (signedIn.kind === 'signed-out') {
        redirecting = true;
        router.push(loginPathWithNext(REPRESENTATIVE_TRANSFER_PATH));
        return;
      }
      const { user } = signedIn;
      setCurrentUserId(user.id);

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('family_id')
        .eq('id', user.id)
        .single();

      if (profileError) {
        // 自分のプロフィールを読めなかった (家族に入っていないのとは別。家族の作成の画面へ送らない)
        setLoadError(CANDIDATES_LOAD_ERROR);
        return;
      }
      if (!profile?.family_id) {
        redirecting = true;
        router.replace('/family/setup');
        return;
      }
      setFamilyId(profile.family_id);

      // 自分のロールを確認。行が無いときは代表者でない扱い (maybeSingle は 0 行で error にしない)。
      // 抜けた (status が active でない) 行が同じ家族に残っていても 1 行に絞れるよう、active の行だけを見る
      // (active の行は 1 人 1 行まで。部分 UNIQUE uniq_family_members_user)
      const { data: myMember, error: myMemberError } = await supabase
        .from('family_members')
        .select('role')
        .eq('family_id', profile.family_id)
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();

      if (myMemberError) {
        // 役割を読めなかった (代表者でないのとは別。「代表者のみ」と見せない)
        setLoadError(CANDIDATES_LOAD_ERROR);
        return;
      }
      if (myMember?.role !== 'representative') {
        setAccessError(REPRESENTATIVE_ONLY_MESSAGE);
        setLoadError(null);
        return;
      }

      // 候補 (adult のみ、自分を除く)
      const { data: membersData, error: membersError } = await supabase
        .from('family_members')
        .select('id, role, display_name, user_id')
        .eq('family_id', profile.family_id)
        .eq('status', 'active')
        .in('role', ['adult'])
        .neq('user_id', user.id);

      if (membersError) {
        // 読み込めなかった (候補がいないのとは別。「引き継げるメンバーがいません」と見せない)
        setLoadError(CANDIDATES_LOAD_ERROR);
        return;
      }

      // 画面に出す名前 (display_name が無ければ本人のプロフィールの今の名前) は API で決める (#1584)
      const names = await fetchFamilyMemberNames();
      setCandidates(applyFamilyMemberNames((membersData ?? []) as FamilyMember[], names));
      setLoadError(null);
    } catch (loadFailure) {
      // 問い合わせが例外を投げた (以前は catch も finally も無く、読み込み中の表示のまま止まり、未処理の reject になっていた)
      console.error('[family/representative-transfer] load error:', loadFailure);
      setLoadError(CANDIDATES_LOAD_ERROR);
    } finally {
      if (!redirecting) setLoading(false);
    }
  }, [supabase, router]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  // 候補の読み込みをやり直す (読み込めなかったときの「再試行」)。
  // 「再試行」は読み込めなかったとき (フォームを出していないとき) だけ出すので、譲渡の提案の送信とは重ならない
  const retryLoad = () => {
    void loadCandidates();
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!selectedUserId) {
      setError('譲渡先のメンバーを選択してください');
      return;
    }
    if (!familyId) {
      setError('家族グループが見つかりません');
      return;
    }

    const toUserId = selectedUserId;
    const targetFamilyId = familyId;
    setSubmitting(true);
    // 送る前の pending の提案。通信が失敗したときに、今回の提案を作れていたかを見分けるために使う (#2073 S8)
    const pendingBefore = await readPendingTransferProposal(supabase, 'family', targetFamilyId);
    try {
      const res = await fetch('/api/family/representative-transfer/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          family_id: targetFamilyId,
          to_user_id: toUserId,
          reason: reason.trim() || undefined,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error?.message ?? '代表者譲渡の提案に失敗しました');
        return;
      }

      setSuccess(true);
    } catch (err) {
      console.error('[family/representative-transfer] error:', err);
      // サーバーが提案を作り、譲渡先へメールを送ってから応答が切れたこともあるので、pending の提案を読み直して確かめる (#2073 S8。
      // 以前は確かめずに通信エラーの文を出し、もう一度送ると、譲渡先に提案のメールが 2 通届き、1 通目のリンクは期限切れになっていた)。
      // 読み直しの応答を待つあいだも「譲渡を提案」を止めたままにする (submitting を戻さない)
      const pendingAfter = await readPendingTransferProposal(supabase, 'family', targetFamilyId);
      const state = transferProposalStateAfterNetworkFailure(pendingBefore, pendingAfter, toUserId);
      if (state === 'sent') {
        // 提案を作れている: 成功のときと同じ表示 (送り直しのボタンを出さない)
        setSuccess(true);
        return;
      }
      // 作れていない: これまでどおり通信エラーの文。確かめられなかったときは「状態を確かめられませんでした」を添える
      setError(state === 'unknown' ? `${NETWORK_FAILURE_MESSAGE} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})` : NETWORK_FAILURE_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">読み込み中…</div>
      </div>
    );
  }

  if (accessError) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-gray-600 text-sm text-center">{accessError}</p>
        <button
          onClick={() => router.back()}
          className="px-4 py-2 rounded-full bg-gray-100 text-gray-600 text-sm"
        >
          戻る
        </button>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-6">
        <div className="text-6xl">✅</div>
        <h1 className="text-xl font-bold text-gray-900 text-center">
          譲渡提案を送信しました
        </h1>
        <p className="text-sm text-gray-500 text-center">
          選択したメンバーに確認メールを送信しました。
          承諾されると代表者が変更されます。
        </p>
        <button
          onClick={() => router.push('/family/members')}
          className="px-6 py-3 rounded-full bg-green-500 text-white font-bold text-sm hover:bg-green-600 transition-colors"
        >
          メンバー一覧に戻る
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
        <h1 className="text-2xl font-bold text-gray-900">代表者を譲渡</h1>
        <p className="text-xs text-gray-400 mt-1">新しい代表者候補に承諾確認メールを送信します</p>
      </div>

      <div className="p-6">
        {loadError ? (
          <div
            role="alert"
            data-testid="family-transfer-load-error"
            className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm"
          >
            <span>{loadError}</span>
            <button
              type="button"
              onClick={retryLoad}
              className="shrink-0 px-3 py-1.5 bg-white border border-red-300 rounded-lg text-red-700 hover:bg-red-100 transition-colors"
            >
              再試行
            </button>
          </div>
        ) : candidates.length === 0 ? (
          // 読み込みに成功して候補が 0 人のときだけ出す
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
            <p className="text-gray-400 text-sm">
              代表者を引き継げるメンバーがいません。
              まず大人メンバーを招待してください。
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* 候補者選択 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                新しい代表者候補
                <span className="text-red-500 ml-1">*</span>
              </label>
              <div className="space-y-2">
                {candidates.map((candidate) => (
                  <label
                    key={candidate.id}
                    className={`flex items-center gap-3 p-4 rounded-2xl border cursor-pointer transition-colors ${
                      selectedUserId === candidate.user_id
                        ? 'border-green-400 bg-green-50'
                        : 'border-gray-100 bg-white hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="candidate"
                      value={candidate.user_id ?? ''}
                      checked={selectedUserId === candidate.user_id}
                      onChange={() => setSelectedUserId(candidate.user_id)}
                      className="text-green-500"
                    />
                    <div>
                      <div className="font-medium text-gray-800">
                        {candidate.display_name ?? '名前未設定'}
                      </div>
                      <div className="text-xs text-gray-400">大人メンバー</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* 理由 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                理由 (任意)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="譲渡の理由を入力してください（任意）"
                rows={3}
                maxLength={500}
                className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100 resize-none"
                disabled={submitting}
              />
              <p className="text-xs text-gray-400 mt-1">{reason.length}/500 文字</p>
            </div>

            <div className="bg-yellow-50 border border-yellow-100 rounded-2xl p-4">
              <p className="text-sm text-yellow-700">
                ※ 譲渡後、あなたの役割は「大人」に変わります。
                相手が承諾するまで現在の代表者のままです。
              </p>
            </div>

            {/* エラー */}
            {error && (
              <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
                {error}
              </div>
            )}

            {/* 送信ボタン */}
            <button
              type="submit"
              disabled={submitting || !selectedUserId}
              className="w-full rounded-full bg-green-500 py-4 text-white font-bold text-base hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? '提案中…' : '譲渡を提案'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
