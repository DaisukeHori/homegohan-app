import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('pantry_items')
    .select('*')
    .eq('user_id', user.id)
    .order('expiration_date', { ascending: true });

  if (error) return internalError('GET /api/pantry', error, { userId: user.id });

  // キャメルケース変換
  const items = data.map((item: any) => ({
    id: item.id,
    name: item.name,
    amount: item.amount,
    category: item.category,
    expirationDate: item.expiration_date,
    addedAt: item.added_at,
  }));

  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) が拒んで 500 になる。認証・DB に触れる前に 400 で断る (#1657)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const json = await request.json();
    const { name, amount, category, expirationDate } = json;

    if (!name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('pantry_items')
      .insert({
        user_id: user.id,
        name,
        amount,
        category: category || 'other',
        expiration_date: expirationDate,
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ 
      item: {
        id: data.id,
        name: data.name,
        amount: data.amount,
        category: data.category,
        expirationDate: data.expiration_date,
        addedAt: data.added_at,
      }
    });
  } catch (error: any) {
    return internalError('POST /api/pantry', error, { userId: user.id });
  }
}



