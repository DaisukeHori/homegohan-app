import { createClient } from '@supabase/supabase-js';

export const runtime = 'edge';
export const maxDuration = 60; // Vercel Pro: 60s OK

export async function GET(req: Request) {
  // CRON 認証 (Vercel Cron の Authorization header をチェック)
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_JWT!;

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const workerId = crypto.randomUUID();

  const { data: claimed, error: claimError } = await supabase.rpc('claim_menu_request', { p_worker_id: workerId });
  if (claimError) {
    return Response.json({ error: claimError.message }, { status: 500 });
  }
  if (!claimed || !claimed.id) {
    return Response.json({ idle: true });
  }

  try {
    // Supabase Edge Function を直接 invoke (既存の generate-menu-v5 を使う)
    const v5Url = `${supabaseUrl}/functions/v1/generate-menu-v5`;
    const v5Res = await fetch(v5Url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        'apikey': serviceRoleKey,
      },
      body: JSON.stringify({
        requestId: claimed.id,
        ...(claimed.generated_data ?? {}),
      }),
      signal: AbortSignal.timeout(50_000), // 50秒で abort、未完了は次回 cron で stale-worker reclaim
    });

    if (!v5Res.ok) {
      throw new Error(`V5 returned ${v5Res.status}: ${await v5Res.text().catch(() => '')}`);
    }

    // Edge Function は自身で status を completed / failed に更新するため、
    // ここでは 202 Accepted のレスポンスを受け取ればジョブ受付成功とみなす
    const result = await v5Res.json().catch(() => ({}));

    return Response.json({ processed: claimed.id, result });
  } catch (err) {
    // #122: worker_id 一致条件を追加して二重 status 書き込みを防止
    // Edge Function が先に status を更新していた場合は上書きしない
    await supabase
      .from('weekly_menu_requests')
      .update({
        status: 'failed',
        error_message: err instanceof Error ? err.message : String(err),
        updated_at: new Date().toISOString(),
      })
      .eq('id', claimed.id)
      .eq('worker_id', workerId)
      .in('status', ['queued', 'processing']); // 既に completed/failed の場合は上書きしない
    return Response.json(
      { failed: claimed.id, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
