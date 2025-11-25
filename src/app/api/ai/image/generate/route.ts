import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = createClient(cookies());

  try {
    const { prompt } = await request.json();

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. OpenAI DALL-E 3 API 呼び出し
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OpenAI API Key is missing' }, { status: 500 });
    }

    const openaiRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "dall-e-3",
        prompt: `A delicious, appetizing, professional food photography shot of ${prompt}. Natural lighting, 4k, high resolution, minimalist plating.`,
        n: 1,
        size: "1024x1024",
        response_format: "b64_json" // Base64で取得して直接アップロード
      })
    });

    if (!openaiRes.ok) {
      const errorText = await openaiRes.text();
      console.error('OpenAI Error:', errorText);
      throw new Error(`OpenAI API Failed: ${errorText}`);
    }

    const aiData = await openaiRes.json();
    const b64Json = aiData.data[0].b64_json;
    const buffer = Buffer.from(b64Json, 'base64');

    // 3. Supabase Storage へアップロード
    const fileName = `generated/${user.id}/${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage
      .from('fridge-images') // 既存のバケットを再利用
      .upload(fileName, buffer, {
        contentType: 'image/png',
        upsert: true
      });

    if (uploadError) throw uploadError;

    // 4. 公開URLの取得
    const { data: { publicUrl } } = supabase.storage
      .from('fridge-images')
      .getPublicUrl(fileName);

    return NextResponse.json({ imageUrl: publicUrl });

  } catch (error: any) {
    console.error("Image Gen Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

