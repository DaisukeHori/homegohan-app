// @vitest-environment node
//
// Edge Function の本体を読み込むので node 環境で動かす (jsdom では Edge Runtime の型宣言の import を空のモジュールに差し替えられない)
/**
 * #1486 AI 相談の緊急停止スイッチ (feature_flags の ai_chat_enabled) が、利用者の JWT で直接呼べる Edge Function knowledge-gpt も止める
 *
 * Next.js の AI 相談の API は src/lib/ai/ai-chat-gate.ts でスイッチを見る。knowledge-gpt は利用者の JWT で直接呼べる (#1153) ので、
 * JWT の経路でも、認証の直後・同意の判定の前に、supabase/functions/_shared/ai-chat-flag.ts でスイッチを見る。
 *
 * 1. 値の一致: Edge の文・code・状態・retryAfter・既定値・待ち時間の上限が、Next.js / packages/shared と同じ
 * 2. 判定 (isAiChatEnabledForUser): OFF なら false。行が無い・読めない・待ちきれないときは true (Next.js の isFeatureEnabled と同じ)。
 *    段階公開・条件つきの行は Next.js の evaluateFlag と同じ答え (判定は _shared/feature-flag-eval.ts を共用)
 * 3. 実際のハンドラ (knowledge-gpt): JWT の経路でスイッチが OFF なら、AI へ 1 回も送らず 503 AI_CHAT_DISABLED を返す。
 *    同意の判定と利用回数の記録はしない (止める位置が同意の判定より前)。読めないときは止めない。service role の経路は見ない
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Edge Runtime の型宣言だけの import (node_modules に無い)。中身は無いので空のモジュールにする
vi.mock('@supabase/functions-js/edge-runtime.d.ts', () => ({}));

// Next.js 側の定数を読むために import する部品が、DB やログに触らないようにする
vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: vi.fn(), createClient: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  AI_CHAT_DISABLED_CODE as SHARED_AI_CHAT_DISABLED_CODE,
  AI_CHAT_DISABLED_MESSAGE as SHARED_AI_CHAT_DISABLED_MESSAGE,
  SERVICE_UNAVAILABLE_STATUS,
} from '@homegohan/shared';
import { AI_CHAT_FLAG_KEY as NEXT_AI_CHAT_FLAG_KEY, AI_CHAT_RETRY_AFTER_SECONDS as NEXT_RETRY_AFTER } from '@/lib/ai/ai-chat-gate';
import { FEATURE_FLAG_DEFAULTS, FEATURE_FLAG_READ_TIMEOUT_MS } from '@/lib/feature-flags';
import { evaluateFlag, type FeatureFlagRecord } from '@/lib/super-admin/evaluate-flag';
import {
  AI_CHAT_DISABLED_CODE,
  AI_CHAT_DISABLED_MESSAGE,
  AI_CHAT_DISABLED_STATUS,
  AI_CHAT_FLAG_FALLBACK,
  AI_CHAT_FLAG_KEY,
  AI_CHAT_FLAG_READ_TIMEOUT_MS,
  AI_CHAT_RETRY_AFTER_SECONDS,
  aiChatDisabledEdgeResponse,
  isAiChatEnabledForUser,
  type AiChatFlagDb,
} from '../supabase/functions/_shared/ai-chat-flag';
import { AI_CONSENT_PROVIDERS, AI_CONSENT_TABLE, AI_CONSENT_VERSION } from '../supabase/functions/_shared/ai-consent';
import type { AiUsageResult } from '../supabase/functions/_shared/ai-daily-limit';
import { AI_USAGE_ALLOWED } from './helpers/ai-usage-mock';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// Edge Function の本体を読み込むので、重い機械では既定の時間切れを超えることがある (tests/helpers/heavy-unit-test-timeout.ts。#1488)
applyHeavyUnitTestTimeout();

const USER = '11111111-1111-4111-8111-111111111111';

// ─────────────────────────────────────────────
// 1. 値の一致
// ─────────────────────────────────────────────

describe('Edge の緊急停止の値は、Next.js / packages/shared と同じ', () => {
  it('文・code・状態・retryAfter・key・既定値・待ち時間の上限', () => {
    expect(AI_CHAT_DISABLED_CODE).toBe(SHARED_AI_CHAT_DISABLED_CODE);
    expect(AI_CHAT_DISABLED_MESSAGE).toBe(SHARED_AI_CHAT_DISABLED_MESSAGE);
    expect(AI_CHAT_DISABLED_STATUS).toBe(SERVICE_UNAVAILABLE_STATUS);
    expect(AI_CHAT_RETRY_AFTER_SECONDS).toBe(NEXT_RETRY_AFTER);
    expect(AI_CHAT_FLAG_KEY).toBe(NEXT_AI_CHAT_FLAG_KEY);
    expect(AI_CHAT_FLAG_FALLBACK).toBe(FEATURE_FLAG_DEFAULTS.ai_chat_enabled);
    expect(AI_CHAT_FLAG_READ_TIMEOUT_MS).toBe(FEATURE_FLAG_READ_TIMEOUT_MS);
  });

  it('止めたときの応答は Next.js の aiChatDisabledResponse と同じ本文・ヘッダー (CORS のヘッダーも付ける)', async () => {
    const res = aiChatDisabledEdgeResponse({ 'Access-Control-Allow-Origin': 'https://homegohan.app' });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://homegohan.app');
    await expect(res.json()).resolves.toEqual({
      error: SHARED_AI_CHAT_DISABLED_MESSAGE,
      code: SHARED_AI_CHAT_DISABLED_CODE,
      retryAfter: NEXT_RETRY_AFTER,
    });
  });
});

// ─────────────────────────────────────────────
// 2. 判定
// ─────────────────────────────────────────────

type ReadResult = { data: unknown; error: unknown };

/** 表ごとの読み出しの結果を決める、作り物の service role のクライアント */
function fakeDb(results: Record<string, () => PromiseLike<ReadResult>>): AiChatFlagDb & { reads: string[] } {
  const reads: string[] = [];
  const db = {
    reads,
    from(table: string) {
      reads.push(table);
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => (results[table] ?? (() => Promise.resolve({ data: null, error: null })))(),
      };
      return builder;
    },
  };
  return db as unknown as AiChatFlagDb & { reads: string[] };
}

function flagRow(overrides: Partial<FeatureFlagRecord> = {}): FeatureFlagRecord {
  return { key: 'ai_chat_enabled', enabled: true, rollout_strategy: null, constraints: null, ...overrides };
}

const ok = (data: unknown) => () => Promise.resolve({ data, error: null });

describe('isAiChatEnabledForUser', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('OFF (enabled: false) なら false、ON なら true', async () => {
    await expect(isAiChatEnabledForUser(fakeDb({ feature_flags: ok(flagRow({ enabled: false })) }), USER)).resolves.toBe(false);
    await expect(isAiChatEnabledForUser(fakeDb({ feature_flags: ok(flagRow()) }), USER)).resolves.toBe(true);
  });

  it('行が無いときは ON (Next.js の既定値と同じ。evaluateFlag の「行が無いと OFF」にはしない)', async () => {
    await expect(isAiChatEnabledForUser(fakeDb({ feature_flags: ok(null) }), USER)).resolves.toBe(true);
  });

  it('読み出しの失敗・例外・待ちきれないときは ON (止めない)', async () => {
    const failed = fakeDb({ feature_flags: () => Promise.resolve({ data: null, error: { message: 'connection refused' } }) });
    await expect(isAiChatEnabledForUser(failed, USER)).resolves.toBe(true);

    const thrown = fakeDb({ feature_flags: () => Promise.reject(new Error('boom')) });
    await expect(isAiChatEnabledForUser(thrown, USER)).resolves.toBe(true);

    const never = fakeDb({ feature_flags: () => new Promise<ReadResult>(() => undefined) });
    await expect(isAiChatEnabledForUser(never, USER, 5)).resolves.toBe(true);
  });

  it('全員一律の行では、ユーザーの属性を読まない', async () => {
    const db = fakeDb({ feature_flags: ok(flagRow({ enabled: false })) });
    await isAiChatEnabledForUser(db, USER);
    expect(db.reads).toEqual(['feature_flags']);
  });

  const STAGED: Array<[string, FeatureFlagRecord, Record<string, unknown>]> = [
    ['ロールの段階公開 (対象外)', flagRow({ rollout_strategy: { type: 'role', roles: ['admin'] } }), { roles: ['user'] }],
    ['ロールの段階公開 (対象)', flagRow({ rollout_strategy: { type: 'role', roles: ['admin'] } }), { roles: ['admin'] }],
    ['プランの除外 (プランが空なら free)', flagRow({ constraints: { exclude_plans: ['free'] } }), { plan_key_cached: null }],
    ['プランの条件 (対象)', flagRow({ constraints: { include_plans: ['pro'] } }), { plan_key_cached: 'pro' }],
    ['組織の段階公開 (対象外)', flagRow({ rollout_strategy: { type: 'org', org_ids: ['22222222-2222-4222-8222-222222222222'] } }), { organization_id: null }],
    ['百分率 (25%)', flagRow({ rollout_strategy: { type: 'percentage', value: 25 } }), {}],
  ];

  it.each(STAGED)('段階公開・条件つき: %s は Next.js の evaluateFlag と同じ答え', async (_label, record, profile) => {
    const db = fakeDb({ feature_flags: ok(record), user_profiles: ok({ roles: [], organization_id: null, plan_key_cached: null, created_at: null, ...profile }) });
    const edge = await isAiChatEnabledForUser(db, USER);

    const roles = Array.isArray(profile.roles) ? (profile.roles as string[]) : [];
    const next = evaluateFlag(record, {
      userId: USER,
      roles,
      organizationId: (profile.organization_id as string | null | undefined) ?? null,
      planKey: (profile.plan_key_cached as string | null | undefined) ?? 'free',
      accountCreatedAt: null,
    });
    expect(edge).toBe(next);
  });

  it('属性が要るのに本人の行を読めないときは ON (止めない)', async () => {
    const db = fakeDb({
      feature_flags: ok(flagRow({ rollout_strategy: { type: 'role', roles: ['admin'] } })),
      user_profiles: () => Promise.resolve({ data: null, error: { message: 'db error' } }),
    });
    await expect(isAiChatEnabledForUser(db, USER)).resolves.toBe(true);
    expect(db.reads).toEqual(['feature_flags', 'user_profiles']);
  });
});

// ─────────────────────────────────────────────
// 3. 実際のハンドラ (knowledge-gpt)
// ─────────────────────────────────────────────

const e = vi.hoisted(() => ({
  /** feature_flags の ai_chat_enabled の行の読み出しの結果 */
  flagResult: { data: null, error: null } as { data: unknown; error: unknown },
  /** 読んだ表 */
  tables: [] as string[],
  fastLLMCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"answer":"野菜を足しましょう"}' } }] })),
  /** global fetch のうち、AI 事業者へ送ったもの */
  aiFetch: vi.fn((_url: string) => undefined),
  consumeEdgeAiUsage: vi.fn(async (_req: Request, _userId: string, _feature: string): Promise<AiUsageResult> => ({
    allowed: true,
    metered: true,
    usageDate: '2026-10-11',
    limit: 10,
    used: 1,
  })),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const AI_URL_PATTERN = /api\.openai\.com|generativelanguage\.googleapis\.com|api\.x\.ai|api\.perplexity\.ai|api\.aimlapi\.com/;

function aiSendCount(): number {
  return e.fastLLMCreate.mock.calls.length + e.aiFetch.mock.calls.length;
}

function grantedConsent(): ReadResult {
  return { data: AI_CONSENT_PROVIDERS.map((provider) => ({ provider, consented: true, policy_version: AI_CONSENT_VERSION })), error: null };
}

function fakeQuery(table: string): unknown {
  e.tables.push(table);
  const result = (): ReadResult => (table === AI_CONSENT_TABLE ? grantedConsent() : { data: [], error: null });
  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown, rej: (err: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve(table === 'feature_flags' ? e.flagResult : { data: null, error: null });
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
    rpc: async () => ({ data: [], error: null }),
  }),
}));
vi.mock('../supabase/functions/_shared/db-logger.ts', () => ({
  createLogger: () => ({ ...e.logger, withUser: () => e.logger }),
  generateRequestId: () => 'req_test',
}));
vi.mock('../supabase/functions/_shared/fast-llm.ts', () => ({
  createFastLLMClient: () => ({ chat: { completions: { create: e.fastLLMCreate } } }),
  getFastLLMModel: () => 'test-model',
  getFastLLMApiKey: () => 'test-key',
  getFastLLMBaseUrl: () => 'https://api.x.ai/v1',
  getFastLLMChatCompletionsUrl: () => 'https://api.x.ai/v1/chat/completions',
  getFastLLMFetchHeaders: () => ({ 'Content-Type': 'application/json' }),
}));
vi.mock('../supabase/functions/_shared/llm-usage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/functions/_shared/llm-usage.ts')>()),
  withOpenAIUsageContext: async <T,>(_ctx: unknown, fn: () => Promise<T>) => fn(),
  generateExecutionId: () => 'exec_test',
}));
vi.mock('../supabase/functions/_shared/ai-usage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/functions/_shared/ai-usage.ts')>()),
  consumeEdgeAiUsage: e.consumeEdgeAiUsage,
}));

type Handler = (req: Request) => Promise<Response>;
let handler: Handler | null = null;
const ORIGIN = 'https://homegohan.app';

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_ANON_KEY: 'anon-key',
  XAI_API_KEY: 'test-xai-key',
  DATASET_EMBEDDING_API_KEY: 'test-embedding-key',
};

function knowledgeGptRequest(token: string): Request {
  return new Request('http://localhost/functions/v1/knowledge-gpt', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '夕食の相談' }] }),
  });
}

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (AI_URL_PATTERN.test(url)) e.aiFetch(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }], data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  vi.stubGlobal('Deno', {
    serve: (fn: Handler) => {
      handler = fn;
    },
    env: { get: (key: string) => ENV[key] },
  });
  await import('../supabase/functions/knowledge-gpt/index.ts');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  e.fastLLMCreate.mockClear();
  e.aiFetch.mockClear();
  e.consumeEdgeAiUsage.mockClear();
  e.consumeEdgeAiUsage.mockResolvedValue(AI_USAGE_ALLOWED);
  e.flagResult = { data: null, error: null };
  e.tables = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('knowledge-gpt (実際のハンドラ): AI 相談の緊急停止スイッチ (#1486)', () => {
  it('利用者の JWT の経路でスイッチが OFF: AI へ 1 回も送らず 503 AI_CHAT_DISABLED (CORS・Retry-After 付き)。同意の判定も記録もしない', async () => {
    e.flagResult = { data: flagRow({ enabled: false }), error: null };

    const res = await (handler as Handler)(knowledgeGptRequest('user-token'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: SHARED_AI_CHAT_DISABLED_MESSAGE,
      code: SHARED_AI_CHAT_DISABLED_CODE,
      retryAfter: NEXT_RETRY_AFTER,
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(aiSendCount()).toBe(0);
    expect(e.consumeEdgeAiUsage).not.toHaveBeenCalled();
    // 止める位置は同意の判定より前 (同意の表を読まない)
    expect(e.tables).toContain('feature_flags');
    expect(e.tables).not.toContain(AI_CONSENT_TABLE);
  });

  it('スイッチが ON: これまでどおり同意の判定 → 記録 → AI へ送る (上の 0 回が空振りでないことの確かめ)', async () => {
    e.flagResult = { data: flagRow({ enabled: true }), error: null };

    const res = await (handler as Handler)(knowledgeGptRequest('user-token'));

    expect(res.status).toBe(200);
    expect(aiSendCount()).toBeGreaterThanOrEqual(1);
    expect(e.consumeEdgeAiUsage).toHaveBeenCalledTimes(1);
    expect(e.tables.indexOf('feature_flags')).toBeLessThan(e.tables.indexOf(AI_CONSENT_TABLE));
  });

  it('スイッチを読めないときは止めない (ON。Next.js の isFeatureEnabled と同じ)', async () => {
    e.flagResult = { data: null, error: { message: 'connection refused' } };

    const res = await (handler as Handler)(knowledgeGptRequest('user-token'));

    expect(res.status).toBe(200);
    expect(aiSendCount()).toBeGreaterThanOrEqual(1);
  });

  it('service role の経路 (Next.js の AI 相談の API) では、Edge はスイッチを読まない (呼び出し元が見たあと)', async () => {
    e.flagResult = { data: flagRow({ enabled: false }), error: null };

    const res = await (handler as Handler)(knowledgeGptRequest(ENV.SUPABASE_SERVICE_ROLE_KEY));

    expect(res.status).not.toBe(503);
    expect(e.tables).not.toContain('feature_flags');
  });
});
