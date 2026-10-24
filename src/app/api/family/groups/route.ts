// src/app/api/family/groups/route.ts
// (設計書 02-flow-spec.md §6, 06-implementation-phases.md P3)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { CreateFamilyGroupBodySchema } from '@/schemas/membership/family-group';
import { ErrorStatusMap, MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
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

  const { name } = parsed.data;

  // RPC: create_family_group
  // 内部で ALREADY_IN_FAMILY チェックを行う
  // プランは渡さない: グループの plan_key / member_limit は DB のトリガーが代表者の契約に合わせて決める (#1797 段 D)
  const { data, error } = await supabase.rpc('create_family_group', {
    p_name: name,
  });

  if (error) {
    // Supabase RPC エラーコードをマッピング
    if (error.message?.includes(MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED)) {
      // #1173: 18 歳未満の本人は家族を作れない・招待から入れない (DB の関数が先頭で断る)。DB の生の文は出さない
      return NextResponse.json(
        {
          error: {
            code: MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED,
            message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED],
          },
        },
        { status: 403 },
      );
    }
    // billing/03 §9.5: 家族プランの契約が無い代表者のグループは作れない (DB の門が FAMILY_PLAN_REQUIRED を RAISE する)。DB の生の文は出さない
    if ((error.message ?? '').includes(MembershipErrorCode.FAMILY_PLAN_REQUIRED)) {
      return NextResponse.json(
        {
          error: {
            code: MembershipErrorCode.FAMILY_PLAN_REQUIRED,
            message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.FAMILY_PLAN_REQUIRED],
          },
        },
        { status: ErrorStatusMap[MembershipErrorCode.FAMILY_PLAN_REQUIRED] },
      );
    }
    // #1917 の続き: 退会の手続き中の本人は家族を作れない (家族の行のトリガー trg_representative_not_deleting (関数 family_groups_representative_not_deleting) が止める。
    // 作ると、退会の最後のアカウントの削除が代表者の外部キーで失敗する)。DB の生の文は出さない
    if ((error.message ?? '').includes(MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING)) {
      return NextResponse.json(
        {
          error: {
            code: MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING,
            message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING],
          },
        },
        { status: ErrorStatusMap[MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING] },
      );
    }
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
