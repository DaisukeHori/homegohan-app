import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
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

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
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



