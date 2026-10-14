/**
 * /api/cron/* の認証 (Vercel Cron が付ける `Authorization: Bearer <CRON_SECRET>` の確認) (#1196)
 *
 * 照合の規則 (定数時間の比較、入れ替え中だけ使う旧いシークレット CRON_SECRET_PREVIOUS の受け付け、
 * 空の値の扱い) は Edge Functions と共通で、supabase/functions/_shared/cron-secret.ts にある。
 * 新しい cron ルートを足すときは、シークレットを自分で比べず、必ずこの関数を通す。
 *
 * Edge Runtime (export const runtime = 'edge') のルートからも呼べるよう、node:crypto には頼らない
 * (node:crypto の timingSafeEqual は Edge Runtime で使えない)。
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
