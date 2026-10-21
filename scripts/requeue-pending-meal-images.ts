/**
 * 料理画像を待ったまま (pending / stale) で処理するジョブが無い料理に、ジョブを積み直す (#1505)。積むのは献立の主菜 (自動の料理画像を作る 1 品) だけで、ほかの待ちの料理は積まずに対象外の理由 not_auto_image_dish で数える (billing/03 Q-16)
 *
 * 既定は dry-run (数えるだけ。何も書かない)。--apply を付けたときだけ meal_image_jobs に行を積み、
 * 献立ごとに process-meal-image-jobs を起こす (画像を作る AI へ送る)。本番のデータへの一括の書き込みなので、
 * --apply は Issue #1505 に書いた承認のあとに実行する。判定と実行の中身は scripts/lib/meal-image-backfill.ts。
 *
 * 使い方 (接続先と鍵は環境変数で渡す。.env.local は読まない。値はコマンドの履歴やログに残さない):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx --yes tsx@4 scripts/requeue-pending-meal-images.ts
 *       数えるだけ (対象の献立・料理の数と、対象外の理由ごとの数)
 *   ... npx --yes tsx@4 scripts/requeue-pending-meal-images.ts --apply --user-id=<uuid> --max-meals=1
 *       1 人分の 1 献立だけ積み直して、画像ができるかを確かめる
 *   ... npx --yes tsx@4 scripts/requeue-pending-meal-images.ts --apply --since=2026-10-01 --max-meals=50
 *       この日以降の献立を、日付の新しい順に 50 献立まで積み直す
 *
 * 引数:
 *   --apply           積み直す (付けなければ dry-run)
 *   --max-meals=N     積み直す献立の数 (既定 50。上限 500)
 *   --since=YYYY-MM-DD この日以降の献立だけ
 *   --user-id=<uuid>  この利用者の献立だけ
 *   --no-trigger      積むだけで process-meal-image-jobs を起こさない (ジョブは待ちのまま残り、pg_cron のジョブ
 *                     process-pending-meal-image-jobs が 5 分ごとに 5 件ずつ拾う。#1561。Vault と Edge の秘密がそろっているとき)
 * 環境変数:
 *   SUPABASE_URL (または NEXT_PUBLIC_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY   必須
 *   SERVICE_ROLE_JWT          process-meal-image-jobs を起こす鍵 (無ければ SUPABASE_SERVICE_ROLE_KEY。Edge Function と同じ優先順位)
 *   MEAL_IMAGE_BACKFILL_INTERVAL_MS  献立ごとに処理を起こしたあとの待ち (既定 10000)
 * 終了コード: 0 = 完了 / 1 = 接続情報が無い・読み書きの失敗 / 2 = 引数の誤り
 */
import { createClient } from '@supabase/supabase-js';
import {
  parseMealImageBackfillArgs,
  resolveMealImageBackfillIntervalMs,
  runMealImageBackfill,
  type MealImageBackfillArgs,
} from './lib/meal-image-backfill';

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

async function main(): Promise<number> {
  let args: MealImageBackfillArgs;
  let intervalMs: number;
  try {
    args = parseMealImageBackfillArgs(process.argv.slice(2));
    intervalMs = resolveMealImageBackfillIntervalMs(process.env.MEAL_IMAGE_BACKFILL_INTERVAL_MS);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('接続情報がありません: SUPABASE_URL (または NEXT_PUBLIC_SUPABASE_URL) と SUPABASE_SERVICE_ROLE_KEY を渡してください');
    return EXIT_FAILURE;
  }
  const triggerKey = process.env.SERVICE_ROLE_JWT || serviceRoleKey;

  // 接続先は host だけを出す (鍵は出さない)
  console.log(`接続先: ${new URL(supabaseUrl).host}`);
  console.log(args.apply ? `積み直します (最大 ${args.maxMeals} 献立${args.trigger ? '・処理を起こす' : '・処理は起こさない'})` : 'dry-run: 数えるだけで、何も書きません');

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const report = await runMealImageBackfill(admin, {
      apply: args.apply,
      maxMeals: args.maxMeals,
      since: args.since,
      userId: args.userId,
      trigger: args.trigger,
      intervalMs,
      supabaseUrl,
      serviceRoleKey: triggerKey,
    });
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_FAILURE;
  }
}

main().then((code) => {
  process.exitCode = code;
});
