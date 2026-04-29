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

    // Edge Function を呼び出し（25秒タイムアウト）
    const formData = new FormData();
    formData.append('image_base64', image);
    formData.append('device_type', 'weight_scale');

    const invokePromise = supabase.functions.invoke('analyze-health-photo', {
      body: formData,
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('AI タイムアウト')), 25_000),
    );

    const { data, error } = await Promise.race([invokePromise, timeoutPromise]) as Awaited<typeof invokePromise>;

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
    const isTimeout = error instanceof Error && error.message === 'AI タイムアウト';
    if (isTimeout) {
      console.error('Weight Scale Analysis: AI timeout after 25s');
      return NextResponse.json(
        { error: 'AI が応答しませんでした、もう一度お試しください' },
        { status: 504 },
      );
    }
    console.error('Weight scale analysis error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
