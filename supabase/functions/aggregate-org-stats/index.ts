import { requireServiceRole } from '../_shared/auth.ts';
import { createLogger, generateRequestId } from '../_shared/db-logger.ts';

// 組織統計の集計は、オーナー判断 (#1325) により停止している。
// 以前は、組織ごとの日次統計 (活力スコア・朝食摂取率・深夜食率・活動率) を集計して保存していたが、
// 読み取り先が、すでに削除された表を指していて、本番では何も保存できていなかった。
// これを直すと止めると決めた集計が動き出すため、直さずに、集計処理そのものを削除した。
// 組織の画面には「準備中」を出している。
//
// この関数は、デプロイ先に残す (デプロイは関数を削除しないため)。
// 古い呼び出し元 (本番に残った pg_cron のジョブなど) が呼んでも、何も書かずに 410 を返す。
// 集計を再開するには、新しいオーナー判断のもとで、集計処理を作り直す。

// バッチ専用 (ブラウザからは呼ばれない) なので CORS は付けない (#1167)。
// ブラウザの事前確認 (OPTIONS) は下の認証で 401 になり、CORS ヘッダーが無いためブラウザ側で止まる。
Deno.serve(async (req) => {
  // バッチ専用: CRON_SECRET 認証
  const authErr = await requireServiceRole(req);
  if (authErr) {
    return new Response(authErr.body, {
      status: authErr.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 認証に通った呼び出しは、停止後も呼び出し元が残っている印。記録しておく
  // (本番の pg_cron のジョブが残っていないかを確かめる手がかりになる)
  createLogger('aggregate-org-stats', generateRequestId()).warn(
    '組織統計の集計は停止中です (#1325)。呼び出し元 (pg_cron のジョブなど) が残っていないか確認してください',
  );

  return new Response(
    JSON.stringify({
      success: false,
      code: 'DISABLED',
      message: '組織の集計はオーナー判断 (#1325) により停止しています',
    }),
    {
      status: 410,
      headers: { 'Content-Type': 'application/json' },
    },
  );
});
