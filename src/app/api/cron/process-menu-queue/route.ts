import { createClient } from '@supabase/supabase-js';
import { requireCronAuth } from '@/lib/cron-auth';
import { createLogger } from '@/lib/db-logger';
import {
  aiConsentDeniedPayload,
  aiConsentDeniedStoredMessage,
  aiConsentDeniedStoredMessageOfResponse,
  checkUserAiConsent,
} from '@/lib/ai/consent-guard';
// runtime = 'edge' のルートなので、zod を持つ @/lib/env ではなく何も import しない env-required を使う (#1182)
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';

export const runtime = 'edge';
export const maxDuration = 60; // Vercel Pro: 60s OK

export async function GET(req: Request) {
  // CRON 認証 (Vercel Cron の Authorization header をチェック)。
  // #1044: 定数時間の比較、#1196: 入れ替え中の旧シークレット (CRON_SECRET_PREVIOUS) の受け付けは共通ヘルパーに集約
  const authError = await requireCronAuth(req);
  if (authError) return authError;

  // 必須の環境変数が欠けていれば、汎用の 500 で止める。本文には変数名を出さず、変数名は構造化ログにだけ残す (#1182 / #1172)
  let serviceConfig: { url: string; serviceRoleKey: string };
  try {
    serviceConfig = getSupabaseServiceConfig();
  } catch (error) {
    return internalError('GET /api/cron/process-menu-queue', error);
  }

  const { url: supabaseUrl, serviceRoleKey } = serviceConfig;

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const workerId = crypto.randomUUID();

  const { data: claimed, error: claimError } = await supabase.rpc('claim_menu_request', { p_worker_id: workerId });
  if (claimError) {
    return internalError('GET /api/cron/process-menu-queue', claimError);
  }
  if (!claimed || !claimed.id) {
    return Response.json({ idle: true });
  }

  // 献立の生成は、利用者のデータ (好み・アレルギー・健康目標など) を外国の AI 事業者へ送る。
  // キューに積まれたあとに同意を撤回した利用者 (または判定に失敗した場合) は、送らずに失敗にする (T15 / #1154。fail-closed)。
  // 判定に使う user_id は、利用者が書き換えられる generated_data ではなく、行の user_id。
  // error_message は画面がそのまま出すので、コードではなく人向けの文を書く (画面はこの文を見分けて同意画面へ案内する)
  const aiConsent = await checkUserAiConsent(supabase, claimed.user_id);
  if (!aiConsent.allowed) {
    const { body } = aiConsentDeniedPayload(aiConsent);
    createLogger('cron/process-menu-queue', claimed.id).withUser(claimed.user_id).warn(
      '外国の AI 事業者への提供の同意が無いため、献立生成リクエストを送らずに失敗にしました',
      { requestId: claimed.id, code: body.code },
    );
    await supabase
      .from('weekly_menu_requests')
      .update({
        status: 'failed',
        error_message: aiConsentDeniedStoredMessage(aiConsent),
        updated_at: new Date().toISOString(),
      })
      .eq('id', claimed.id)
      .eq('worker_id', workerId)
      .in('status', ['queued', 'processing']);
    return Response.json({ skipped: claimed.id, code: body.code });
  }

  try {
    // #1202: 取り直した行 (attempt_count > 1) と、すでに工程が進んでいる行 (current_step > 1) は、
    // 前のワーカーが止まった行。_continue 無しで呼ぶと Edge Function は Step1 から始め直し、
    // 進んだ工程を巻き戻して二重に処理する。_continue を付ければ、DB に保存済みの current_step と
    // generated_data (各ステップのカーソル) から続きから再開する。
    // 再開の呼び出しに必要なのは userId だけで、肥大した generated_data をもう一度送る必要は無い。
    // userId は generated_data (利用者が書き換えられる) ではなく、行の user_id を使う。
    const isResume = Number(claimed.attempt_count ?? 0) > 1 || Number(claimed.current_step ?? 1) > 1;
    if (isResume) {
      createLogger('cron/process-menu-queue', claimed.id).withUser(claimed.user_id).warn(
        '止まった献立生成リクエストを取り直し、続きから再開します',
        { requestId: claimed.id, attemptCount: claimed.attempt_count, currentStep: claimed.current_step },
      );
    }
    const payload = isResume
      ? { requestId: claimed.id, userId: claimed.user_id, _continue: true }
      : { ...(claimed.generated_data ?? {}), requestId: claimed.id, userId: claimed.user_id };

    // Supabase Edge Function を直接 invoke (既存の generate-menu-v5 を使う)
    const v5Url = `${supabaseUrl}/functions/v1/generate-menu-v5`;
    const v5Res = await fetch(v5Url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        'apikey': serviceRoleKey,
      },
      body: JSON.stringify(payload),
      // Edge Function は 202 をすぐ返してバックグラウンドで進める。50 秒で応答が無ければ abort し、下の catch で failed にする。
      // (生成の途中でワーカーが止まった場合の取り直しは、claim_menu_request のリース切れ判定が担う)
      signal: AbortSignal.timeout(50_000),
    });

    if (!v5Res.ok) {
      const v5Text = await v5Res.text().catch(() => '');
      // Edge Function が同意の判定で止めた (T15 / #1154。ここでの判定のあとに撤回された・Edge Function 側で読めなかった)。
      // 行は Edge Function が人向けの文で失敗にしている。その書き込みが失敗していても、下の catch が内部の文 (状態コードと本文) を
      // error_message に書かないよう、同じ人向けの文にする
      throw new Error(aiConsentDeniedStoredMessageOfResponse(v5Res.status, v5Text) ?? `V5 returned ${v5Res.status}: ${v5Text}`);
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
    // 本文に例外の文面を返さない (#1172)。どの行が失敗したかは、構造化ログの request_id (= 行の id) で追える
    return internalError('GET /api/cron/process-menu-queue', err, { userId: claimed.user_id, requestId: claimed.id });
  }
}
