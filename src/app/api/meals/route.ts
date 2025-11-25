import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = createClient(cookies());
  
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const mealType = formData.get('mealType') as string;
    const eatenAt = formData.get('eatenAt') as string;
    const memo = formData.get('memo') as string;

    // 1. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let photoUrl = null;

    // 2. 画像アップロード
    if (file) {
      const fileExt = file.name.split('.').pop();
      const fileName = `${user.id}/${Date.now()}.${fileExt}`;
      
      const { error: uploadError } = await supabase.storage
        .from('meal-photos')
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('meal-photos')
        .getPublicUrl(fileName);
        
      photoUrl = publicUrl;
    }

    // 3. DB保存
    const { data: meal, error: dbError } = await supabase
      .from('meals')
      .insert({
        user_id: user.id,
        meal_type: mealType,
        eaten_at: eatenAt,
        photo_url: photoUrl,
        memo: memo,
      })
      .select()
      .single();

    if (dbError) throw dbError;

    return NextResponse.json({ meal });

  } catch (error: any) {
    console.error('Error creating meal:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
