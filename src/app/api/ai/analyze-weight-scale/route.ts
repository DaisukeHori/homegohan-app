import { createClient } from '@/lib/supabase/server';
import { extractWeightScaleResult } from '../../../../lib/ai/image-recognition';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { image } = body;

    if (!image) {
      return NextResponse.json({ error: 'Image is required' }, { status: 400 });
    }

    // Edge Function を呼び出し
    const formData = new FormData();
    formData.append('image_base64', image);
    formData.append('device_type', 'weight_scale');

    const { data, error } = await supabase.functions.invoke('analyze-health-photo', {
      body: formData,
    });

    if (error) {
      console.error('Edge Function error:', error);
      return NextResponse.json({ error: 'Analysis failed' }, { status: 500 });
    }

    // 結果を整形
    const result = extractWeightScaleResult(data);

    // 体重が取得できなかった場合
    if (!result.weight || result.weight <= 0) {
      return NextResponse.json({
        error: '体重を読み取れませんでした。体重計のディスプレイがはっきり映っている写真を使用してください。',
      }, { status: 400 });
    }

    return NextResponse.json(result);

  } catch (error: any) {
    console.error('Weight scale analysis error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
