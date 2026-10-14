/**
 * 買い物リストの作り直しのリクエストの行 (shopping_list_requests.result) を画面へ返すときの形 (#1172)
 * src/lib/shopping-list-request-error.ts の部品の境界を確かめる (route の挙動は src/__tests__/api/shopping-list/regenerate-status.test.ts)
 */
import { describe, expect, it } from 'vitest';
import {
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  AI_CONSENT_REQUIRED_MESSAGE,
} from '../../../supabase/functions/_shared/ai-consent';
import {
  SHOPPING_LIST_REQUEST_FAILED_MESSAGE,
  shoppingListRequestErrorMessageForResponse,
  shoppingListRequestResultForResponse,
} from '@/lib/shopping-list-request-error';

describe('src/lib/shopping-list-request-error.ts', () => {
  it.each([AI_CONSENT_REQUIRED_MESSAGE, AI_CONSENT_CHECK_FAILED_MESSAGE, SHOPPING_LIST_REQUEST_FAILED_MESSAGE])(
    'こちらで書いた文 (%s) はそのまま返す',
    (message) => {
      expect(shoppingListRequestErrorMessageForResponse(message)).toBe(message);
    },
  );

  it.each([
    'insert or update on table "shopping_list_items" violates foreign key constraint "shopping_list_items_shopping_list_id_fkey"',
    'Fast LLM API error: 429 - {"error":"rate_limited"}',
    'Unknown error',
    // 同意の文の前後に何か付いたものは、こちらで書いた文ではない (完全一致だけを通す)
    `${AI_CONSENT_REQUIRED_MESSAGE} (rollback)`,
  ])('それ以外の文 (%s) は固定の文にする', (message) => {
    expect(shoppingListRequestErrorMessageForResponse(message)).toBe(SHOPPING_LIST_REQUEST_FAILED_MESSAGE);
  });

  it('文字列でない値は固定の文にする', () => {
    expect(shoppingListRequestErrorMessageForResponse({ message: 'x', code: '23505' })).toBe(SHOPPING_LIST_REQUEST_FAILED_MESSAGE);
    expect(shoppingListRequestErrorMessageForResponse(500)).toBe(SHOPPING_LIST_REQUEST_FAILED_MESSAGE);
  });

  it('空 (null・undefined・空文字) はそのまま返す (画面は自分の既定の文を出す)', () => {
    expect(shoppingListRequestErrorMessageForResponse(null)).toBeNull();
    expect(shoppingListRequestErrorMessageForResponse(undefined)).toBeUndefined();
    expect(shoppingListRequestErrorMessageForResponse('')).toBe('');
  });

  it('result: error だけを絞り、ほかの項目はそのまま残す', () => {
    expect(shoppingListRequestResultForResponse({ error: 'permission denied for table shopping_lists', stats: { outputCount: 1 } })).toEqual({
      error: SHOPPING_LIST_REQUEST_FAILED_MESSAGE,
      stats: { outputCount: 1 },
    });
    const success = { stats: { inputCount: 3, outputCount: 2, mergedCount: 1 } };
    expect(shoppingListRequestResultForResponse(success)).toEqual(success);
  });

  it('result: null・undefined・オブジェクトでない値 (文字列・数・配列) は null', () => {
    expect(shoppingListRequestResultForResponse(null)).toBeNull();
    expect(shoppingListRequestResultForResponse(undefined)).toBeNull();
    expect(shoppingListRequestResultForResponse('relation "x" does not exist')).toBeNull();
    expect(shoppingListRequestResultForResponse(42)).toBeNull();
    expect(shoppingListRequestResultForResponse(['relation "x" does not exist'])).toBeNull();
  });
});
