import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// モデレーション対応（解決/却下）
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || !profile?.roles?.some((r: string) => ['admin', 'super_admin'].includes(r))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { type, action, note, deleteContent } = body;
    // type: 'meal' | 'recipe' | 'ai_content'
    // action: 'approve' | 'reject' | 'delete'

    if (!type || !action) {
      return NextResponse.json({ error: 'Type and action are required' }, { status: 400 });
    }

    if (type === 'meal') {
      // コンテンツ削除
      if (action === 'delete' && deleteContent) {
        const { data: flag } = await supabase
          .from('moderation_flags')
          .select('meal_id')
          .eq('id', params.id)
          .single();

        if (flag?.meal_id) {
          await supabase
            .from('meals')
            .delete()
            .eq('id', flag.meal_id);
        }
      }

      // フラグ更新
      await supabase
        .from('moderation_flags')
        .update({
          status: action === 'delete' ? 'resolved' : action === 'approve' ? 'resolved' : 'rejected',
          resolved_by: user.id,
          resolved_at: new Date().toISOString(),
          resolution_note: note,
        })
        .eq('id', params.id);

    } else if (type === 'recipe') {
      // コンテンツ削除
      if (action === 'delete' && deleteContent) {
        const { data: flag } = await supabase
          .from('recipe_flags')
          .select('recipe_id')
          .eq('id', params.id)
          .single();

        if (flag?.recipe_id) {
          await supabase
            .from('recipes')
            .update({ is_public: false })
            .eq('id', flag.recipe_id);
        }
      }

      // フラグ更新
      await supabase
        .from('recipe_flags')
        .update({
          status: action === 'delete' ? 'resolved' : action === 'approve' ? 'resolved' : 'rejected',
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', params.id);
    }

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action_type: `moderation_${action}`,
        target_id: params.id,
        details: { type, action, deleteContent: deleteContent || false },
      });

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

