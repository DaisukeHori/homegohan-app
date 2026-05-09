/**
 * GET /api/org/settings — 組織設定取得
 * PUT /api/org/settings — 組織設定更新
 * 権限: org_admin (自組織のみ)
 *
 * E2E: w5-13-new-features-adversarial A-1, A-4, A-7
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const OrgSettingsUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  plan: z.enum(['standard', 'premium', 'enterprise']).optional(),
}).refine((d) => Object.keys(d).length > 0, {
  message: '更新するフィールドを少なくとも1つ指定してください',
});

export async function GET() {
  try {
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

    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('id, name, plan, created_at, updated_at')
      .eq('id', profile.organization_id)
      .single();

    if (orgError || !org) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: '組織が見つかりません' } },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: org });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: err.message } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: err.message } },
        { status: 403 },
      );
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message } },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
        { status: 400 },
      );
    }

    const parseResult = OrgSettingsUpdateSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    const updates = parseResult.data;

    const { data: org, error: updateError } = await supabase
      .from('organizations')
      .update({ ...updates, updated_at: new Date().toISOString() } as Record<string, unknown>)
      .eq('id', profile.organization_id)
      .select('id, name, plan, created_at, updated_at')
      .single();

    if (updateError || !org) {
      console.error('[api/org/settings] PUT update error:', updateError?.message);
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: '設定の更新に失敗しました' } },
        { status: 500 },
      );
    }

    return NextResponse.json({ data: org });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: err.message } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: err.message } },
        { status: 403 },
      );
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message } },
      { status: 500 },
    );
  }
}
