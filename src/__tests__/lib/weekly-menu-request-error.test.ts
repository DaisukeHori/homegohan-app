/**
 * 献立生成のリクエストの行 (weekly_menu_requests.error_message) に書く文・画面へ返す文 (#1172)
 *
 * error_message は GET /api/ai/menu/weekly/status を通って画面にそのまま出る。
 * ここでは、書く側 (markWeeklyMenuRequestFailed) と読む側の部品が、内部の文 (DB・例外・Edge Function の応答の本文) を
 * 固定の文に置き換え、こちらで書いた文 (同意・stale・中止) だけをそのまま通すことを確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  AI_CONSENT_REQUIRED_MESSAGE,
} from '../../../supabase/functions/_shared/ai-consent';

const mockLogError = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  createLogger: (routeName: string) => ({
    error: (...args: unknown[]) => mockLogError(routeName, ...args),
  }),
}));

const {
  WEEKLY_MENU_REQUEST_CANCELLED_MESSAGE,
  WEEKLY_MENU_REQUEST_FAILED_MESSAGE,
  WEEKLY_MENU_REQUEST_STALE_MESSAGE,
  isKnownWeeklyMenuRequestErrorMessage,
  weeklyMenuRequestErrorMessageForResponse,
  weeklyMenuRequestStoredErrorMessage,
} = await import('@/lib/weekly-menu-request-error');
const { markWeeklyMenuRequestFailed } = await import('@/lib/generate-menu-v4-retry');

/** 実際に書かれていた内部の文 (書く側の出どころごと) */
const INTERNAL_MESSAGES = [
  // callGenerateMenuV4WithRetry の errorMessage (状態コードと Edge Function の応答の本文)
  'generate-menu-v4 failed after 3/3 attempts: status 500, body={"error":"relation \\"planned_meals\\" does not exist"}',
  // 例外の文面 (fetch の失敗など)
  'generate-menu-v4 failed after 1/3 attempts: TypeError: fetch failed',
  // cron が書いていた文
  'V5 returned 500: {"error":"duplicate key value violates unique constraint \\"weekly_menu_requests_pkey\\""}',
  // weekly/request が復元の件数を足した文
  'generate-menu-v4 failed after 3/3 attempts: status 502 (rollback: restored=1, skipped=0, failed=0)',
  // PostgREST の生のエラー文
  'new row violates row-level security policy for table "weekly_menus"',
];

const KNOWN_MESSAGES = [
  AI_CONSENT_REQUIRED_MESSAGE,
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  WEEKLY_MENU_REQUEST_STALE_MESSAGE,
  WEEKLY_MENU_REQUEST_CANCELLED_MESSAGE,
  WEEKLY_MENU_REQUEST_FAILED_MESSAGE,
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('src/lib/weekly-menu-request-error.ts', () => {
  it('こちらで書いた文の値 (画面が見分ける文はこの値で書かれている)', () => {
    expect(WEEKLY_MENU_REQUEST_STALE_MESSAGE).toBe('stale_request_timeout');
    expect(WEEKLY_MENU_REQUEST_CANCELLED_MESSAGE).toBe('中止しました');
  });

  it.each(KNOWN_MESSAGES)('こちらで書いた文 (%s) は、書くときも返すときもそのまま', (message) => {
    expect(isKnownWeeklyMenuRequestErrorMessage(message)).toBe(true);
    expect(weeklyMenuRequestStoredErrorMessage(message)).toBe(message);
    expect(weeklyMenuRequestErrorMessageForResponse(message)).toBe(message);
  });

  it.each(INTERNAL_MESSAGES)('内部の文 (%s) は、書くときも返すときも固定の文', (message) => {
    expect(isKnownWeeklyMenuRequestErrorMessage(message)).toBe(false);
    expect(weeklyMenuRequestStoredErrorMessage(message)).toBe(WEEKLY_MENU_REQUEST_FAILED_MESSAGE);
    expect(weeklyMenuRequestErrorMessageForResponse(message)).toBe(WEEKLY_MENU_REQUEST_FAILED_MESSAGE);
  });

  it('同意の文に余計な文が付いたもの (前後の空白・件数) は、こちらで書いた文と見なさない', () => {
    for (const message of [`${AI_CONSENT_REQUIRED_MESSAGE} `, `${AI_CONSENT_REQUIRED_MESSAGE} (rollback: restored=1)`]) {
      expect(weeklyMenuRequestStoredErrorMessage(message)).toBe(WEEKLY_MENU_REQUEST_FAILED_MESSAGE);
    }
  });

  it('返すとき: 空 (null・undefined・空文字) は null。文字列でない値は固定の文', () => {
    expect(weeklyMenuRequestErrorMessageForResponse(null)).toBeNull();
    expect(weeklyMenuRequestErrorMessageForResponse(undefined)).toBeNull();
    expect(weeklyMenuRequestErrorMessageForResponse('')).toBeNull();
    expect(weeklyMenuRequestErrorMessageForResponse({ message: 'x' })).toBe(WEEKLY_MENU_REQUEST_FAILED_MESSAGE);
    expect(weeklyMenuRequestStoredErrorMessage(undefined)).toBe(WEEKLY_MENU_REQUEST_FAILED_MESSAGE);
  });
});

describe('markWeeklyMenuRequestFailed (src/lib/generate-menu-v4-retry.ts)', () => {
  function makeSupabase() {
    const writes: Array<Record<string, unknown>> = [];
    const eqCalls: unknown[][] = [];
    const supabase = {
      from: (table: string) => {
        expect(table).toBe('weekly_menu_requests');
        return {
          update: (values: Record<string, unknown>) => {
            writes.push(values);
            return {
              eq: async (...args: unknown[]) => {
                eqCalls.push(args);
                return { error: null };
              },
            };
          },
        };
      },
    };
    return { supabase, writes, eqCalls };
  }

  it.each(INTERNAL_MESSAGES)('内部の文 (%s) は行に書かず固定の文を書き、原因は構造化ログにだけ残す', async (message) => {
    const { supabase, writes, eqCalls } = makeSupabase();

    await markWeeklyMenuRequestFailed({ supabase, requestId: 'req-1', errorMessage: message });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ status: 'failed', error_message: WEEKLY_MENU_REQUEST_FAILED_MESSAGE });
    expect(eqCalls).toEqual([['id', 'req-1']]);
    expect(mockLogError).toHaveBeenCalledTimes(1);
    const [routeName, , loggedError, metadata] = mockLogError.mock.calls[0];
    expect(routeName).toBe('markWeeklyMenuRequestFailed');
    expect(loggedError).toBeInstanceOf(Error);
    expect((loggedError as Error).message).toBe(message);
    expect(metadata).toEqual({ weekly_menu_request_id: 'req-1' });
  });

  it('空の文も固定の文を書き、ログには unknown_error を残す', async () => {
    const { supabase, writes } = makeSupabase();

    await markWeeklyMenuRequestFailed({ supabase, requestId: 'req-1', errorMessage: '' });

    expect(writes[0]).toMatchObject({ error_message: WEEKLY_MENU_REQUEST_FAILED_MESSAGE });
    expect((mockLogError.mock.calls[0][2] as Error).message).toBe('unknown_error');
  });

  it.each([AI_CONSENT_REQUIRED_MESSAGE, AI_CONSENT_CHECK_FAILED_MESSAGE])(
    '同意の判定で止めた文 (%s) は、画面が見分けられるようそのまま書く (ログは残さない)',
    async (message) => {
      const { supabase, writes } = makeSupabase();

      await markWeeklyMenuRequestFailed({ supabase, requestId: 'req-1', errorMessage: message });

      expect(writes[0]).toMatchObject({ status: 'failed', error_message: message });
      expect(mockLogError).not.toHaveBeenCalled();
    },
  );
});
