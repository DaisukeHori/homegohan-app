/**
 * e2e のテスト用アカウントに、外国の AI 事業者への提供の同意を記録する (T15 / #1154)
 *
 * 未同意の利用者のデータは、サーバーが AI へ送る手前で止める (403 AI_CONSENT_REQUIRED)。
 * AI を使う e2e (写真の解析・AI 相談・献立の生成など) が同意済みで動くよう、テスト用のアカウントを作るときに記録する。
 *   - scripts/create-e2e-accounts.ts (ローカルの e2e-user-01〜10)
 *   - tests/e2e/fixtures/fresh-user.ts (test ごとに作るユーザー。同意画面そのものを試す spec は記録しない)
 * service role で書く (アプリの POST /api/ai/consent と同じく、全事業者について現行の版の行を 1 つずつ。
 * すでに現行の版に同意している事業者は何もしない。古い版の行は閉じてから作る)。
 * 本番の e2e-user (e2e.yml) は、tests/e2e/helpers/ai-consent.ts の ensureAiConsentGranted がアプリの API で記録する。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { AI_CONSENT_PROVIDERS, AI_CONSENT_TABLE, AI_CONSENT_VERSION } from '../../supabase/functions/_shared/ai-consent';

/** 同意の記録に残す User-Agent (e2e が作った行だと分かるようにする) */
const E2E_USER_AGENT = 'homegohan-e2e-setup';

export async function grantE2eAiConsent(admin: SupabaseClient, userId: string): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from(AI_CONSENT_TABLE)
    .select('id, provider, consented, policy_version')
    .eq('user_id', userId)
    .is('revoked_at', null);
  if (error) throw new Error(`[e2e] AI の同意の読み取りに失敗: ${error.message}`);
  const active = (data ?? []) as Array<{ id: string; provider: string; consented: boolean; policy_version: string | null }>;

  for (const provider of AI_CONSENT_PROVIDERS) {
    const current = active.find((row) => row.provider === provider);
    if (current && current.consented && current.policy_version === AI_CONSENT_VERSION) continue;
    if (current) {
      const { error: closeError } = await admin
        .from(AI_CONSENT_TABLE)
        .update({ revoked_at: now })
        .eq('id', current.id)
        .eq('user_id', userId);
      if (closeError) throw new Error(`[e2e] 古い AI の同意を閉じられない (${provider}): ${closeError.message}`);
    }
    const { error: insertError } = await admin.from(AI_CONSENT_TABLE).insert({
      user_id: userId,
      provider,
      consented: true,
      consented_at: now,
      user_agent: E2E_USER_AGENT,
      policy_version: AI_CONSENT_VERSION,
    });
    if (insertError) throw new Error(`[e2e] AI の同意を記録できない (${provider}): ${insertError.message}`);
  }
}
