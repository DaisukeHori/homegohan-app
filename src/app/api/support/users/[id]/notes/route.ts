import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { isUuid, readJsonBody } from '@/lib/http-params';
import { NextResponse } from 'next/server';

// 権限: support / admin / super_admin (共通の requireRole()、#1161)

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
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// ユーザーノート追加
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const actor = await requireRole(['support', 'admin', 'super_admin']);

    // uuid 型の列に UUID でない文字列を渡すと 22P02 になり、存在しない id なのに 500 になる
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const rawNote = (parsedBody.body as { note?: unknown } | null)?.note;
    const note = typeof rawNote === 'string' ? rawNote.trim() : '';

    if (note.length === 0) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 });
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
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // ノート追加 (admin_user_notes の RLS は運営ロールに許しているので、本人のセッションの client で書く)
    const supabase = await createClient();
    const { data, error } = await supabase
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
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return internalError('POST', error);
  }
}

// ノート一覧取得
// #1200: ノートを 1 件以上返したときは、admin_audit_logs へ admin.user.view_notes を記録する
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const actor = await requireRole(['support', 'admin', 'super_admin']);

    if (!isUuid(params.id)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // 認可を通したあとだけ service_role で読む (user_profiles は RLS で本人の行しか見えない)
    const supabaseAdmin = getSupabaseAdmin();

    // admin_user_notes.admin_id の外部キーは auth.users 宛で user_profiles とは繋がっていないため、
    // user_profiles!admin_user_notes_admin_id_fkey(nickname) の埋め込みは PostgREST が解決できず、
    // この GET は常に失敗していた。書いた人のニックネームは下で別に引く
    const { data: notes, error } = await supabaseAdmin
      .from('admin_user_notes')
      .select(`
        id,
        note,
        created_at,
        admin_id
      `)
      .eq('user_id', params.id)
      .order('created_at', { ascending: false });

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
      (admins || []).forEach((a: any) => nicknameById.set(a.id, a.nickname));
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
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return internalError('GET', error);
  }
}
