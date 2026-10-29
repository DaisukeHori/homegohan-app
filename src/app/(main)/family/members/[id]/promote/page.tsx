'use client';

// src/app/(main)/family/members/[id]/promote/page.tsx
// #1232: 旧・即時「アカウント発行」UI を、本人同意フロー (参加リクエスト送信) UI へ全面書換。
// - 送信成功時の文言を非同期フローに合わせて修正 (「発行しました」→「リクエストを送信しました」)
// - 既存 pending リクエストの表示 / 取消 (DELETE) / 再送 (フォーム再表示) を追加
import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { PARENTAL_CONSENT_COPY } from '@homegohan/shared';
import { createClient } from '@/lib/supabase/client';
import { MEMBERSHIP_STATE_UNCONFIRMED_NOTE } from '@/lib/membership/leave-state';

/** 送信・取り消しの通信そのものが失敗した (fetch が reject した) ときの文 */
const NETWORK_FAILURE_MESSAGE = '通信エラーが発生しました';

/**
 * 自分のプロフィール・子供の行・承認待ちの依頼を読み込めなかったときの文 (#2073 S3)。家族に入っていない (家族の作成の画面へ移す) ・
 * メンバーが無い・承認待ちの依頼が無いと見分けるために出す (家族のメンバーの画面の FAMILY_MEMBERS_LOAD_ERROR と同じ扱い)。
 * 失敗の理由 (英語の内部の文) は画面に出さない
 */
const PROMOTE_LOAD_ERROR = '参加リクエストの情報を読み込めませんでした。しばらくしてから、もう一度お試しください。';

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
  display_name: string | null;
  role: string;
  user_id: string | null;
}

interface PendingPromotionRequest {
  id: string;
  email: string;
  status: string;
  expires_at: string;
}

export default function PromoteMemberPage() {
  // パスの値は useParams で読む。props の params は Next 15 から Promise で、Next 14 では use(params) が例外になった (#1275)。
  // useParams はどちらでも同じに使えるので、こちらにそろえている (#1444)。
  const { id: memberId } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();

  const [member, setMember] = useState<FamilyMember | null>(null);
  const [pendingRequest, setPendingRequest] = useState<PendingPromotionRequest | null>(null);
  const [showForm, setShowForm] = useState(false); // pending があっても再送フォームを開ける
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null); // 送信先 email
  // 読み込めなかったときの文。あるあいだは画面の代わりにこの文と「再試行」を出す (#2073 S3。以前は自分のプロフィールを読めないと
  // 家族に入っていないとして家族の作成の画面へ移し、子供の行を読めないと「メンバーが見つかりません」、承認待ちの依頼を読めないと
  // 依頼が無いと見せ、問い合わせが例外を投げると読み込み中の表示のまま止まっていた)
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * 承認待ちの依頼を読む。読めなければ ok: false (例外は投げない)。
   * 画面を開いたときと、送信・取り消しの通信が失敗したあと (サーバーが済ませていたかを確かめる。#2073 S2) に使う
   */
  const readPendingRequest = useCallback(async (): Promise<
    { ok: true; request: PendingPromotionRequest | null } | { ok: false }
  > => {
    try {
      // ★#1232: token 列は列単位 GRANT で読めないため select('*') 禁止。明示列リストで取得。
      const { data, error: readError } = await supabase
        .from('family_promotion_requests')
        .select('id, email, status, expires_at')
        .eq('member_id', memberId)
        .eq('status', 'pending')
        .maybeSingle();
      if (readError) return { ok: false };
      return { ok: true, request: (data as PendingPromotionRequest | null) ?? null };
    } catch (readFailure) {
      console.error('[family/members/promote] failed to read pending request:', readFailure);
      return { ok: false };
    }
  }, [supabase, memberId]);

  // 子供の行と承認待ちの依頼を読む。画面を開いたときと「再試行」で呼ぶ
  const loadPage = useCallback(async () => {
    setLoading(true);
    // 別の画面へ移るときは、移るまで読み込み中の表示のままにする (これまでどおり)
    let redirecting = false;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        redirecting = true;
        router.push('/login');
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('family_id')
        .eq('id', user.id)
        .single();

      if (profileError) {
        // 自分のプロフィールを読めなかった (家族に入っていないのとは別。家族の作成の画面へ送らない)
        setLoadError(PROMOTE_LOAD_ERROR);
        return;
      }
      if (!profile?.family_id) {
        redirecting = true;
        router.replace('/family/setup');
        return;
      }

      const { data: memberData, error: memberError } = await supabase
        .from('family_members')
        .select('id, display_name, role, user_id')
        .eq('id', memberId)
        .eq('family_id', profile.family_id)
        .single();

      if (isLoadFailure(memberError)) {
        // 読み込めなかった (メンバーが無いのとは別。「メンバーが見つかりません」と見せない)
        setLoadError(PROMOTE_LOAD_ERROR);
        return;
      }
      setLoadError(null);
      if (!memberData) {
        setError('メンバーが見つかりません');
        return;
      }

      if (memberData.role !== 'child') {
        setError('この操作は子供メンバーにのみ使用できます');
        return;
      }

      if (memberData.user_id) {
        setError('このメンバーは既にアカウントを持っています');
        return;
      }

      const pending = await readPendingRequest();
      if (!pending.ok) {
        // 読み込めなかった (承認待ちの依頼が無いのとは別。送信のフォームを出さない)
        setLoadError(PROMOTE_LOAD_ERROR);
        return;
      }
      setMember(memberData as FamilyMember);
      setPendingRequest(pending.request);
      setError(null);
    } catch (loadFailure) {
      console.error('[family/members/promote] load error:', loadFailure);
      setLoadError(PROMOTE_LOAD_ERROR);
    } finally {
      if (!redirecting) setLoading(false);
    }
  }, [supabase, router, memberId, readPendingRequest]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError('メールアドレスを入力してください');
      return;
    }

    const requestEmail = email.trim().toLowerCase();
    // 送る前の承認待ちの依頼 (画面に出している依頼)。通信が失敗したときに、新しい依頼を作れていたかを見分けるために使う
    const requestIdBefore = pendingRequest?.id ?? null;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/family/members/${memberId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: requestEmail }),
      });

      const json = await res.json();

      if (!res.ok) {
        // #1173: 保護者の同意が無い 13〜17 歳の子供 / 13 歳未満の子供は、専用の文を出す
        if (json.error?.code === 'PARENTAL_CONSENT_REQUIRED') {
          setError(PARENTAL_CONSENT_COPY.promotionConsentMissing);
          return;
        }
        if (json.error?.code === 'PROMOTION_UNDER_COPPA_AGE') {
          setError(PARENTAL_CONSENT_COPY.promotionUnderCoppaAge);
          return;
        }
        setError(json.error?.message ?? 'リクエストの送信に失敗しました');
        return;
      }

      setSuccess(json.data?.request?.email ?? requestEmail);
    } catch (err) {
      console.error('[family/members/promote] error:', err);
      // サーバーが依頼を作ってから応答が切れたこともあるので、承認待ちの依頼を読み直して確かめる (#2073 S2。
      // 以前は確かめずに通信エラーの文を出し、もう一度送ると、ご本人に確認のメールが 2 通届き、1 通目のリンクは取り消し済みになっていた)。
      // 読み直しの応答を待つあいだも送信を止めたままにする (submitting を戻さない)
      const pending = await readPendingRequest();
      if (!pending.ok) {
        // 確かめられなかった
        setError(`${NETWORK_FAILURE_MESSAGE} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})`);
        return;
      }
      const request = pending.request;
      if (request && request.id !== requestIdBefore && request.email.toLowerCase() === requestEmail) {
        // 新しい依頼を作れている: 成功のときと同じ表示
        setPendingRequest(request);
        setSuccess(request.email);
        return;
      }
      // 作れていない: 読み直した依頼を出し、これまでどおり通信エラーの文
      setPendingRequest(request);
      setError(NETWORK_FAILURE_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async () => {
    setError(null);
    setRevoking(true);
    try {
      const res = await fetch(`/api/family/members/${memberId}/promote`, { method: 'DELETE' });
      const json = await res.json();

      if (!res.ok) {
        setError(json.error?.message ?? 'リクエストの取消に失敗しました');
        return;
      }

      setPendingRequest(null);
      setShowForm(false);
    } catch (err) {
      console.error('[family/members/promote] revoke error:', err);
      // サーバーが取り消しを済ませてから応答が切れたこともあるので、承認待ちの依頼を読み直して確かめる (#2073 S2。
      // 以前は確かめずに通信エラーの文を出し、取り消した依頼が画面に残り、もう一度押すと失敗の文が出ていた)。
      // 読み直しの応答を待つあいだも取り消しを止めたままにする (revoking を戻さない)
      const revokedId = pendingRequest?.id ?? null;
      const pending = await readPendingRequest();
      if (!pending.ok) {
        // 確かめられなかった
        setError(`${NETWORK_FAILURE_MESSAGE} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})`);
        return;
      }
      if (pending.request === null || pending.request.id !== revokedId) {
        // 取り消せている (承認待ちの依頼が無い・別の依頼に変わっている): 読み直した状態を出す
        setPendingRequest(pending.request);
        setShowForm(false);
        return;
      }
      // 取り消せていない: これまでどおり通信エラーの文
      setError(NETWORK_FAILURE_MESSAGE);
    } finally {
      setRevoking(false);
    }
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
          data-testid="family-promote-load-error"
          className="w-full max-w-md rounded-2xl bg-red-50 border border-red-200 p-6 text-center"
        >
          <p className="text-sm text-red-600">{loadError}</p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void loadPage()}
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

  if (error && !member) {
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

  // ★#1232: 成功画面 — 旧「アカウントを発行しました」を非同期フローの事実に合わせて全面差し替え
  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-6">
        <div className="text-6xl">📨</div>
        <h1 className="text-xl font-bold text-gray-900 text-center">
          参加リクエストを送信しました
        </h1>
        <p className="text-sm text-gray-500 text-center">
          {success} 宛に、ご本人確認のメールをお送りしました。
          ご本人がメールのリンクから承認すると、メンバーとして追加されます。
          承認されるまでメンバーは追加されません。
        </p>
        <p className="text-xs text-gray-400 text-center">
          リクエストの有効期限は 14 日間です。このページからいつでも取り消せます。
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
        <h1 className="text-2xl font-bold text-gray-900">
          {member?.display_name ?? '子供'} の参加リクエスト
        </h1>
        <p className="text-xs text-gray-400 mt-1">
          ご本人のメールアドレスに確認メールを送り、本人が承認すると自分のアカウントで使えるようになります
        </p>
      </div>

      <div className="p-6">
        {/* pending リクエストがある場合の管理カード */}
        {pendingRequest && !showForm && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6 space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-2xl">⏳</span>
              <h2 className="text-base font-bold text-gray-900">承認待ちのリクエストがあります</h2>
            </div>
            <div className="text-sm text-gray-600 space-y-1">
              <p>送信先: <span className="font-medium">{pendingRequest.email}</span></p>
              <p>
                期限: {new Date(pendingRequest.expires_at).toLocaleDateString('ja-JP')} まで
              </p>
            </div>
            <p className="text-xs text-gray-400">
              ご本人がメールのリンクから承認するとメンバーに追加されます。
            </p>
            {error && (
              <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <button
                onClick={handleRevoke}
                disabled={revoking}
                className="w-full rounded-full border border-red-200 py-3 text-red-500 font-medium text-sm hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                {revoking ? '取消中…' : 'リクエストを取り消す'}
              </button>
              <button
                onClick={() => {
                  setError(null);
                  setShowForm(true);
                }}
                disabled={revoking}
                className="w-full rounded-full border border-gray-200 py-3 text-gray-500 font-medium text-sm hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                別のメールアドレスで再送する
              </button>
            </div>
          </div>
        )}

        {/* 新規送信 / 再送フォーム */}
        {(!pendingRequest || showForm) && (
          <>
            <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 mb-6">
              <p className="text-sm text-blue-700">
                ご本人が承認すると、{member?.display_name ?? '子供'} さんの枠がご本人のアカウントとつながり、
                大人のメンバーとして家族グループに参加します。
                承認されるまでメンバーの状態は変わりません。
                {pendingRequest && showForm
                  ? ' 再送すると、承認待ちの現在のリクエストは自動的に取り消されます。'
                  : ''}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              {/* メールアドレス */}
              <div>
                <label htmlFor="promotion-email" className="block text-sm font-medium text-gray-700 mb-2">
                  メールアドレス
                  <span className="text-red-500 ml-1">*</span>
                </label>
                <input
                  id="promotion-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="子供本人のメールアドレス"
                  className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
                  disabled={submitting}
                />
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
                disabled={submitting || !email.trim()}
                className="w-full rounded-full bg-green-500 py-4 text-white font-bold text-base hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? '送信中…' : '参加リクエストを送信'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
