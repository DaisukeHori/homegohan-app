import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// セグメント統計計算のトリガーAPI
// Edge Functionを呼び出す
export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { periodType = 'weekly' } = await request.json().catch(() => ({}));

    // Edge Functionを呼び出す
    const { data, error } = await supabase.functions.invoke('calculate-segment-stats', {
      body: { periodType },
    });

    if (error) {
      console.error('Edge Function error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);

  } catch (error: any) {
    console.error('Trigger API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

