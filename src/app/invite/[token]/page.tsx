// src/app/invite/[token]/page.tsx
// (設計書 03-ui-spec.md §2.1 — 5 パターン分岐 server component)
// org/family 共通の招待受領ページ
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

// ─── 型定義 ──────────────────────────────────────────────────────────────────

type InviteScope = 'org' | 'family';

type InviteDetails = {
  scope: InviteScope;
  scopeName: string;
  inviterName: string;
  email: string;
  status: string;
  expiresAt: Date;
  token: string;
};

// ─── Service Role クライアント ────────────────────────────────────────────────

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Supabase admin env is missing');
  }
  return createAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ─── 招待詳細取得 ─────────────────────────────────────────────────────────────

async function fetchInviteDetails(token: string): Promise<InviteDetails | null> {
  const admin = getSupabaseAdmin();

  // organization_invites を検索
  const { data: orgInvite } = await admin
    .from('organization_invites')
    .select(`
      id,
      email,
      status,
      expires_at,
      invited_by,
      organization_id,
      organizations ( name )
    `)
    .eq('token', token)
    .maybeSingle() as { data: Record<string, unknown> | null };

  if (orgInvite) {
    // 招待者の表示名を取得
    const { data: inviterProfile } = await admin
      .from('user_profiles')
      .select('nickname')
      .eq('id', orgInvite.invited_by as string)
      .maybeSingle();

    const org = orgInvite.organizations as Record<string, unknown> | null;
    return {
      scope: 'org',
      scopeName: (org?.name as string) ?? '不明な組織',
      inviterName: (inviterProfile?.nickname as string) ?? '管理者',
      email: orgInvite.email as string,
      status: orgInvite.status as string,
      expiresAt: new Date(orgInvite.expires_at as string),
      token,
    };
  }

  // family_invites を検索
  const { data: familyInvite } = await admin
    .from('family_invites')
    .select(`
      id,
      email,
      status,
      expires_at,
      invited_by,
      family_id,
      family_groups ( name )
    `)
    .eq('token', token)
    .maybeSingle() as { data: Record<string, unknown> | null };

  if (familyInvite) {
    const { data: inviterProfile } = await admin
      .from('user_profiles')
      .select('nickname')
      .eq('id', familyInvite.invited_by as string)
      .maybeSingle();

    const family = familyInvite.family_groups as Record<string, unknown> | null;
    return {
      scope: 'family',
      scopeName: (family?.name as string) ?? '不明な家族グループ',
      inviterName: (inviterProfile?.nickname as string) ?? '家族メンバー',
      email: familyInvite.email as string,
      status: familyInvite.status as string,
      expiresAt: new Date(familyInvite.expires_at as string),
      token,
    };
  }

  return null;
}

// ─── ページコンポーネント ─────────────────────────────────────────────────────

export default async function InvitePage({
  params,
}: {
  params: { token: string };
}) {
  const { token } = params;

  const invite = await fetchInviteDetails(token);
  if (!invite) {
    notFound();
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const isLoggedIn = !!user;
  const now = new Date();
  const isExpired = invite.expiresAt < now;

  // ─── パターン D: 非 pending or 期限切れ ────────────────────────────────────
  if (isExpired || invite.status === 'expired') {
    return <InviteInvalid reason="期限切れ" message="この招待リンクの有効期限が切れています。招待者に再発行を依頼してください。" />;
  }
  if (invite.status === 'accepted') {
    return <InviteInvalid reason="承諾済み" message="この招待はすでに承諾済みです。" />;
  }
  if (invite.status === 'rejected') {
    return <InviteInvalid reason="拒否済み" message="この招待はすでに拒否されました。" />;
  }
  if (invite.status === 'revoked') {
    return <InviteInvalid reason="取り消し済み" message="この招待は取り消されました。" />;
  }

  // pending 以外はここで除外済み
  // status === 'pending' の場合のみ以下に進む

  const scopeLabel = invite.scope === 'org' ? '組織' : '家族グループ';
  const acceptApiPath = invite.scope === 'org'
    ? `/api/org/invites/${token}/accept`
    : `/api/family/invites/${token}/accept`;

  // ─── パターン A: pending + 未ログイン ───────────────────────────────────────
  if (!isLoggedIn) {
    const loginUrl = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
    const signupUrl = `/signup?next=${encodeURIComponent(`/invite/${token}`)}&email=${encodeURIComponent(invite.email)}`;
    return (
      <InviteLayout>
        <h1 className="text-xl font-bold mb-2">ほめゴハンへの招待</h1>
        <p className="text-gray-700 mb-4">
          <strong>{invite.inviterName}</strong> 様があなたを
          {scopeLabel}「<strong>{invite.scopeName}</strong>」に招待しています。
        </p>
        <p className="text-sm text-gray-500 mb-6">
          この招待を承諾するには、ログインまたはアカウント作成が必要です。
        </p>
        <div className="flex flex-col gap-3">
          <Link
            href={loginUrl}
            className="block w-full text-center bg-orange-500 text-white py-3 rounded-lg font-medium hover:bg-orange-600 transition"
          >
            ログインする
          </Link>
          <Link
            href={signupUrl}
            className="block w-full text-center border border-orange-500 text-orange-500 py-3 rounded-lg font-medium hover:bg-orange-50 transition"
          >
            アカウントを作成する
          </Link>
        </div>
        <p className="text-xs text-gray-400 mt-4">
          期限: {invite.expiresAt.toLocaleDateString('ja-JP')} まで
        </p>
      </InviteLayout>
    );
  }

  // ─── パターン C: pending + ログイン中 + email 不一致 ──────────────────────────
  const userEmail = user.email ?? '';
  const emailMatches = userEmail.toLowerCase() === invite.email.toLowerCase();

  if (!emailMatches) {
    return (
      <InviteLayout>
        <h1 className="text-xl font-bold mb-2">この招待は他の方宛てです</h1>
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
          <p className="text-sm">招待先: <strong>{invite.email}</strong></p>
          <p className="text-sm">あなた: <strong>{userEmail}</strong></p>
        </div>
        <p className="text-gray-600 mb-4 text-sm">
          正しいアカウントでログインし直してください。
        </p>
        <form action="/api/auth/signout" method="POST">
          <button
            type="submit"
            className="w-full bg-gray-600 text-white py-3 rounded-lg font-medium hover:bg-gray-700 transition"
          >
            ログアウトしてやり直す
          </button>
        </form>
      </InviteLayout>
    );
  }

  // ─── パターン E: 競合検出 (既所属) ────────────────────────────────────────
  // ユーザーが既に同種の所属を持っているか確認
  const { data: userProfile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single();

  // org 招待かつ既に別組織所属
  // (family は P3 で実装予定、ここでは org のみ判定)
  if (invite.scope === 'org' && userProfile?.organization_id) {
    return (
      <InviteLayout>
        <h1 className="text-xl font-bold mb-2">既に組織に所属しています</h1>
        <p className="text-gray-600 mb-4 text-sm">
          あなたは現在別の組織に所属しています。
          新しい組織に参加するには、現在の組織から脱退する必要があります。
        </p>
        <div className="flex flex-col gap-3">
          <form method="POST" action={`/api/org/leave?next=${encodeURIComponent(`/invite/${token}`)}`}>
            <button
              type="submit"
              className="w-full bg-red-500 text-white py-3 rounded-lg font-medium hover:bg-red-600 transition"
            >
              脱退して「{invite.scopeName}」に参加
            </button>
          </form>
          <form method="POST" action={`/api/org/invites/${token}/reject`}>
            <button
              type="submit"
              className="w-full border border-gray-300 text-gray-600 py-3 rounded-lg font-medium hover:bg-gray-50 transition"
            >
              今回は招待を拒否
            </button>
          </form>
        </div>
      </InviteLayout>
    );
  }

  // ─── パターン B: pending + ログイン中 + email 一致 ────────────────────────
  const dashboardPath = invite.scope === 'org' ? '/org/dashboard' : '/family/dashboard';

  return (
    <InviteLayout>
      <h1 className="text-xl font-bold mb-2">
        {invite.scope === 'org' ? '組織' : '家族グループ'}への招待
      </h1>
      <p className="text-gray-700 mb-4">
        <strong>{invite.inviterName}</strong> 様から
        {scopeLabel}「<strong>{invite.scopeName}</strong>」への招待が届いています。
      </p>
      <p className="text-xs text-gray-400 mb-6">
        期限: {invite.expiresAt.toLocaleDateString('ja-JP')} まで
      </p>
      <div className="flex flex-col gap-3">
        <form
          method="POST"
          action={acceptApiPath}
        >
          <input type="hidden" name="_redirectTo" value={dashboardPath} />
          <button
            type="submit"
            className="w-full bg-orange-500 text-white py-3 rounded-lg font-medium hover:bg-orange-600 transition"
          >
            承諾する
          </button>
        </form>
        <form method="POST" action={`/api/org/invites/${token}/reject`}>
          <button
            type="submit"
            className="w-full border border-gray-300 text-gray-500 py-3 rounded-lg font-medium hover:bg-gray-50 transition"
          >
            拒否する
          </button>
        </form>
      </div>
    </InviteLayout>
  );
}

// ─── 共通レイアウト ───────────────────────────────────────────────────────────

function InviteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 w-full max-w-sm p-6">
        <div className="text-center mb-6">
          <span className="text-2xl font-bold text-orange-500">ほめゴハン</span>
          <span className="text-sm text-gray-500 ml-2">招待</span>
        </div>
        {children}
        <p className="text-xs text-gray-400 mt-6 text-center">
          不審なメールの場合は{' '}
          <a href="mailto:support@homegohan.app" className="underline">
            support@homegohan.app
          </a>{' '}
          へご連絡ください。
        </p>
      </div>
    </div>
  );
}

// ─── エラー表示 ───────────────────────────────────────────────────────────────

function InviteInvalid({ reason, message }: { reason: string; message: string }) {
  return (
    <InviteLayout>
      <h1 className="text-xl font-bold mb-2">招待は無効です ({reason})</h1>
      <p className="text-gray-600 mb-4 text-sm">{message}</p>
      <Link
        href="/"
        className="block w-full text-center bg-orange-500 text-white py-3 rounded-lg font-medium hover:bg-orange-600 transition"
      >
        ホームへ戻る
      </Link>
    </InviteLayout>
  );
}
