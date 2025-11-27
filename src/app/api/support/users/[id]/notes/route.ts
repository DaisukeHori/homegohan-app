import { createClient } from '@/lib/supabase/server';
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
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin', 'support'].includes(profile.role)) {
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
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action_type: 'add_user_note',
        target_id: params.id,
        details: { noteId: data.id },
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
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin', 'support'].includes(profile.role)) {
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

    return NextResponse.json({
      notes: (notes || []).map((n: any) => ({
        id: n.id,
        note: n.note,
        createdAt: n.created_at,
        adminId: n.admin_id,
        adminName: n.user_profiles?.nickname || 'Unknown',
      })),
    });

  } catch (error: any) {
    console.error('Notes fetch error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

