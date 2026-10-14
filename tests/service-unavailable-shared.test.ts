/**
 * #1457: 503 (AI 相談の緊急停止・メンテナンス中) の code と固定の文は、packages/shared/src/service-unavailable.ts の 1 つに置く
 *
 * サーバーの応答 (src/lib/ai/ai-chat-gate.ts・src/lib/maintenance-mode.ts) と、画面 (Web・モバイル) が出す固定の文が
 * 同じ値であることを、実際の応答の本文を読んで確かめる。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/feature-flags', () => ({
  // ai_chat_enabled を OFF (緊急停止中) として答える
  isFeatureEnabled: vi.fn(async () => false),
}));

import {
  AI_CHAT_DISABLED_CODE as SHARED_AI_CHAT_DISABLED_CODE,
  AI_CHAT_DISABLED_MESSAGE as SHARED_AI_CHAT_DISABLED_MESSAGE,
  MAINTENANCE_API_CODE as SHARED_MAINTENANCE_API_CODE,
  MAINTENANCE_MESSAGE as SHARED_MAINTENANCE_MESSAGE,
  SERVICE_UNAVAILABLE_STATUS,
  serviceUnavailableMessageOfBody,
} from '@homegohan/shared';
import { aiChatDisabledResponse } from '@/lib/ai/ai-chat-gate';
import { AI_CHAT_DISABLED_CODE, AI_CHAT_DISABLED_MESSAGE } from '@/lib/ai/ai-chat-unavailable';
import { MAINTENANCE_API_CODE, MAINTENANCE_MESSAGE, maintenanceApiResponse } from '@/lib/maintenance-mode';

describe('Web のサーバーの定数は、共有の値そのもの', () => {
  it('AI 相談の緊急停止・メンテナンス中の code と文', () => {
    expect(AI_CHAT_DISABLED_CODE).toBe(SHARED_AI_CHAT_DISABLED_CODE);
    expect(AI_CHAT_DISABLED_MESSAGE).toBe(SHARED_AI_CHAT_DISABLED_MESSAGE);
    expect(MAINTENANCE_API_CODE).toBe(SHARED_MAINTENANCE_API_CODE);
    expect(MAINTENANCE_MESSAGE).toBe(SHARED_MAINTENANCE_MESSAGE);
    expect(SERVICE_UNAVAILABLE_STATUS).toBe(503);
  });
});

describe('サーバーの実際の 503 の本文から、画面に出す固定の文を読める', () => {
  it('メンテナンス中 (ミドルウェアの応答)', async () => {
    const res = maintenanceApiResponse();
    expect(res.status).toBe(SERVICE_UNAVAILABLE_STATUS);
    const body = await res.json();
    expect(serviceUnavailableMessageOfBody(body)).toBe(SHARED_MAINTENANCE_MESSAGE);
    // #1486: Web の画面が本文の data.error をそのまま出しても、同じ固定の文になる
    expect(body.error).toBe(SHARED_MAINTENANCE_MESSAGE);
  });

  it('AI 相談の緊急停止 (AI 相談の API のゲートの応答)', async () => {
    const res = await aiChatDisabledResponse('user-1');
    expect(res?.status).toBe(SERVICE_UNAVAILABLE_STATUS);
    expect(serviceUnavailableMessageOfBody(await res?.json())).toBe(SHARED_AI_CHAT_DISABLED_MESSAGE);
  });
});

describe('serviceUnavailableMessageOfBody', () => {
  it('本文の文字列ではなく、code から決めた固定の文を返す', () => {
    expect(serviceUnavailableMessageOfBody({ error: '別の文', code: SHARED_AI_CHAT_DISABLED_CODE })).toBe(
      SHARED_AI_CHAT_DISABLED_MESSAGE,
    );
    // メンテナンス中の本文は #1486 から平らな形 (サーバーの実際の応答は上の「メンテナンス中 (ミドルウェアの応答)」)
    expect(serviceUnavailableMessageOfBody({ error: '別の文', code: SHARED_MAINTENANCE_API_CODE, retryAfter: 300 })).toBe(
      SHARED_MAINTENANCE_MESSAGE,
    );
    // #1486 より前の入れ子の形も受ける (配布済みの古いサーバーとの組み合わせ)
    expect(
      serviceUnavailableMessageOfBody({ error: { code: SHARED_MAINTENANCE_API_CODE, message: '別の文' } }),
    ).toBe(SHARED_MAINTENANCE_MESSAGE);
  });

  it.each([
    ['ほかの code', { error: 'x', code: 'AI_CONSENT_CHECK_FAILED' }],
    ['入れ子のほかの code', { error: { code: 'INTERNAL_ERROR', message: 'x' } }],
    ['code が無い', { error: 'x' }],
    ['Object の組み込みの名前', { code: 'toString' }],
    ['null', null],
    ['文字列', 'MAINTENANCE_MODE'],
  ])('%s は null', (_label, body) => {
    expect(serviceUnavailableMessageOfBody(body)).toBeNull();
  });
});
