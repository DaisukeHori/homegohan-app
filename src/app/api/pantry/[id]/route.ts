import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { isUuid } from '@/lib/http-params';

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const json = await request.json().catch(() => null);
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { name, amount, category, expirationDate } = json;

    const updateData: Record<string, any> = {};
    if (name !== undefined) updateData.name = name;
    if (amount !== undefined) updateData.amount = amount;
    if (category !== undefined) updateData.category = category;
    if (expirationDate !== undefined) updateData.expiration_date = expirationDate;

    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    const { data, error } = await supabase
      .from('pantry_items')
      .update(updateData)
      .eq('id', params.id)
      .eq('user_id', user.id)
      .select('*')
      .maybeSingle();

    if (error) return internalError('PATCH /api/pantry/[id]', error, { userId: user.id });
    // 他人の行・消された行は更新した行が無い。500 にせず 404 (#1917。.single() は 0 行を PGRST116 の失敗にして 500 にしていた)
    if (!data) return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });

    return NextResponse.json({
      item: {
        id: data.id,
        name: data.name,
        amount: data.amount,
        category: data.category,
        expirationDate: data.expiration_date,
        addedAt: data.added_at,
      },
    });
  } catch (error: any) {
    return internalError('PATCH /api/pantry/[id]', error, { userId: user.id });
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  // UUID の形でない id は DB に渡さず 404 (UUID の形の確かめは PATCH と同じ。uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る。#1917)。UUID の形で 0 行の DELETE は、消した行数を見ずに 200 { success: true } のまま (PATCH の 0 行は 404)
  if (!isUuid(params.id)) {
    return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
  }

  const { error } = await supabase
    .from('pantry_items')
    .delete()
    .eq('id', params.id)
    .eq('user_id', user.id);

  if (error) return internalError('DELETE /api/pantry/[id]', error, { userId: user.id });

  return NextResponse.json({ success: true });
}



