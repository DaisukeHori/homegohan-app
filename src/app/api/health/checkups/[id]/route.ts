import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { HEALTH_CHECKUP_DATE_NULL_MESSAGE, HEALTH_CHECKUP_NOT_FOUND_MESSAGE, HEALTH_CHECKUP_NO_FIELDS_MESSAGE } from '@/lib/health-api-messages';
import { INVALID_ID_PARAM_CODE, INVALID_ID_PARAM_MESSAGE, isUuid } from '@/lib/http-params';
import { sanitizeHealthCheckupPayload } from '@/lib/health-payloads';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

// 健康診断の詳細取得
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { id } = await params;
  // uuid 型の列に UUID でない文字列を渡すと 22P02 で 500 になるので、DB に投げる前に 400 にする (#1478)
  if (!isUuid(id)) {
    return NextResponse.json({ error: INVALID_ID_PARAM_MESSAGE, code: INVALID_ID_PARAM_CODE }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('health_checkups')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    return internalError('GET /api/health/checkups/[id]', error, { userId: user.id, table: 'health_checkups' });
  }

  if (!data) {
    return NextResponse.json({ error: HEALTH_CHECKUP_NOT_FOUND_MESSAGE }, { status: 404 });
  }

  return NextResponse.json({ checkup: data });
}

// 健康診断の更新
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { id } = await params;
  // uuid 型の列に UUID でない文字列を渡すと 22P02 で 500 になるので、DB に投げる前に 400 にする (#1478)
  if (!isUuid(id)) {
    return NextResponse.json({ error: INVALID_ID_PARAM_MESSAGE, code: INVALID_ID_PARAM_CODE }, { status: 400 });
  }
  const body = await request.json().catch(() => null);
  const { data: checkupData, errors } = sanitizeHealthCheckupPayload(body);

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  if (Object.keys(checkupData).length === 0) {
    return NextResponse.json({ error: HEALTH_CHECKUP_NO_FIELDS_MESSAGE }, { status: 400 });
  }

  if (checkupData.checkup_date === null) {
    return NextResponse.json({ error: HEALTH_CHECKUP_DATE_NULL_MESSAGE }, { status: 400 });
  }

  // 所有権確認
  const { data: existing } = await supabase
    .from('health_checkups')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: HEALTH_CHECKUP_NOT_FOUND_MESSAGE }, { status: 404 });
  }

  // 更新
  const { data, error } = await supabase
    .from('health_checkups')
    .update({
      ...checkupData,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return internalError('PUT /api/health/checkups/[id]', error, { userId: user.id, table: 'health_checkups' });
  }

  return NextResponse.json({ checkup: data });
}

// 健康診断の削除
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { id } = await params;
  // uuid 型の列に UUID でない文字列を渡すと 22P02 で 500 になるので、DB に投げる前に 400 にする (#1478)
  if (!isUuid(id)) {
    return NextResponse.json({ error: INVALID_ID_PARAM_MESSAGE, code: INVALID_ID_PARAM_CODE }, { status: 400 });
  }

  // 所有権確認
  const { data: existing } = await supabase
    .from('health_checkups')
    .select('id, image_url')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: HEALTH_CHECKUP_NOT_FOUND_MESSAGE }, { status: 404 });
  }

  // 画像があれば削除
  if (existing.image_url) {
    try {
      const url = new URL(existing.image_url);
      const pathParts = url.pathname.split('/');
      const bucketIndex = pathParts.findIndex(p => p === 'health-checkups');
      if (bucketIndex !== -1) {
        const filePath = pathParts.slice(bucketIndex + 1).join('/');
        await supabase.storage.from('health-checkups').remove([filePath]);
      }
    } catch (err) {
      console.error('Failed to delete image:', err);
      // 画像削除に失敗しても続行
    }
  }

  // レコード削除
  const { error } = await supabase
    .from('health_checkups')
    .delete()
    .eq('id', id);

  if (error) {
    return internalError('DELETE /api/health/checkups/[id]', error, { userId: user.id, table: 'health_checkups' });
  }

  return NextResponse.json({ success: true });
}
