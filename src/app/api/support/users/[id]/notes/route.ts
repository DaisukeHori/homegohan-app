import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { API_INVALID_JSON_MESSAGE, API_INTERNAL_ERROR_MESSAGE, authFailureFlat } from '@/lib/api/error-responses';
import { recordAdminAudit } from '@/lib/admin/audit';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { isUuid, readJsonBody } from '@/lib/http-params';
import { normalizeProfileName } from '@/lib/profile-name';
import { NextResponse } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';

// 権限: support / admin / super_admin (共通の requireRole()、#1161)

/** 404: 対象の利用者がいない (UUID の形でない id を含む) */
const USER_NOT_FOUND_MESSAGE = 'ユーザーが見つかりません';

/** 400: メモの本文が空 (空白だけを含む) */
const NOTE_REQUIRED_MESSAGE = 'メモの内容を入力してください';

/**
 * 500 の本文は汎用メッセージだけにする (#1172: Supabase / Postgres の生のエラー文を返さない)。
 * 詳細は db-logger (app_logs) にだけ残す。
 */
function internalError(method: 'GET' | 'POST', err: unknown, metadata?: Record<string, unknown>) {
  createLogger(`${method} /api/support/users/[id]/notes`, generateRequestId()).error(
    'サポート用ユーザーノートの処理に失敗しました',
    err,
    metadata,
  );
  return NextResponse.json({ error: API_INTERNAL_ERROR_MESSAGE }, { status: 500 });
}

// ユーザーノート追加
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const actor = await requireRole(['support', 'admin', 'super_admin']);

    // uuid 型の列に UUID でない文字列を渡すと 22P02 になり、存在しない id なのに 500 になる
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: USER_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const rawNote = (parsedBody.body as { note?: unknown } | null)?.note;
    const note = typeof rawNote === 'string' ? rawNote.trim() : '';

    if (note.length === 0) {
      return NextResponse.json({ error: NOTE_REQUIRED_MESSAGE }, { status: 400 });
    }

    // ターゲットユーザーの存在確認
    // user_profiles は RLS で本人の行しか見えないため、認可を通したあとだけ service_role で引く
    const { data: targetUser, error: targetError } = await getSupabaseAdmin()
      .from('user_profiles')
      .select('id')
      .eq('id', params.id)
      .maybeSingle();

    if (targetError) {
      return internalError('POST', new Error(targetError.message), {
        failed_queries: ['user_profiles (target)'],
        error_code: targetError.code,
      });
    }
    if (!targetUser) {
      return NextResponse.json({ error: USER_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // ノート追加。admin_user_notes の書き込みは service_role だけ (運営の直接の書き込みを塞いだ。#1917 の続き)。
    // requireRole を通したあとだけ書く。監査ログは本人のセッションの client で書く
    const supabase = await createClient();
    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { data, error } = await getSupabaseAdmin()
      .from('admin_user_notes')
      .insert({
        user_id: params.id,
        admin_id: actor.id,
        note,
      })
      .select()
      .single();

    if (error) {
      return internalError('POST', new Error(error.message), {
        failed_queries: ['admin_user_notes (insert)'],
        error_code: error.code,
      });
    }

    // 監査ログ
    // #1200: 以前は存在しない列 admin_id (正しくは actor_id) に書いており、戻りの error も
    // 見ていなかったため、ノート追加の監査は一度も記録されていなかった。
    // action_type も設計書 (07-audit-monitoring.md §4.1) の admin.user.note_add に揃える。
    await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: 'admin.user.note_add',
      targetId: params.id,
      targetType: 'user',
      details: { note_id: data.id },
      request,
      routeName: 'api/support/users/[id]/notes POST',
    });

    return NextResponse.json({
      success: true,
      note: {
        id: data.id,
        note: data.note,
        createdAt: data.created_at,
      },
    });

  } catch (error) {
    const authFailure = authFailureFlat(error);
    if (authFailure) return authFailure;
    return internalError('POST', error);
  }
}

// ノート一覧取得
// #1200: ノートを 1 件以上返したときは、admin_audit_logs へ admin.user.view_notes を記録する
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const actor = await requireRole(['support', 'admin', 'super_admin']);

    if (!isUuid(params.id)) {
      return NextResponse.json({ error: USER_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // 認可を通したあとだけ service_role で読む (user_profiles は RLS で本人の行しか見えない)
    const supabaseAdmin = getSupabaseAdmin();

    // admin_user_notes.admin_id の外部キーは auth.users 宛で user_profiles とは繋がっていないため、
    // user_profiles!admin_user_notes_admin_id_fkey(nickname) の埋め込みは PostgREST が解決できず、
    // この GET は常に失敗していた。書いた人のニックネームは下で別に引く
    // 書いた日時の新しい順。同じ日時は id の順 (#2139 T1)
    const { data: notes, error } = await orderListBy(
      supabaseAdmin
        .from('admin_user_notes')
        .select(`
        id,
        note,
        created_at,
        admin_id
      `)
        .eq('user_id', params.id),
      LIST_ORDERS.supportUserNotes,
    );

    if (error) {
      return internalError('GET', new Error(error.message), {
        failed_queries: ['admin_user_notes'],
        error_code: error.code,
      });
    }

    const noteRows = notes || [];
    const adminIds = Array.from(
      new Set(noteRows.map((n: any) => n.admin_id).filter((id: unknown): id is string => !!id)),
    );
    const nicknameById = new Map<string, string | null>();
    if (adminIds.length > 0) {
      const { data: admins, error: adminsError } = await supabaseAdmin
        .from('user_profiles')
        .select('id, nickname')
        .in('id', adminIds);
      if (adminsError) {
        return internalError('GET', new Error(adminsError.message), {
          failed_queries: ['user_profiles (note authors)'],
          error_code: adminsError.code,
        });
      }
      // 名前が無い (空・空白だけ・仮置きの 'Guest') 管理者は null で持ち、下で既定の文言 'Unknown' にする (#1649)
      (admins || []).forEach((a: { id: string; nickname: string | null }) =>
        nicknameById.set(a.id, normalizeProfileName(a.nickname)),
      );
    }

    const responseNotes = noteRows.map((n: any) => ({
      id: n.id,
      note: n.note,
      createdAt: n.created_at,
      adminId: n.admin_id,
      adminName: (n.admin_id && nicknameById.get(n.admin_id)) || 'Unknown',
    }));

    // #1200: 他ユーザーについての管理ノートを返す前に、誰が誰のノートを閲覧したかを残す。
    // 返すノートが 0 件のときは何も開示していないため記録しない。
    // 記録に失敗しても閲覧は止めない (失敗は db-logger に error で残る)。
    // details にはノートの本文ではなく項目名だけを入れる。
    // 監査ログの INSERT は RLS (actor_id = auth.uid() かつ運営ロール) を通すため、本人のセッションの client で行う。
    if (responseNotes.length > 0) {
      await recordAdminAudit({
        supabase: await createClient(),
        actorId: actor.id,
        actionType: 'admin.user.view_notes',
        targetId: params.id,
        targetType: 'user',
        details: { viewed_fields: Object.keys(responseNotes[0]) },
        request,
        routeName: 'api/support/users/[id]/notes GET',
      });
    }

    return NextResponse.json({ notes: responseNotes });

  } catch (error) {
    const authFailure = authFailureFlat(error);
    if (authFailure) return authFailure;
    return internalError('GET', error);
  }
}
