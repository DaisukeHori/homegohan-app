import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('pantry_items')
    .select('*')
    .eq('user_id', user.id)
    .order('expiration_date', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const json = await request.json();
    const { name, amount, category, expirationDate } = json;

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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}


