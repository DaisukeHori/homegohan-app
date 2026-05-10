// src/app/api/auth/signup-and-accept-invite/route.ts
// (設計書 02-flow-spec.md §2 — 新規ユーザ用 α-4 fixture)
// signUp + signIn + accept_org_invite を一括実行
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

const SignupAndAcceptBodySchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, 'invalid token format'),
  password: z.string().min(8, 'パスワードは8文字以上で入力してください'),
});

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('Supabase admin env is missing');
  return createAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function POST(request: Request) {
  let body: z.infer<typeof SignupAndAcceptBodySchema>;
  try {
    const raw = await request.json();
    body = SignupAndAcceptBodySchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: err.issues[0]?.message ?? 'Invalid request' } },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid JSON' } }, { status: 400 });
  }

  const { token, password } = body;

  // token から email を取得 (service_role で直接クエリ)
  const admin = getSupabaseAdmin();
  const { data: inviteRow, error: inviteErr } = await admin
    .from('organization_invites')
    .select('email, status, expires_at')
    .eq('token', token)
    .maybeSingle() as { data: Record<string, unknown> | null; error: unknown };

  if (inviteErr || !inviteRow) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.INVITE_NOT_FOUND, message: '招待が見つかりません' } },
      { status: 404 },
    );
  }

  if (inviteRow.status !== 'pending' || new Date(inviteRow.expires_at as string) < new Date()) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.INVITE_EXPIRED, message: '招待の有効期限が切れているか、すでに処理済みです' } },
      { status: 410 },
    );
  }

  const email = inviteRow.email as string;

  // Step 1: signUp (email_confirm: false で即時有効化)
  const { data: signUpData, error: signUpError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,  // 即時有効化
  });

  if (signUpError) {
    if (signUpError.message.includes('already registered') || signUpError.message.includes('already exists')) {
      return NextResponse.json(
        { error: { code: 'EMAIL_ALREADY_REGISTERED', message: 'このメールアドレスはすでに登録済みです。ログインしてください。' } },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: signUpError.message } },
      { status: 500 },
    );
  }

  const userId = signUpData.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: 'ユーザー作成に失敗しました' } },
      { status: 500 },
    );
  }

  // Step 2: signInWithPassword でセッション取得
  const supabase = await createClient();
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData.session) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: 'ログインに失敗しました' } },
      { status: 500 },
    );
  }

  // Step 3: accept_org_invite RPC (セッション付き supabase クライアントで呼ぶ)
  const { data, error: acceptError } = await (supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>)(
    'accept_org_invite',
    { p_token: token },
  );

  if (acceptError) {
    const msg = acceptError.message ?? '';
    let code: string = MembershipErrorCode.RPC_FAILED;
    let status = 500;
    if (msg.includes('INVITE_NOT_FOUND'))    { code = MembershipErrorCode.INVITE_NOT_FOUND; status = 404; }
    if (msg.includes('INVITE_EXPIRED'))      { code = MembershipErrorCode.INVITE_EXPIRED; status = 410; }
    if (msg.includes('ALREADY_IN_ORG'))      { code = MembershipErrorCode.ALREADY_IN_ORG; status = 409; }

    return NextResponse.json({ error: { code, message: msg } }, { status });
  }

  const profile = data as { organization_id: string; org_role: string };

  return NextResponse.json({
    data: {
      user_id: userId,
      organization_id: profile.organization_id,
      org_role: profile.org_role,
    },
  });
}
