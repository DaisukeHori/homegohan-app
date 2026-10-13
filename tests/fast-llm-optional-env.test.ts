// @vitest-environment node
/**
 * #1522 src/lib/ai/fast-llm.ts の getFastLLMModel / getFastLLMBaseUrl が、任意の変数 FAST_LLM_MODEL・XAI_BASE_URL を
 * process.env から直接読んでいた問題の回帰テスト
 *
 * いまは src/lib/env.ts の getOptionalEnv で読む (ほかの任意の変数と同じ読み方。未設定・空・空白だけなら undefined で、
 * プロセスごとに 1 回だけ警告をサーバーのログに出す)。無いときの既定値は以前と同じ。
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ logWarn: vi.fn() }));

// getOptionalEnv の警告 (src/lib/env.ts が動的に読む db-logger) は DB に書かず、呼び出しだけ見る
vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: h.logWarn, error: vi.fn(), withUser: () => logger };
  return { createLogger: () => logger, generateRequestId: () => 'req_test' };
});

const DEFAULT_MODEL = 'grok-4-1-fast-non-reasoning';
const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const NAMES = ['FAST_LLM_MODEL', 'XAI_BASE_URL'] as const;
const original = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

/** env.ts の「1 回だけ出す警告」の記録も消すため、毎回読み直す */
async function loadFastLLM() {
  vi.resetModules();
  return import('../src/lib/ai/fast-llm');
}

function setEnv(name: (typeof NAMES)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** 警告が出た変数名 (警告は db-logger を動的に読み込んでから出るので、出るまで待つ) */
async function warnedNames(): Promise<string[]> {
  await vi.waitFor(() => expect(h.logWarn).toHaveBeenCalled());
  return h.logWarn.mock.calls.map(([, metadata]) => String((metadata as { envName?: string }).envName));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const name of NAMES) setEnv(name, original[name]);
});

describe('FAST_LLM_MODEL・XAI_BASE_URL が無いとき: 既定値は以前と同じ (#1522)', () => {
  it.each([
    ['未設定', undefined],
    ['空', ''],
    ['空白だけ', '   '],
  ])('%s なら既定のモデルと既定のベース URL を使う', async (_label, value) => {
    setEnv('FAST_LLM_MODEL', value);
    setEnv('XAI_BASE_URL', value);
    const mod = await loadFastLLM();

    expect(mod.getFastLLMModel()).toBe(DEFAULT_MODEL);
    expect(mod.getFastLLMBaseUrl()).toBe(DEFAULT_BASE_URL);
    expect(mod.getFastLLMChatCompletionsUrl()).toBe(`${DEFAULT_BASE_URL}/chat/completions`);
  });

  it('getOptionalEnv で読むので、無い変数の名前はサーバーのログ (警告) に 1 回だけ残る', async () => {
    setEnv('FAST_LLM_MODEL', undefined);
    setEnv('XAI_BASE_URL', undefined);
    const mod = await loadFastLLM();

    mod.getFastLLMModel();
    mod.getFastLLMModel();
    mod.getFastLLMBaseUrl();
    mod.getFastLLMBaseUrl();

    await vi.waitFor(() => expect(h.logWarn).toHaveBeenCalledTimes(NAMES.length));
    expect((await warnedNames()).sort()).toEqual([...NAMES].sort());
  });
});

describe('FAST_LLM_MODEL・XAI_BASE_URL があるとき: 以前と同じ値を使う (#1522)', () => {
  it('モデルは前後の空白を除いた値・ベース URL は末尾の / を除いて /v1 を付ける', async () => {
    setEnv('FAST_LLM_MODEL', '  grok-test-model  ');
    setEnv('XAI_BASE_URL', 'https://example.x.ai/');
    const mod = await loadFastLLM();

    expect(mod.getFastLLMModel()).toBe('grok-test-model');
    expect(mod.getFastLLMBaseUrl()).toBe('https://example.x.ai/v1');
    expect(h.logWarn).not.toHaveBeenCalled();
  });

  it('ベース URL が /v1 で終わっていれば、そのまま使う', async () => {
    setEnv('XAI_BASE_URL', 'https://proxy.example.com/v1');
    const mod = await loadFastLLM();

    expect(mod.getFastLLMBaseUrl()).toBe('https://proxy.example.com/v1');
  });
});

describe('fast-llm.ts は任意の変数を process.env から直接読まない (#1522)', () => {
  it('ソースに process.env の読み取りが無い (getOptionalEnv を通す)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'ai', 'fast-llm.ts'), 'utf-8');
    // コメントの中の言及は数えない
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/process\.env/);
    for (const name of NAMES) expect(code).toContain(`getOptionalEnv("${name}")`);
  });
});
