/**
 * /api/cron/* の認証 (Vercel Cron が付ける `Authorization: Bearer <CRON_SECRET>` の確認) (#1196)
 *
 * 照合の規則 (定数時間の比較、入れ替え中だけ使う旧いシークレット CRON_SECRET_PREVIOUS の受け付け、
 * 空の値の扱い) は Edge Functions と共通で、supabase/functions/_shared/cron-secret.ts にある。
 * 新しい cron ルートを足すときは、シークレットを自分で比べず、必ずこの関数を通す。
 *
 * 照合は Deno で動く Edge Functions と共通の 1 つの実装 (checkCronSecret) なので、ここでも node:crypto には頼らない
 * (共通の実装は Web 標準の crypto.subtle だけを使う)。
 *
 * 入れ替えの手順は ENV_SETUP.md の「Cron の共有シークレットの保管場所とローテーション」。
 *
 * @example
 * const authError = await requireCronAuth(req);
 * if (authError) return authError;
 */

import { NextResponse } from 'next/server';
import { checkCronSecret } from '../../supabase/functions/_shared/cron-secret';

/**
 * 認証に成功したら null を返す。
 * 失敗したら 401 (一致しない・ヘッダーなし) か 503 (CRON_SECRET が未設定) の Response を返す
 * (呼び出し元はそのまま return すること)。
 *
 * ダイジェストの計算が非同期なので Promise を返す。必ず await すること
 * (await を忘れると、null でも Response でもない Promise が来て if (authError) が常に真になる)。
 */
export async function requireCronAuth(req: Request): Promise<NextResponse | null> {
  const result = await checkCronSecret(req.headers.get('authorization'), {
    current: process.env.CRON_SECRET,
    previous: process.env.CRON_SECRET_PREVIOUS,
  });

  if (result.ok) {
    if (result.matched === 'previous') {
      // 送信側がまだ旧い値を使っている。このログが出なくなったことを確かめてから CRON_SECRET_PREVIOUS を外す
      // (秘密の値そのものは出さない)
      console.warn('[cron] CRON_SECRET_PREVIOUS (旧いシークレット) で認証されました。送信側を新しい CRON_SECRET に更新してください');
    }
    return null;
  }

  if (result.reason === 'not_configured') {
    console.error('[cron] CRON_SECRET not set');
    return NextResponse.json({ error: 'cron_disabled' }, { status: 503 });
  }

  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

/** Vercel の環境の CRON_SECRET_PREVIOUS の状態 (値は含まない)。GET /api/cron/app-log-alerts の cron_secret_rotation が使う (#1560) */
export interface CronSecretRotationState {
  /** CRON_SECRET_PREVIOUS が設定されている (空文字でない) か */
  previous_configured: boolean;
  /** 設定されていて、現行の CRON_SECRET と同じ値か (入れ替えの意味が無い) */
  previous_same_as_current: boolean;
}

/**
 * CRON_SECRET_PREVIOUS の有無と、現行と同じかだけを返す (値は返さない)。
 * 比較は、どちらもサーバーが持つ値どうし (外からの入力ではない) なので === でよい
 * (checkCronSecret の定数時間の比較は、外からの Bearer を比べるためのもの)。
 */
export function describeCronSecretRotationState(): CronSecretRotationState {
  const current = process.env.CRON_SECRET;
  const previous = process.env.CRON_SECRET_PREVIOUS;
  const previousConfigured = typeof previous === 'string' && previous.length > 0;
  return {
    previous_configured: previousConfigured,
    previous_same_as_current: previousConfigured && previous === current,
  };
}
