import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 組織設定取得
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
    const { data: org, error } = await supabase
      .from('organizations')
      .select('*')
      .eq('id', profile.organization_id)
      .single();

    if (error) throw error;

    return NextResponse.json({
      organization: {
        id: org.id,
        name: org.name,
        plan: org.plan,
        industry: org.industry,
        employeeCount: org.employee_count,
        settings: org.settings,
        subscriptionStatus: org.subscription_status,
        subscriptionExpiresAt: org.subscription_expires_at,
        logoUrl: org.logo_url,
        contactEmail: org.contact_email,
        contactName: org.contact_name,
        createdAt: org.created_at,
      },
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 組織設定更新
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
    const { name, industry, employeeCount, contactEmail, contactName, settings } = body;

    const updateData: any = { updated_at: new Date().toISOString() };
    if (name !== undefined) updateData.name = name;
    if (industry !== undefined) updateData.industry = industry;
    if (employeeCount !== undefined) updateData.employee_count = employeeCount;
    if (contactEmail !== undefined) updateData.contact_email = contactEmail;
    if (contactName !== undefined) updateData.contact_name = contactName;
    if (settings !== undefined) updateData.settings = settings;

    const { error } = await supabase
      .from('organizations')
      .update(updateData)
      .eq('id', profile.organization_id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

