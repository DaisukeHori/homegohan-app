import { createClient } from '@/lib/supabase/server';
import { recordAdminAudit } from '@/lib/admin/audit';
import { NextResponse } from 'next/server';

// ユーザーノート追加
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // サポート権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || !profile?.roles?.some((r: string) => ['admin', 'super_admin', 'support'].includes(r))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { note } = body;

    if (!note || note.trim().length === 0) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 });
    }

    // ターゲットユーザーの存在確認
    const { data: targetUser } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('id', params.id)
      .single();

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // ノート追加
    const { data, error } = await supabase
      .from('admin_user_notes')
      .insert({
        user_id: params.id,
        admin_id: user.id,
        note: note.trim(),
      })
      .select()
      .single();

    if (error) throw error;

    // 監査ログ
    // #1200: 以前は存在しない列 admin_id (正しくは actor_id) に書いており、戻りの error も
    // 見ていなかったため、ノート追加の監査は一度も記録されていなかった。
    // action_type も設計書 (07-audit-monitoring.md §4.1) の admin.user.note_add に揃える。
    await recordAdminAudit({
      supabase,
      actorId: user.id,
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

  } catch (error: any) {
    console.error('Note creation error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// ノート一覧取得
// #1200: ノートを 1 件以上返したときは、admin_audit_logs へ admin.user.view_notes を記録する
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // サポート権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || !profile?.roles?.some((r: string) => ['admin', 'super_admin', 'support'].includes(r))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { data: notes, error } = await supabase
      .from('admin_user_notes')
      .select(`
        id,
        note,
        created_at,
        admin_id,
        user_profiles!admin_user_notes_admin_id_fkey(nickname)
      `)
      .eq('user_id', params.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const responseNotes = (notes || []).map((n: any) => ({
      id: n.id,
      note: n.note,
      createdAt: n.created_at,
      adminId: n.admin_id,
      adminName: n.user_profiles?.nickname || 'Unknown',
    }));

    // #1200: 他ユーザーについての管理ノートを返す前に、誰が誰のノートを閲覧したかを残す。
    // 返すノートが 0 件のときは何も開示していないため記録しない。
    // 記録に失敗しても閲覧は止めない (失敗は db-logger に error で残る)。
    // details にはノートの本文ではなく項目名だけを入れる。
    if (responseNotes.length > 0) {
      await recordAdminAudit({
        supabase,
        actorId: user.id,
        actionType: 'admin.user.view_notes',
        targetId: params.id,
        targetType: 'user',
        details: { viewed_fields: Object.keys(responseNotes[0]) },
        request,
        routeName: 'api/support/users/[id]/notes GET',
      });
    }

    return NextResponse.json({ notes: responseNotes });

  } catch (error: any) {
    console.error('Notes fetch error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

