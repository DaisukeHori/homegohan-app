/**
 * GET /api/admin/moderation — モデレーションフラグ一覧
 * 権限: admin, super_admin, content_moderator
 *
 * レスポンス形式:
 *   { mealFlags: [], recipeFlags: [], aiFlags: [] }
 *
 * E2E: w5-12-admin-adversarial G-27, G-27b
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'escalated']).optional().default('pending'),
});

export async function GET(request: Request) {
  try {
    await requireRole(['admin', 'super_admin', 'content_moderator']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
        { status: 403 },
      );
    }
    throw err;
  }

  const { searchParams } = new URL(request.url);
  const parseResult = QuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'パラメータが不正です', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { status } = parseResult.data;
  const supabase = await createClient();

  // meal フラグ (food タイプ)
  let mealFlags: unknown[] = [];
  let recipeFlags: unknown[] = [];
  let aiFlags: unknown[] = [];

  try {
    const { data: mealData } = await supabase
      .from('moderation_items')
      .select('*')
      .eq('type', 'food')
      .eq('status', status)
      .order('created_at', { ascending: true })
      .limit(50);
    mealFlags = mealData ?? [];
  } catch {
    // moderation_items テーブル未作成の場合は空配列
  }

  try {
    const { data: recipeData } = await supabase
      .from('moderation_items')
      .select('*')
      .eq('type', 'recipe')
      .eq('status', status)
      .order('created_at', { ascending: true })
      .limit(50);
    recipeFlags = recipeData ?? [];
  } catch {
    // graceful degradation
  }

  try {
    const { data: aiData } = await supabase
      .from('moderation_items')
      .select('*')
      .eq('type', 'ai_content')
      .eq('status', status)
      .order('created_at', { ascending: true })
      .limit(50);
    aiFlags = aiData ?? [];
  } catch {
    // graceful degradation
  }

  return NextResponse.json({
    mealFlags,
    recipeFlags,
    aiFlags,
  });
}
