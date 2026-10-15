import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  // 本文の文字列 (自由に書ける欄) に NULL 文字があれば、DB (text / jsonb) が拒んで 500 になる。認証・DB に触れる前に 400 で断る (#1657)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const json = await request.json();
    const { name, amount, category, expirationDate } = json;

    const updateData: Record<string, any> = {};
    if (name !== undefined) updateData.name = name;
    if (amount !== undefined) updateData.amount = amount;
    if (category !== undefined) updateData.category = category;
    if (expirationDate !== undefined) updateData.expiration_date = expirationDate;

    const { data, error } = await supabase
      .from('pantry_items')
      .update(updateData)
      .eq('id', params.id)
      .eq('user_id', user.id)
      .select('*')
      .single();

    if (error) return internalError('PATCH /api/pantry/[id]', error, { userId: user.id });

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
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { error } = await supabase
    .from('pantry_items')
    .delete()
    .eq('id', params.id)
    .eq('user_id', user.id);

  if (error) return internalError('DELETE /api/pantry/[id]', error, { userId: user.id });

  return NextResponse.json({ success: true });
}



