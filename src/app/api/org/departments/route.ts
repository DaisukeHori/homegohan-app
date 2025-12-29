import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 部署一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();

  if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { data: departments, error } = await supabase
      .from('departments')
      .select(`
        id,
        name,
        parent_id,
        manager_id,
        display_order,
        created_at
      `)
      .eq('organization_id', profile.organization_id)
      .order('display_order', { ascending: true });

    if (error) throw error;

    // 各部署のメンバー数を取得
    const deptWithCounts = await Promise.all(
      (departments || []).map(async (dept: any) => {
        const { count } = await supabase
          .from('user_profiles')
          .select('*', { count: 'exact', head: true })
          .eq('organization_id', profile.organization_id)
          .eq('department', dept.name);

        return {
          id: dept.id,
          name: dept.name,
          parentId: dept.parent_id,
          managerId: dept.manager_id,
          displayOrder: dept.display_order,
          memberCount: count || 0,
          createdAt: dept.created_at,
        };
      })
    );

    return NextResponse.json({ departments: deptWithCounts });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 部署作成
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();

  if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { name, parentId, managerId } = body;

    if (!name) {
      return NextResponse.json({ error: 'Department name is required' }, { status: 400 });
    }

    // 最大display_order取得
    const { data: maxOrder } = await supabase
      .from('departments')
      .select('display_order')
      .eq('organization_id', profile.organization_id)
      .order('display_order', { ascending: false })
      .limit(1)
      .single();

    const { data, error } = await supabase
      .from('departments')
      .insert({
        organization_id: profile.organization_id,
        name,
        parent_id: parentId || null,
        manager_id: managerId || null,
        display_order: (maxOrder?.display_order || 0) + 1,
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({
      success: true,
      department: {
        id: data.id,
        name: data.name,
        displayOrder: data.display_order,
      },
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 部署更新
export async function PUT(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();

  if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { id, name, parentId, managerId, displayOrder } = body;

    if (!id) {
      return NextResponse.json({ error: 'Department ID is required' }, { status: 400 });
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (parentId !== undefined) updateData.parent_id = parentId;
    if (managerId !== undefined) updateData.manager_id = managerId;
    if (displayOrder !== undefined) updateData.display_order = displayOrder;

    const { error } = await supabase
      .from('departments')
      .update(updateData)
      .eq('id', id)
      .eq('organization_id', profile.organization_id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 部署削除
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();

  if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Department ID is required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('departments')
      .delete()
      .eq('id', id)
      .eq('organization_id', profile.organization_id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

