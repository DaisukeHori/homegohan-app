/**
 * GET /api/admin/users/{id} — ユーザー詳細
 *   (#1200: 情報を返すたびに admin_audit_logs へ admin.user.view を記録する)
 * PATCH /api/admin/users/{id} — 管理ノート (admin_note) の追加 (#1103。保存先は admin_user_notes)
 * operator/02-api-spec.md §4 準拠
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { UserPatchBodySchema } from '@/lib/admin/users-schemas';
import { recordAdminAudit } from '@/lib/admin/audit';
import { canViewUserEmail, fetchUserEmails } from '@/lib/admin/user-emails';
import { isAccountFrozen } from '@/lib/auth/frozen';
import { internalError } from '@/lib/api/errors';
import { isUuid, readJsonBody } from '@/lib/http-params';

export const dynamic = 'force-dynamic';

/** ログの発生元 (src/lib/admin/user-emails.ts がメール取得の失敗を記録するときに使う) */
const LOG_SOURCE = 'GET /api/admin/users/[id]';
/** PATCH の構造化ログ・監査ログ失敗時の発生元 */
const PATCH_ROUTE_NAME = 'PATCH /api/admin/users/[id]';

type Params = { params: { id: string } };

export async function GET(request: Request, { params }: Params) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'support']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
        { status: 403 },
      );
    }
    throw err;
  }

  const { id } = params;
  // requireRole 通過後のみ到達する。RLS は user_profiles に自分の行のみの
  // ポリシーしか無いため、他ユーザーの詳細取得には service_role が必須 (#1028)。
  const supabaseAdmin = getSupabaseAdmin();
  // support_tickets / personal_subscriptions / admin_audit_logs は本 Issue の対象外
  // (既存の RLS・graceful degradation のまま session client を使用)。
  const supabase = await createClient();

  // ユーザープロファイル取得
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('*')
    .eq('id', id)
    .single();

  if (profileError || !profile) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } },
      { status: 404 },
    );
  }

  // メールアドレス (#1145): 見てよいのは admin / super_admin だけ。support には引かず null。
  // この 1 件のぶんだけを service_role 専用の RPC で auth.users から引く。
  // 引けなかった (メールを持たない / 取得に失敗した) ときも null。
  const email = canViewUserEmail(actor.roles)
    ? ((await fetchUserEmails(supabaseAdmin, [profile.id], LOG_SOURCE)).get(profile.id) ?? null)
    : null;

  // サポートチケット数 (テーブルが存在する場合)
  let supportTicketCount = 0;
  try {
    const { count } = await supabase
      .from('support_tickets')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', id);
    supportTicketCount = count ?? 0;
  } catch {
    // support_tickets テーブルが未作成の場合は 0 を返す
  }

  // アクティブサブスクリプション
  let activeSubscription = null;
  try {
    const { data: sub } = await supabase
      .from('personal_subscriptions')
      .select('plan_key, status, current_period_end')
      .eq('user_id', id)
      .in('status', ['active', 'trialing', 'paused', 'past_due', 'grace'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sub) {
      activeSubscription = {
        plan_key: sub.plan_key,
        status: sub.status,
        next_billing_at: sub.current_period_end,
      };
    }
  } catch {
    // personal_subscriptions テーブルが未作成の場合
  }

  // BAN 履歴 (admin_audit_logs から取得)
  let banHistory: unknown[] = [];
  try {
    const { data: banLogs } = await supabase
      .from('admin_audit_logs')
      .select('*')
      .eq('target_id', id)
      .in('action_type', ['admin.user.ban', 'admin.user.unban', 'admin.user.freeze', 'admin.user.unfreeze'])
      .order('created_at', { ascending: false })
      .limit(20);
    banHistory = banLogs ?? [];
  } catch {
    // actor が super_admin でない場合は SELECT 権限なし
  }

  // 監査ログ (actor が super_admin のみ閲覧可能)
  const auditLogs = actor.roles.includes('super_admin') ? banHistory : [];

  void auditLogs; // 現在は ban_history として返す

  const body = {
    data: {
      id: profile.id,
      email,
      nickname: profile.nickname,
      roles: profile.roles ?? ['user'],
      plan_key: profile.plan_key_cached ?? 'free',
      organization_id: profile.organization_id,
      family_group_ids: [],
      stats: {
        meal_count: 0,
        ai_session_count: 0,
        health_checkup_count: 0,
        last_meal_at: null,
      },
      ban_history: banHistory,
      support_ticket_count: supportTicketCount,
      active_subscription: activeSubscription,
      // #1030: 一時 BAN は unban_at 経過後に自動解除扱いとする (判定時比較)。
      // frozen_at が NOT NULL のままでも unban_at が過去なら is_banned=false を返す。
      is_banned: isAccountFrozen({
        frozenAt: (profile as { frozen_at?: string | null }).frozen_at ?? null,
        unbanAt: (profile as { unban_at?: string | null }).unban_at ?? null,
      }),
      frozen_at: (profile as { frozen_at?: string | null }).frozen_at ?? null,
      frozen_reason: (profile as { frozen_reason?: string | null }).frozen_reason ?? null,
      frozen_by: (profile as { frozen_by?: string | null }).frozen_by ?? null,
      unban_at: (profile as { unban_at?: string | null }).unban_at ?? null,
      last_login_at: profile.last_login_at ?? null,
      registered_at: profile.created_at,
    },
  };

  // #1200: 他ユーザーの情報を返す前に、誰が誰を閲覧したかを監査ログへ残す。
  // 404 (対象なし) は上で返しているため、ここに来るのは情報を返すときだけ。
  // 記録に失敗しても閲覧は止めない (失敗は db-logger に error で残る)。
  // details には返した項目名 (値が null の項目も含む) だけを入れ、値や email は入れない。
  await recordAdminAudit({
    supabase,
    actorId: actor.id,
    actionType: 'admin.user.view',
    targetId: id,
    targetType: 'user',
    details: { viewed_fields: Object.keys(body.data) },
    request,
    routeName: 'api/admin/users/[id] GET',
  });

  const response = NextResponse.json(body);
  // メールアドレスを含むため、共有キャッシュに残さない
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * PATCH /api/admin/users/{id} — 管理ノート (admin note) の追加
 *
 * #1103 (項目 5): 以前は user_profiles.admin_note 列へ UPDATE していたが、その列は本番にもリポジトリにも無く、
 * 常に「column does not exist」で 500 になっていた。列を足さずに、運営の内部メモの保存先である
 * admin_user_notes (サポート画面のユーザーノートと同じ表) に 1 行追加する。
 *   - user_profiles に列を足すと、本人の行を読む RLS (自分の行は全列が読める) と select('*') で、
 *     運営が書いた内部メモを利用者本人が読めてしまう。admin_user_notes は運営ロールだけが読み書きでき
 *     (RLS)、アカウントのデータ書き出しからも外してある (src/lib/account-export-tables.ts)。
 *   - 監査ログの種別は設計書 (operator/07-audit-monitoring.md §4.1) の admin.user.note_add。
 *     details にはノートの ID だけを入れ、本文は入れない (POST /api/support/users/[id]/notes と同じ)。
 * リクエストの形 ({ admin_note }) と権限 (admin / super_admin) は operator/02-api-spec.md のまま。
 */
export async function PATCH(request: Request, { params }: Params) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
        { status: 403 },
      );
    }
    throw err;
  }

  const { id } = params;
  // uuid 型の列に UUID でない文字列を渡すと 22P02 になり、存在しない id なのに 500 になる
  if (!isUuid(id)) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } },
      { status: 404 },
    );
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parseResult = UserPatchBodySchema.safeParse(parsedBody.body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { admin_note } = parseResult.data;

  // 対象ユーザーの存在確認。user_profiles は RLS で本人の行しか見えないため、
  // requireRole を通したあとだけ service_role で、対象の id に絞って引く (#1028)。
  const { data: target, error: targetError } = await getSupabaseAdmin()
    .from('user_profiles')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (targetError) {
    return internalError(PATCH_ROUTE_NAME, targetError, { userId: actor.id, table: 'user_profiles' }, { shape: 'nested' });
  }
  if (!target) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } },
      { status: 404 },
    );
  }

  // ノートを追加する。admin_user_notes の RLS は運営ロール (admin / super_admin / support) に読み書きを許しているため、
  // 操作した本人のセッションの client で書く (admin_id は auth.uid() と同じ本人の ID)。
  const supabase = await createClient();
  const { data: note, error: insertError } = await supabase
    .from('admin_user_notes')
    .insert({ user_id: id, admin_id: actor.id, note: admin_note })
    .select('id')
    .single();

  if (insertError || !note) {
    return internalError(
      PATCH_ROUTE_NAME,
      insertError ?? new Error('admin_user_notes の追加結果が空でした'),
      { userId: actor.id, table: 'admin_user_notes' },
      { shape: 'nested' },
    );
  }

  // 監査ログ (失敗しても追加は取り消さない。失敗は db-logger に error で残る)
  await recordAdminAudit({
    supabase,
    actorId: actor.id,
    actionType: 'admin.user.note_add',
    targetId: id,
    targetType: 'user',
    details: { note_id: note.id },
    request,
    routeName: PATCH_ROUTE_NAME,
  });

  return NextResponse.json({ data: { success: true, note_id: note.id } });
}
