// @vitest-environment node
//
// Edge Function の本体を読み込むので node 環境で動かす (jsdom では Edge Runtime の型宣言の import を空のモジュールに差し替えられない)
/**
 * Edge Function が失敗したとき、リクエストの行 (画面がそのまま出す欄) に例外の文面を書かない (#1478。#1172 の続き)
 *
 * 以前は generate-menu-v4 / v5 の catch が weekly_menu_requests.error_message に、regenerate-shopping-list-v2 の catch が
 * shopping_list_requests.result.error に、捕まえた例外の文面 (DB の生のエラー文など) をそのまま書いていた。
 * 画面は Realtime や直接の select でこの欄を受けてそのまま出すので、API (状態の確認) では固定の文、Realtime では生の文が見えていた。
 *
 * ここでは同意を済ませた状態で、処理の途中の DB の読み取りと外部への通信を生のエラー文の例外で落とし、
 *   1. 行の失敗の欄には定型の文 (_shared/stored-failure-messages.ts) が入る
 *   2. 行の書き込みの値にも、応答の本文にも、生のエラー文が入らない
 *   3. 生のエラー文は構造化ログ (db-logger) か console にだけ残る
 * ことを、実際のハンドラを呼んで確かめる。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CONSENT_PROVIDERS, AI_CONSENT_TABLE, AI_CONSENT_VERSION } from '../supabase/functions/_shared/ai-consent';
import {
  MENU_REQUEST_FAILED_MESSAGE,
  SHOPPING_LIST_REQUEST_FAILED_MESSAGE,
} from '../supabase/functions/_shared/stored-failure-messages';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// Edge Function の本体の読み込みは重いので、このファイルだけ時間切れを延ばす (tests/helpers/heavy-unit-test-timeout.ts)
applyHeavyUnitTestTimeout();

// Edge Runtime の型宣言だけの import (node_modules に無い)。中身は無いので空のモジュールにする
vi.mock('@supabase/functions-js/edge-runtime.d.ts', () => ({}));

const USER = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ROLE_KEY = 'service-role-key';
/** DB の生のエラー文 (画面に出してはいけないもの)。処理の途中の読み取りがこの文の例外で落ちる */
const RAW_DB_ERROR = 'relation "public.secret_internal_table" does not exist';

/** 失敗の欄を書く表 (この表の読み書きは落とさない)。同意の表は同意済みを返す */
const WRITABLE_TABLES = new Set(['weekly_menu_requests', 'shopping_list_requests', AI_CONSENT_TABLE]);

const e = vi.hoisted(() => ({
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  loggedErrors: [] as unknown[],
}));

/** Supabase のクエリの作り物。update の値を記録する。失敗の欄を書く表と同意の表以外は、生のエラー文の例外で落ちる */
function fakeQuery(table: string): unknown {
  if (!WRITABLE_TABLES.has(table)) {
    throw new Error(RAW_DB_ERROR);
  }
  const result = () =>
    table === AI_CONSENT_TABLE
      ? {
          data: AI_CONSENT_PROVIDERS.map((provider) => ({ provider, consented: true, policy_version: AI_CONSENT_VERSION })),
          error: null,
        }
      : { data: null, error: null };
  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown, rej: (err: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve({ data: { user_id: USER, current_step: 1, status: 'processing' }, error: null });
        }
        if (prop === 'update') {
          return (values: Record<string, unknown>) => {
            e.updates.push({ table, values });
            return builder;
          };
        }
        return () => builder;
      },
    },
  );
  return builder;
}

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from: (table: string) => fakeQuery(table),
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock('../supabase/functions/_shared/db-logger.ts', () => {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (_message: string, error: unknown) => {
      e.loggedErrors.push(error);
    },
  };
  return { createLogger: () => ({ ...logger, withUser: () => logger }), generateRequestId: () => 'req_test' };
});

type Handler = (req: Request) => Promise<Response>;
const handlers: Record<string, Handler> = {};

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY: 'anon-key',
  // 外部の AI の鍵 (値は使わない)。無いと設定不足の例外 (文は固定) で先に止まり、生の文の経路を通らない
  AIMLAPI_API_KEY: 'test-aimlapi-key',
  XAI_API_KEY: 'test-xai-key',
  OPENAI_API_KEY: 'test-openai-key',
};

const WRITERS: Array<{
  name: string;
  table: string;
  load: () => Promise<unknown>;
  body: Record<string, unknown>;
  stored: (values: Record<string, unknown>) => unknown;
  fixedMessage: string;
}> = [
  {
    name: 'generate-menu-v4',
    table: 'weekly_menu_requests',
    load: () => import('../supabase/functions/generate-menu-v4/index.ts'),
    body: { requestId: REQUEST_ID, userId: USER, targetSlots: [{ date: '2026-10-10', mealType: 'dinner' }] },
    stored: (values) => values.error_message,
    fixedMessage: MENU_REQUEST_FAILED_MESSAGE,
  },
  {
    name: 'generate-menu-v5',
    table: 'weekly_menu_requests',
    load: () => import('../supabase/functions/generate-menu-v5/index.ts'),
    body: { requestId: REQUEST_ID, userId: USER, targetSlots: [{ date: '2026-10-10', mealType: 'dinner' }] },
    stored: (values) => values.error_message,
    fixedMessage: MENU_REQUEST_FAILED_MESSAGE,
  },
  {
    name: 'regenerate-shopping-list-v2',
    table: 'shopping_list_requests',
    load: () => import('../supabase/functions/regenerate-shopping-list-v2/index.ts'),
    body: { requestId: REQUEST_ID, userId: USER, startDate: '2026-10-10', endDate: '2026-10-11' },
    stored: (values) => (values.result as { error?: unknown } | undefined)?.error,
    fixedMessage: SHOPPING_LIST_REQUEST_FAILED_MESSAGE,
  },
];

beforeAll(async () => {
  for (const w of WRITERS) {
    vi.stubGlobal('Deno', {
      serve: (fn: Handler) => {
        handlers[w.name] = fn;
      },
      env: { get: (key: string) => ENV[key] },
    });
    await w.load();
  }
  vi.stubGlobal('Deno', { serve: () => undefined, env: { get: (key: string) => ENV[key] } });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  e.updates = [];
  e.loggedErrors = [];
  // 失敗の経路は console にも元の文を出す (それ自体は正しい)。テストの出力を汚さないように黙らせる
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // 外部への通信 (AI・埋め込み) も、生の文の例外で落とす (どの経路で失敗しても、行と本文に生の文が出ないことを見る)
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(RAW_DB_ERROR));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const request = (name: string, body: Record<string, unknown>) =>
  new Request(`http://localhost/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 例外の文面を含みうる値か (Error の message・文字列) */
const containsRaw = (value: unknown): boolean =>
  value instanceof Error ? value.message.includes(RAW_DB_ERROR) : JSON.stringify(value ?? null).includes('secret_internal_table');

describe.each(WRITERS)('Edge Function $name: 処理の途中で DB の生のエラーの例外が出たとき', (w) => {
  it('行の失敗の欄には定型の文を書き、行にも応答の本文にも生のエラー文を入れない。元の文は構造化ログか console にだけ残す', async () => {
    const res = await handlers[w.name](request(w.name, w.body));
    const responseText = await res.text();

    // 裏の処理 (waitUntil の無い環境では、応答を返したあとに走る) が失敗を書き終えるまで待つ
    await vi.waitFor(() => {
      expect(e.updates.filter((u) => u.table === w.table && u.values.status === 'failed').length).toBeGreaterThan(0);
    });

    const failed = e.updates.filter((u) => u.table === w.table && u.values.status === 'failed');
    for (const update of failed) {
      expect(w.stored(update.values)).toBe(w.fixedMessage);
    }
    // 行に書いたどの値 (失敗の欄・進捗の文など) にも、生のエラー文は入らない
    expect(JSON.stringify(e.updates)).not.toContain('secret_internal_table');
    // 応答の本文にも入らない
    expect(responseText).not.toContain('secret_internal_table');

    // 元の文はログ (構造化ログ・console) に残る (捨てていない)
    const consoleErrors = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat();
    expect([...e.loggedErrors, ...consoleErrors].some(containsRaw)).toBe(true);
  });
});
