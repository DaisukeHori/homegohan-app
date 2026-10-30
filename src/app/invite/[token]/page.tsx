'use client';

// src/app/invite/[token]/page.tsx
// (設計書 03-ui-spec.md §2 — 5 パターン分岐)
// org/family 共通版: scope ('family'|'organization') による分岐

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { readSignedInUser } from '@/lib/auth/signed-in-user';
import { FamilyInviteAcceptModal } from '@/components/membership/FamilyInviteAcceptModal';
import { InviteLayout } from '@/components/membership/InviteLayout';
import {
  readInviteAcceptStateAfterFailure,
  withInviteAcceptStateNote,
} from '@/lib/membership/invite-accept-state';

/** 組織の招待の承諾の通信そのものが失敗した (fetch が reject した・応答の本文を読めなかった) ときの文 */
const ORG_NETWORK_FAILURE_MESSAGE = '通信エラーが発生しました';

/** 組織の招待が承諾済み・拒否済み・取り消し済み (409 INVITE_ALREADY_USED) のときの文 */
const ORG_INVITE_ALREADY_USED_MESSAGE = 'この招待は既に使用済みです。';

/**
 * 自分 (ログインしているか) か招待の情報を読み込めなかったときの文 (#2093 W4)。招待が無い (「招待情報が見つかりません」) と
 * 見分けるために出す (以前は通信の失敗も「招待情報が見つかりません」と出していたので、オフラインで開いた招待のリンクが無効に見えた)。
 * 失敗の理由 (英語の内部の文) は画面に出さない
 */
const INVITE_LOAD_ERROR = '招待の情報を読み込めませんでした。しばらくしてから、もう一度お試しください。';

/** 招待が無い (get_invite_details が null を返した) ときの文 */
const INVITE_NOT_FOUND_MESSAGE = '招待情報が見つかりません';

/** 組織の招待の承諾が済んだときの遷移先 */
const ORG_DASHBOARD_PATH = '/org/dashboard';

interface InviteDetails {
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'revoked';
  // get_invite_details RPC (最新の定義は supabase/migrations/20261016200000_rpc_profile_name_placeholder.sql:62) の実返却キーに合わせる
  scope: 'family' | 'organization';
  /** 招待の家族 / 組織の id。承諾の通信が切れたあと、ここに入ったかを確かめる (#2080 U1) */
  scope_id: string;
  email: string;
  scope_name: string;
  invited_by_name: string;
  expires_at: string;
  is_existing_user?: boolean;
}

export default function InvitePage() {
  // パスの値は useParams で読む。props の params は Next 15 から Promise で、Next 14 では use(params) が例外になった (#1275)。
  // useParams はどちらでも同じに使えるので、こちらにそろえている (#1444)。
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const supabase = createClient();

  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 読み込めなかったときの文。あるあいだは画面の代わりにこの文と「再試行」を出す (#2093 W4)
  const [loadError, setLoadError] = useState<string | null>(null);

  // org accept/reject state
  const [orgLoading, setOrgLoading] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);

  // 自分と招待の情報を読む。画面を開いたときと「再試行」で呼ぶ。例外は投げない
  const loadPage = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setError(null);
    try {
      // 認証状態確認。getUser は通信の失敗を投げずに { user: null, error } で返すので、readSignedInUser で見分ける。
      // 確かめられなかったときは、ログインしていないとしてログインの案内を出さず、読み込みの失敗と「再試行」を出す (#2093 W4)
      const signedIn = await readSignedInUser(supabase);
      if (signedIn.kind === 'load-failed') {
        setLoadError(INVITE_LOAD_ERROR);
        return;
      }
      const user = signedIn.kind === 'signed-in' ? signedIn.user : null;
      setIsLoggedIn(user !== null);
      setCurrentEmail(user?.email ?? null);

      // invite 詳細取得 (get_invite_details RPC は認証不要 SECURITY DEFINER。招待が無ければ null を返し、例外は上げない)
      const { data, error: rpcError } = await supabase.rpc('get_invite_details', { p_token: token });

      if (rpcError) {
        // 読み込めなかった (招待が無いのとは別。「招待情報が見つかりません」と見せない)
        setLoadError(INVITE_LOAD_ERROR);
        return;
      }
      if (!data) {
        setError(INVITE_NOT_FOUND_MESSAGE);
        return;
      }

      setInvite(data as InviteDetails);
    } catch (loadFailure) {
      // 問い合わせが例外を投げた (以前は catch が無く、未処理の reject になり、確認中の表示のまま止まっていた)
      console.error('[invite] load error:', loadFailure);
      setLoadError(INVITE_LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, [token, supabase]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  /**
   * 組織の招待を承諾できていたかを自分のプロフィールで確かめる (#2080 U1。家族の招待の承諾 FamilyInviteAcceptModal と同じ型)。
   * 招待の組織に入っていれば成功のときと同じ遷移にする。入っていなければ message (確かめられなかったときは
   * 「状態を確かめられませんでした」を添える) を出す。読み直しの応答を待つあいだも「承諾する」を止めたままにする
   */
  const confirmOrgAcceptedOrShow = async (inviteOrgId: string, message: string) => {
    const state = await readInviteAcceptStateAfterFailure(supabase, 'org', inviteOrgId);
    if (state === 'joined') {
      router.push(ORG_DASHBOARD_PATH);
      return;
    }
    setOrgError(withInviteAcceptStateNote(message, state));
  };

  // org invite accept
  const handleOrgAccept = async () => {
    if (!invite) return;
    const inviteOrgId = invite.scope_id;
    setOrgError(null);
    setOrgLoading(true);
    try {
      const res = await fetch(`/api/org/invites/${token}/accept`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        const code = json.error?.code;
        switch (code) {
          case 'INVITE_EXPIRED':
            setOrgError('この招待の期限が切れています。招待者に再送を依頼してください。');
            break;
          case 'ALREADY_IN_ORG':
            setOrgError('既に組織に所属しています。');
            break;
          case 'INVITE_ALREADY_USED':
            // 前に押した承諾をサーバーが済ませてから応答が切れたときも、押し直すとこれになる (承諾の RPC は招待の
            // status = 'accepted' を先に見る)。招待の組織に入っていれば、承諾できているので成功のときと同じ遷移にする
            await confirmOrgAcceptedOrShow(inviteOrgId, ORG_INVITE_ALREADY_USED_MESSAGE);
            break;
          case 'INVITE_REVOKED':
            setOrgError('この招待は取り消されています。');
            break;
          case 'INVITE_EMAIL_MISMATCH':
            setOrgError('招待のメールアドレスと現在のアカウントが一致しません。');
            break;
          default:
            setOrgError(json.error?.message ?? '招待の承諾に失敗しました');
        }
        return;
      }
      router.push(ORG_DASHBOARD_PATH);
    } catch (err) {
      console.error('[invite] org accept error:', err);
      // サーバーが承諾を済ませてから応答が切れた (または応答の本文を読めなかった) こともあるので、
      // 自分のプロフィールを読み直して確かめる (#2080 U1)
      await confirmOrgAcceptedOrShow(inviteOrgId, ORG_NETWORK_FAILURE_MESSAGE);
    } finally {
      setOrgLoading(false);
    }
  };

  // org invite reject
  const handleOrgReject = async () => {
    setOrgLoading(true);
    try {
      await fetch(`/api/org/invites/${token}/reject`, { method: 'POST' });
      router.push('/');
    } catch {
      // エラーでも UI 側は遷移
      router.push('/');
    } finally {
      setOrgLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">招待情報を確認しています…</div>
      </div>
    );
  }

  // 読み込めなかった (招待が無いのとは別。「再試行」を出す)
  if (loadError) {
    return (
      <InviteLayout scope="organization">
        <div
          role="alert"
          data-testid="invite-load-error"
          className="max-w-sm w-full rounded-2xl bg-red-50 border border-red-200 p-6 text-center space-y-4"
        >
          <p className="text-red-700 text-sm font-medium">{loadError}</p>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void loadPage()}
              className="px-4 py-2 rounded-full bg-white border border-red-300 text-red-700 font-medium text-sm hover:bg-red-100 transition-colors"
            >
              再試行
            </button>
            <button
              type="button"
              onClick={() => router.push('/')}
              className="px-4 py-2 rounded-full bg-gray-200 text-gray-600 font-medium text-sm hover:bg-gray-300 transition-colors"
            >
              ホームへ戻る
            </button>
          </div>
        </div>
      </InviteLayout>
    );
  }

  // パターン D: invalid / expired / accepted / rejected / revoked
  if (error || !invite) {
    return (
      <InviteLayout scope="organization">
        <div className="max-w-sm w-full rounded-2xl bg-white shadow-lg border border-gray-100 p-6 text-center space-y-4">
          <div className="text-5xl">📩</div>
          <h1 className="text-xl font-bold text-gray-700">招待が見つかりません</h1>
          <p className="text-gray-500 text-sm">{error ?? '招待リンクが無効です'}</p>
          <button
            onClick={() => router.push('/')}
            className="w-full rounded-full bg-gray-200 py-3 text-gray-600 font-medium text-sm hover:bg-gray-300 transition-colors"
          >
            ホームへ戻る
          </button>
        </div>
      </InviteLayout>
    );
  }

  const scope = invite.scope === 'family' ? 'family' : 'organization';

  if (invite.status !== 'pending') {
    const statusMessages: Record<string, string> = {
      accepted: '承諾済み',
      rejected: '拒否済み',
      expired: '期限切れ',
      revoked: '取り消し済み',
    };
    return (
      <InviteLayout scope={scope}>
        <div className="max-w-sm w-full rounded-2xl bg-white shadow-lg border border-gray-100 p-6 text-center space-y-4">
          <div className="text-5xl">📩</div>
          <h1 className="text-xl font-bold text-gray-700">招待は無効です</h1>
          <p className="text-gray-500 text-sm">
            この招待は{statusMessages[invite.status] ?? invite.status}です
          </p>
          <p className="text-xs text-gray-400">招待者に再発行を依頼してください</p>
          <button
            onClick={() => router.push('/')}
            className="w-full rounded-full bg-gray-200 py-3 text-gray-600 font-medium text-sm hover:bg-gray-300 transition-colors"
          >
            ホームへ戻る
          </button>
        </div>
      </InviteLayout>
    );
  }

  // パターン A: pending + 未ログイン
  if (!isLoggedIn) {
    return (
      <InviteLayout scope={scope} scopeName={invite.scope_name} inviterName={invite.invited_by_name} expiresAt={invite.expires_at}>
        <div className="max-w-sm w-full rounded-2xl bg-white shadow-lg border border-gray-100 overflow-hidden">
          <div className="bg-green-50 px-6 py-5 border-b border-green-100">
            <div className="text-3xl mb-2">🏠</div>
            <h1 className="text-lg font-bold text-gray-900">ほめゴハン 招待</h1>
          </div>
          <div className="px-6 py-5 space-y-4">
            <p className="text-sm text-gray-500">
              この招待を承諾するにはログインまたはアカウント作成が必要です
            </p>
            <div className="space-y-2">
              <button
                onClick={() => router.push(`/login?redirect=/invite/${token}&email=${encodeURIComponent(invite.email)}`)}
                className="w-full rounded-full bg-green-500 py-3 text-white font-bold text-sm hover:bg-green-600 transition-colors"
              >
                ログインする
              </button>
              <button
                onClick={() => router.push(`/signup?redirect=/invite/${token}&email=${encodeURIComponent(invite.email)}`)}
                className="w-full rounded-full border border-green-300 py-3 text-green-600 font-medium text-sm hover:bg-green-50 transition-colors"
              >
                アカウントを作成
              </button>
            </div>
          </div>
        </div>
      </InviteLayout>
    );
  }

  // パターン C: pending + ログイン中 + email 不一致
  if (currentEmail && invite.email !== currentEmail) {
    return (
      <InviteLayout scope={scope}>
        <div className="max-w-sm w-full rounded-2xl bg-white shadow-lg border border-gray-100 p-6 space-y-4">
          <h1 className="text-lg font-bold text-gray-900">この招待は他の方宛てです</h1>
          <div className="text-sm text-gray-600 space-y-1">
            <p>招待先: <span className="font-medium">{invite.email}</span></p>
            <p>あなた: <span className="font-medium">{currentEmail}</span></p>
          </div>
          <p className="text-sm text-gray-500">正しいアカウントでログインし直してください</p>
          <button
            onClick={async () => {
              await supabase.auth.signOut();
              router.push(`/login?redirect=/invite/${token}`);
            }}
            className="w-full rounded-full bg-gray-700 py-3 text-white font-medium text-sm hover:bg-gray-800 transition-colors"
          >
            ログアウトしてやり直す
          </button>
        </div>
      </InviteLayout>
    );
  }

  // パターン B: pending + ログイン中 + email 一致 (family)
  if (invite.scope === 'family') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
        <FamilyInviteAcceptModal
          token={token}
          familyId={invite.scope_id}
          familyName={invite.scope_name}
          inviterName={invite.invited_by_name}
          expiresAt={invite.expires_at}
          onAccepted={() => router.push('/family/dashboard')}
          onRejected={() => router.push('/')}
          onDefer={() => router.push('/')}
        />
      </div>
    );
  }

  // パターン B: pending + ログイン中 + email 一致 (organization)
  return (
    <InviteLayout scope="organization" scopeName={invite.scope_name} inviterName={invite.invited_by_name} expiresAt={invite.expires_at}>
      <div className="max-w-sm w-full rounded-2xl bg-white shadow-lg border border-gray-100 overflow-hidden">
        <div className="bg-blue-50 px-6 py-5 border-b border-blue-100">
          <div className="text-3xl mb-2">🏢</div>
          <h2 className="text-lg font-bold text-gray-900">
            {invite.scope_name}への招待
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            {invite.invited_by_name} 様から招待が届いています
          </p>
        </div>

        <div className="px-6 py-5 space-y-5">
          <p className="text-xs text-gray-400">
            期限: {new Date(invite.expires_at).toLocaleDateString('ja-JP')} まで
          </p>

          {orgError && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-600">
              {orgError}
            </div>
          )}

          <div className="space-y-2">
            <button
              onClick={handleOrgAccept}
              disabled={orgLoading}
              className="w-full rounded-full bg-blue-600 py-3 text-white font-bold text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {orgLoading ? '処理中…' : '承諾する'}
            </button>

            <div className="flex gap-2">
              <button
                onClick={handleOrgReject}
                disabled={orgLoading}
                className="flex-1 rounded-full border border-red-200 py-3 text-red-500 font-medium text-sm hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                拒否する
              </button>
              <button
                onClick={() => router.push('/')}
                disabled={orgLoading}
                className="flex-1 rounded-full border border-gray-200 py-3 text-gray-500 font-medium text-sm hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                後で
              </button>
            </div>
          </div>
        </div>
      </div>
    </InviteLayout>
  );
}
