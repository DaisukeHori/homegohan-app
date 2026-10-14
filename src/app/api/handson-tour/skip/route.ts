import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  HandsonTourSkipRequestSchema,
  type HandsonTourSkipRequest,
} from '@/lib/handson-tour/schemas';

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: { code: 'unauthorized', message: '認証が必要です' } },
        { status: 401 },
      );
    }

    let body: HandsonTourSkipRequest;
    try {
      const raw = await request.json();
      body = HandsonTourSkipRequestSchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: { code: 'validation_error', message: 'リクエストの形式が不正です' } },
        { status: 400 },
      );
    }

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return NextResponse.json(
        { error: { code: 'profile_not_found', message: 'プロファイルが見つかりません' } },
        { status: 404 },
      );
    }

    const skippedAt = new Date().toISOString();

    // #1045 (F6-10): update の戻り値を確認せず常に200を返していたため、
    // UPDATE 文自体がエラーになったケース (ネットワーク断・RLS 拒否等) を検知できなかった。
    // .select() を付けて error を判定し、実際に DB へ書き込まれた値を返す。
    const { data: updatedRows, error: updateError } = await supabase
      .from('user_profiles')
      .update({ handson_tour_skipped_at: skippedAt })
      .eq('id', user.id)
      .is('handson_tour_skipped_at', null)
      .is('handson_tour_completed_at', null)
      .select('handson_tour_skipped_at');

    if (updateError) {
      console.error('handson-tour/skip update error:', updateError);
      return NextResponse.json(
        { error: { code: 'internal_error', message: 'サーバーエラーが発生しました' } },
        { status: 500 },
      );
    }

    if (!updatedRows || updatedRows.length === 0) {
      // #1045 (F6-10): 既に completed/skipped 済みで対象行が0件だったケース。
      // 新しい skippedAt をそのまま返すと実際のDB値と乖離するため、実際の値を取得して返す。
      const { data: existingProfile, error: refetchError } = await supabase
        .from('user_profiles')
        .select('handson_tour_skipped_at, handson_tour_completed_at')
        .eq('id', user.id)
        .maybeSingle();

      if (refetchError || !existingProfile) {
        console.error('handson-tour/skip refetch error:', refetchError);
        return NextResponse.json(
          { error: { code: 'internal_error', message: 'サーバーエラーが発生しました' } },
          { status: 500 },
        );
      }

      return NextResponse.json({
        skipped_at: existingProfile.handson_tour_skipped_at ?? skippedAt,
      });
    }

    console.info('handson_tour skip event', {
      user_id: user.id,
      step: body.step,
      reason: body.reason,
      skipped_at: skippedAt,
    });

    return NextResponse.json({ skipped_at: skippedAt });
  } catch (err: unknown) {
    console.error('handson-tour/skip error:', err);
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'サーバーエラーが発生しました' } },
      { status: 500 },
    );
  }
}
