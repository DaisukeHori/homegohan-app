/**
 * GET/POST/PUT/DELETE /api/org/departments — 部署管理 API
 * org_admin ロール必須
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

async function requireOrgAdmin() {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new AuthError('AUTH_UNAUTHENTICATED');
  }
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();
  if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
    throw new ForbiddenError('PERM_DENIED', 'org_admin role required');
  }
  return { user, profile };
}

function handleError(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
}

export async function GET() {
  try {
    const { profile } = await requireOrgAdmin();
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('organization_departments')
      .select('id, name, created_at')
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: false });
    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }
    return NextResponse.json({ departments: data ?? [] });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { profile } = await requireOrgAdmin();
    const body = await request.json();
    const { name } = body ?? {};
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'name は必須です' } }, { status: 400 });
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('organization_departments')
      .insert({ name: name.trim(), organization_id: profile.organization_id })
      .select('id, name, created_at')
      .single();
    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }
    return NextResponse.json({ department: data }, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { profile } = await requireOrgAdmin();
    const body = await request.json();
    const { id, name } = body ?? {};
    if (!id) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'id は必須です' } }, { status: 400 });
    }
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'name は必須です' } }, { status: 400 });
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('organization_departments')
      .update({ name: name.trim() })
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .select('id, name, created_at')
      .single();
    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }
    return NextResponse.json({ department: data });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { profile } = await requireOrgAdmin();
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'id は必須です' } }, { status: 400 });
    }
    const supabase = await createClient();
    const { error } = await supabase
      .from('organization_departments')
      .delete()
      .eq('id', id)
      .eq('organization_id', profile.organization_id);
    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
