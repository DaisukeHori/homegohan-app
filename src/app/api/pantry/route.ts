import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

/** 400: 食材の名前が空 */
const PANTRY_NAME_REQUIRED_MESSAGE = '食材の名前を入力してください';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

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
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
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

    if (!name?.trim()) {
      return NextResponse.json({ error: PANTRY_NAME_REQUIRED_MESSAGE }, { status: 400 });
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



