import { z } from 'zod';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const HandsonTourSkipRequestSchema = z.object({
  step: z.number().int().min(0).max(4),
  reason: z.enum(['user_action', 'hard_back']),
});

type HandsonTourSkipRequest = z.infer<typeof HandsonTourSkipRequestSchema>;

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
      .select('user_id')
      .eq('user_id', user.id)
      .single();

    if (profileError || !profile) {
      return NextResponse.json(
        { error: { code: 'profile_not_found', message: 'プロファイルが見つかりません' } },
        { status: 404 },
      );
    }

    const skippedAt = new Date().toISOString();

    await supabase
      .from('user_profiles')
      .update({ handson_tour_skipped_at: skippedAt })
      .eq('user_id', user.id)
      .is('handson_tour_skipped_at', null)
      .is('handson_tour_completed_at', null);

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
