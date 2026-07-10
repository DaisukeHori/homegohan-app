/**
 * GET /api/experiments/[key]/assignment — 実験 variant 割当取得 (get-or-assign)
 *
 * #1041 (F4-13) 修正: experiments を running にしても variant 割当エンジンが
 * 存在せず runtime で完全に無効だった問題を解消する。
 * 認証済みユーザーが呼び出すと、running 中の実験について決定的ハッシュに
 * 基づく sticky な variant 割当を取得 (なければ新規作成) する。
 *
 * 権限: 認証済みユーザーであれば誰でも呼び出し可能 (自分自身の割当のみ取得)。
 */

import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/helpers';
import { AuthError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import {
  ExperimentNotRunningError,
  InvalidVariantsError,
  getOrAssignVariant,
} from '@/lib/experiments/assignment';

type Params = { params: { key: string } };

export async function GET(_request: Request, { params }: Params) {
  let userId: string;
  try {
    const user = await requireUser();
    userId = user.id;
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    throw err;
  }

  const supabase = await createClient();

  const { data: experiment, error } = await supabase
    .from('experiments')
    .select('id, key, status, variants')
    .eq('key', params.key)
    .maybeSingle();

  if (error) {
    console.error('[api/experiments/[key]/assignment] fetch error:', error.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '実験情報の取得に失敗しました' } },
      { status: 500 },
    );
  }

  if (!experiment) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '実験が見つかりません' } },
      { status: 404 },
    );
  }

  if (experiment.status !== 'running') {
    // 「計測未接続」ではなく「実験が起動していない」ため、正直に未割当を返す。
    return NextResponse.json({
      data: { key: experiment.key, assigned: false, variant_key: null, reason: 'not_running' },
    });
  }

  try {
    const variantKey = await getOrAssignVariant(
      supabase,
      { id: experiment.id, status: experiment.status, variants: experiment.variants },
      userId,
    );
    return NextResponse.json({
      data: { key: experiment.key, assigned: true, variant_key: variantKey },
    });
  } catch (err) {
    if (err instanceof ExperimentNotRunningError) {
      return NextResponse.json({
        data: { key: experiment.key, assigned: false, variant_key: null, reason: 'not_running' },
      });
    }
    if (err instanceof InvalidVariantsError) {
      console.error('[api/experiments/[key]/assignment] invalid variants:', err.message);
      return NextResponse.json(
        { error: { code: 'OP_EXPERIMENT_INVALID_VARIANTS', message: err.message } },
        { status: 500 },
      );
    }
    console.error(
      '[api/experiments/[key]/assignment] assignment error:',
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '割当処理に失敗しました' } },
      { status: 500 },
    );
  }
}
