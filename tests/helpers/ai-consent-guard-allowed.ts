/**
 * テスト用: 外国の AI 事業者への提供の同意の判定 (src/lib/ai/consent-guard.ts) を「同意済み」に差し替える (T15 / #1154)
 *
 * 同意の判定とは関係のない API Route のテスト (レート制限・入力検証・応答の形など) で使う。
 * テストの Supabase の作り物は external_data_consents を読めないので、そのままでは判定が「読めない」(503) になるため。
 *
 *   vi.mock('@/lib/ai/consent-guard', () => import('../helpers/ai-consent-guard-allowed'));
 *
 * 同意が無いときに AI へ送らないことは tests/ai-consent-enforcement-routes.test.ts が実際の route を呼んで確かめる。
 * このファイルは '@/lib/ai/consent-guard' を import しない (差し替えた先から自分を読むと循環するため)。
 */
import { NextResponse } from 'next/server';
import * as core from '../../supabase/functions/_shared/ai-consent';
import type { AiConsentDecision } from '../../supabase/functions/_shared/ai-consent';

export function aiConsentDeniedPayload(decision: Extract<AiConsentDecision, { allowed: false }>) {
  return core.aiConsentDeniedPayload(decision);
}

export function aiConsentSkippedField(decision: AiConsentDecision | null) {
  return core.aiConsentSkippedField(decision);
}

// vi.fn にしない: テストの beforeEach の vi.resetAllMocks() で中身が消えて undefined を返すようになるため
export async function checkUserAiConsent(): Promise<AiConsentDecision> {
  return { allowed: true };
}

export async function requireAiConsent(): Promise<NextResponse | null> {
  return null;
}

export function aiConsentDeniedResponse(decision: Extract<AiConsentDecision, { allowed: false }>): NextResponse {
  const { status, body } = core.aiConsentDeniedPayload(decision);
  return NextResponse.json(body, { status });
}
