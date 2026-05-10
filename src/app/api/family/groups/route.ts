// src/app/api/family/groups/route.ts
// (設計書 02-flow-spec.md §6, 06-implementation-phases.md P3)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { CreateFamilyGroupBodySchema } from '@/schemas/membership/family-group';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

export async function POST(request: Request) {
  const supabase = await createClient();

  // 認証チェック
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  // リクエスト検証
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parsed = CreateFamilyGroupBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: '入力値が不正です',
          details: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 400 },
    );
  }

  const { name, plan_key } = parsed.data;

  // RPC: create_family_group
  // 内部で ALREADY_IN_FAMILY チェックを行う
  const { data, error } = await supabase.rpc('create_family_group', {
    p_name: name,
    p_plan_key: plan_key,
  });

  if (error) {
    // Supabase RPC エラーコードをマッピング
    if (error.message?.includes('ALREADY_IN_FAMILY')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.ALREADY_IN_FAMILY, message: '既に家族グループに所属しています' } },
        { status: 409 },
      );
    }
    console.error('[api/family/groups] RPC error:', error);
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: '家族グループの作成に失敗しました' } },
      { status: 500 },
    );
  }

  return NextResponse.json({ data: { family_group: data } }, { status: 201 });
}
