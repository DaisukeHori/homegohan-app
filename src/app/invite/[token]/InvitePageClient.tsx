'use client';

// src/app/invite/[token]/InvitePageClient.tsx
// (設計書 03-ui-spec.md §2 — 5 パターン分岐)
// org/family 共通版: scope ('family'|'organization') による分岐
//
// Round-3 レビュー指摘 #2: token/initialIsNativeApp は page.tsx (Server Component) が
// params と cookies() から読んで渡す。

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useNativeAppMode } from '@/hooks/useNativeAppMode';
import { FamilyInviteAcceptModal } from '@/components/membership/FamilyInviteAcceptModal';
import { InviteLayout } from '@/components/membership/InviteLayout';

interface InviteDetails {
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'revoked';
  // get_invite_details RPC (supabase/migrations/20260511000133_membership_remaining_rpcs.sql) の実返却キーに合わせる
  scope: 'family' | 'organization';
  email: string;
  scope_name: string;
  invited_by_name: string;
  expires_at: string;
  is_existing_user?: boolean;
}

interface Props {
  token: string;
  initialIsNativeApp?: boolean;
}

export function InvitePageClient({ token, initialIsNativeApp }: Props) {
  const router = useRouter();
  const supabase = createClient();
  // Round-3 レビュー指摘 #2: #1037 core bug と同種の native セッション破壊
  // (WebView 経由の signOut がネイティブと共有する refresh token を無効化してしまう) を
  // このページの「ログアウトしてやり直す」ボタンでも防ぐために使用する。
  const isNativeApp = useNativeAppMode(initialIsNativeApp);

  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // org accept/reject state
  const [orgLoading, setOrgLoading] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      // 認証状態確認
      const { data: { user } } = await supabase.auth.getUser();
      setIsLoggedIn(!!user);
      setCurrentEmail(user?.email ?? null);

      // invite 詳細取得 (get_invite_details RPC は認証不要 SECURITY DEFINER)
      const { data, error: rpcError } = await supabase.rpc('get_invite_details', { p_token: token });

      if (rpcError || !data) {
        setError('招待情報が見つかりません');
        setLoading(false);
        return;
      }

      setInvite(data as InviteDetails);
      setLoading(false);
    };

    init();
  }, [token, supabase]);

  // org invite accept
  const handleOrgAccept = async () => {
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
            setOrgError('この招待は既に使用済みです。');
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
      router.push('/org/dashboard');
    } catch {
      setOrgError('通信エラーが発生しました');
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
              // Round-3 レビュー指摘 #2: native アプリ内 (WebView) では supabase.auth.signOut()
              // を呼ぶと、ネイティブ側と共有している refresh token がサーバー側で無効化され、
              // #1037 core bug と同種の native セッション破壊が起きるため呼ばない。
              // ログイン画面へ遷移するだけでも、そこでのログインが現在のセッションを
              // 安全に上書きするため支障はない。
              if (!isNativeApp) {
                await supabase.auth.signOut();
              }
              router.push(`/login?redirect=/invite/${token}`);
            }}
            className="w-full rounded-full bg-gray-700 py-3 text-white font-medium text-sm hover:bg-gray-800 transition-colors"
          >
            {isNativeApp ? 'ログインし直す' : 'ログアウトしてやり直す'}
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
