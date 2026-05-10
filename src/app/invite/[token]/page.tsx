'use client';

// src/app/invite/[token]/page.tsx
// (設計書 03-ui-spec.md §2 — 5 パターン分岐)
// P1 が org/family 共通版を作成予定。P3 では family 招待を優先実装。
// P1 との merge 時: invite_type ('family'|'organization') による分岐を追加。

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { FamilyInviteAcceptModal } from '@/components/membership/FamilyInviteAcceptModal';

interface InviteDetails {
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'revoked';
  invite_type: 'family' | 'organization';
  email: string;
  scope_name: string;
  inviter_name: string;
  expires_at: string;
  custom_message: string | null;
}

type PageProps = {
  params: Promise<{ token: string }>;
};

export default function InvitePage({ params }: PageProps) {
  const { token } = use(params);
  const router = useRouter();
  const supabase = createClient();

  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div className="text-5xl">📩</div>
        <h1 className="text-xl font-bold text-gray-700">招待が見つかりません</h1>
        <p className="text-gray-500 text-sm text-center">
          {error ?? '招待リンクが無効です'}
        </p>
        <button
          onClick={() => router.push('/')}
          className="mt-2 px-6 py-3 rounded-full bg-green-500 text-white font-medium text-sm"
        >
          ホームへ戻る
        </button>
      </div>
    );
  }

  if (invite.status !== 'pending') {
    const statusMessages: Record<string, string> = {
      accepted: '承諾済み',
      rejected: '拒否済み',
      expired: '期限切れ',
      revoked: '取り消し済み',
    };
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div className="text-5xl">📩</div>
        <h1 className="text-xl font-bold text-gray-700">招待は無効です</h1>
        <p className="text-gray-500 text-sm text-center">
          この招待は{statusMessages[invite.status] ?? invite.status}です
        </p>
        <button
          onClick={() => router.push('/')}
          className="mt-2 px-6 py-3 rounded-full bg-gray-200 text-gray-600 font-medium text-sm"
        >
          ホームへ戻る
        </button>
      </div>
    );
  }

  // パターン A: pending + 未ログイン
  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
        <div className="max-w-sm w-full rounded-2xl bg-white shadow-lg border border-gray-100 overflow-hidden">
          <div className="bg-green-50 px-6 py-5 border-b border-green-100">
            <div className="text-3xl mb-2">🏠</div>
            <h1 className="text-lg font-bold text-gray-900">ほめゴハン 招待</h1>
          </div>
          <div className="px-6 py-5 space-y-4">
            <p className="text-sm text-gray-700">
              <span className="font-medium">{invite.inviter_name}</span> 様から
              「<span className="font-medium">{invite.scope_name}</span>」
              {invite.invite_type === 'family' ? '家族グループ' : '組織'}への招待が届いています
            </p>
            <p className="text-xs text-gray-400">
              期限: {new Date(invite.expires_at).toLocaleDateString('ja-JP')} まで
            </p>
            <p className="text-sm text-gray-500">
              この招待を承諾するにはログインまたはアカウント作成が必要です
            </p>
            <div className="space-y-2">
              <button
                onClick={() => router.push(`/login?redirect=/invite/${token}`)}
                className="w-full rounded-full bg-green-500 py-3 text-white font-bold text-sm hover:bg-green-600 transition-colors"
              >
                ログインする
              </button>
              <button
                onClick={() => router.push(`/signup?redirect=/invite/${token}`)}
                className="w-full rounded-full border border-green-300 py-3 text-green-600 font-medium text-sm hover:bg-green-50 transition-colors"
              >
                アカウントを作成
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // パターン C: pending + ログイン中 + email 不一致
  if (currentEmail && invite.email !== currentEmail) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
        <div className="max-w-sm w-full rounded-2xl bg-white shadow-lg border border-gray-100 overflow-hidden">
          <div className="px-6 py-6 space-y-4">
            <h1 className="text-lg font-bold text-gray-900">この招待は他の方宛てです</h1>
            <div className="text-sm text-gray-600 space-y-1">
              <p>招待先: <span className="font-medium">{invite.email}</span></p>
              <p>あなた: <span className="font-medium">{currentEmail}</span></p>
            </div>
            <p className="text-sm text-gray-500">
              正しいアカウントでログインし直してください
            </p>
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
        </div>
      </div>
    );
  }

  // パターン B: pending + ログイン中 + email 一致 (family)
  if (invite.invite_type === 'family') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
        <FamilyInviteAcceptModal
          token={token}
          familyName={invite.scope_name}
          inviterName={invite.inviter_name}
          expiresAt={invite.expires_at}
          onAccepted={() => router.push('/family/dashboard')}
          onRejected={() => router.push('/')}
          onDefer={() => router.push('/')}
        />
      </div>
    );
  }

  // org 招待 (P1 が実装予定 — フォールバック)
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
      <div className="text-5xl">🏢</div>
      <h1 className="text-xl font-bold text-gray-700">組織への招待</h1>
      <p className="text-gray-500 text-sm text-center">
        「{invite.scope_name}」からの招待です (P1 で実装予定)
      </p>
      <button
        onClick={() => router.push('/')}
        className="mt-2 px-6 py-3 rounded-full bg-gray-200 text-gray-600 font-medium text-sm"
      >
        ホームへ戻る
      </button>
    </div>
  );
}
