import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getHandsonTourStatusInternal } from '@/lib/handson-tour/getStatus';

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: { code: 'unauthorized', message: '認証が必要です' } },
        { status: 401 },
      );
    }

    const status = await getHandsonTourStatusInternal(user.id);
    return NextResponse.json(status);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'profile_not_found') {
      return NextResponse.json(
        { error: { code: 'profile_not_found', message: 'プロファイルが見つかりません' } },
        { status: 404 },
      );
    }
    console.error('handson-tour/status error:', err);
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'サーバーエラーが発生しました' } },
      { status: 500 },
    );
  }
}
