/**
 * テスト用: Edge Functions の同意の判定 (supabase/functions/_shared/ai-consent-guard.ts) を「同意済み」に差し替える (T15 / #1154)
 *
 * 同意の判定とは関係のない Edge Function のテスト (入力検証・CORS など) で使う。
 *
 *   vi.mock('../supabase/functions/_shared/ai-consent-guard.ts', () => import('./helpers/edge-ai-consent-guard-allowed'));
 *
 * 同意が無いときに AI へ送らないことは tests/ai-consent-enforcement-edge.test.ts が実際のハンドラと構文木で確かめる。
 */
import {
  aiConsentDeniedPayload,
  type AiConsentDecision,
} from '../../supabase/functions/_shared/ai-consent';

export type { AiConsentDecision };

// vi.fn にしない: テストの beforeEach の vi.resetAllMocks() で中身が消えて undefined を返すようになるため
export async function checkAiConsent(): Promise<AiConsentDecision> {
  return { allowed: true };
}

export async function requireAiConsent(): Promise<Response | null> {
  return null;
}

export async function requireAiConsentForUser(): Promise<Response | null> {
  return null;
}

export function aiConsentDeniedResponse(
  decision: Extract<AiConsentDecision, { allowed: false }>,
  headers: Record<string, string> = {},
): Response {
  const { status, body } = aiConsentDeniedPayload(decision);
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
