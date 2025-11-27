import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 組織一覧取得
export async function GET(request: Request) {
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
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = (page - 1) * limit;

    let dbQuery = supabase
      .from('organizations')
      .select('*', { count: 'exact' });

    if (query) {
      dbQuery = dbQuery.ilike('name', `%${query}%`);
    }

    const { data, error, count } = await dbQuery
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // メンバー数を取得
    const orgsWithMembers = await Promise.all(
      (data || []).map(async (org: any) => {
        const { count: memberCount } = await supabase
          .from('user_profiles')
          .select('*', { count: 'exact', head: true })
          .eq('organization_id', org.id);

        return {
          id: org.id,
          name: org.name,
          plan: org.plan,
          industry: org.industry,
          employeeCount: org.employee_count,
          subscriptionStatus: org.subscription_status,
          subscriptionExpiresAt: org.subscription_expires_at,
          contactEmail: org.contact_email,
          memberCount: memberCount || 0,
          createdAt: org.created_at,
        };
      })
    );

    return NextResponse.json({
      organizations: orgsWithMembers,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 組織作成
export async function POST(request: Request) {
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
    const { name, plan, industry, employeeCount, contactEmail, contactName } = body;

    if (!name) {
      return NextResponse.json({ error: 'Organization name is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('organizations')
      .insert({
        name,
        plan: plan || 'standard',
        industry,
        employee_count: employeeCount,
        contact_email: contactEmail,
        contact_name: contactName,
        subscription_status: 'trial',
      })
      .select()
      .single();

    if (error) throw error;

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action_type: 'create_organization',
        target_id: data.id,
        details: { name },
      });

    return NextResponse.json({
      success: true,
      organization: {
        id: data.id,
        name: data.name,
      },
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

