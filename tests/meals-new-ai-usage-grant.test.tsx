/**
 * #1149 (T40) の是正: 写真の「オート」は 1 回の操作を 1 回と数える (Web の /meals/new)
 *
 * 判別 (POST /api/ai/classify-photo) は、数えたあとに「数え済みの印」(aiUsageGrant) を応答で返す。画面は続く解析の本文の
 * aiUsageGrant に入れて送り、サーバーはその解析を数えない (印の確かめと 1 回だけ使えることはサーバーの仕事。
 * tests/ai-usage-photo-auto-grant.test.ts)。ここでは画面が印を正しく運ぶことを確かめる:
 *   - オートで判別できた: 続く解析の本文に、判別が返した印をそのまま入れる
 *   - オートで判別できなかった (422) あと、種類を手で選んだ: その解析にも判別の印を入れる (判別の続き)
 *   - 種類を最初から選んだ (判別しない): 印を入れない (サーバーが数える)
 * 描画の仕組みは tests/health-photo-entry.test.tsx と同じ (react-dom/client + act)。
 */

import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── モック (vi.hoisted: vi.mock のファクトリから参照するため) ────────────────────
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  /** useSearchParams が返すクエリ文字列 (先頭の ? は付けない) */
  query: { value: '' },
  logToServer: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, back: mocks.back }),
  useSearchParams: () => new URLSearchParams(mocks.query.value),
}));

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

// framer-motion はアニメーション完了待ちが jsdom で不安定なので素通しにする。
// motion.div などは毎回同じコンポーネントを返す (違う型になると再描画のたびに作り直されてしまう)。
vi.mock('framer-motion', async () => {
  const react = await import('react');
  const cache: Record<string, unknown> = {};
  const passthrough = (tag: string) =>
    function Passthrough({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      whileTap: _whileTap,
      whileHover: _whileHover,
      ...rest
    }: Record<string, unknown> & { children?: ReactNode }) {
      return react.createElement(tag, rest, children);
    };
  return {
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) => (cache[tag] ??= passthrough(tag)),
      },
    ),
    AnimatePresence: ({ children }: { children?: ReactNode }) =>
      react.createElement(react.Fragment, null, children),
  };
});

// recharts の ResponsiveContainer は ResizeObserver が要るが、jsdom には無い。グラフの描画はこのテストの対象外。
vi.mock('recharts', async () => {
  const react = await import('react');
  const Box = ({ children }: { children?: ReactNode }) => react.createElement('div', null, children);
  const Empty = () => null;
  return { LineChart: Box, ResponsiveContainer: Box, Line: Empty, XAxis: Empty, YAxis: Empty, ReferenceLine: Empty };
});

vi.mock('@/lib/db-logger', () => ({
  logToServer: mocks.logToServer,
}));

import MealCaptureModal from '@/app/(main)/meals/new/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── 定数 ───────────────────────────────────────────────────────────────────────
/** 判別が返す数え済みの印 (中身はサーバーが確かめる。画面はそのまま送るだけ) */
const GRANT = 'g1.1760000000.0f8fad5b-d9cb-469f-a165-70867728950e.' + 'a'.repeat(64);
/** 判別の確からしさ (画面が判別できたとみなす値より上) */
const CONFIDENT = 0.92;
/** AI が読み取った体重 (結果の画面に進めるための値) */
const AI_READ_WEIGHT = 62.3;

/** モード選択の見出し。撮影ステップに進んでいれば出ない */
const MODE_SELECT_PROMPT = '撮影するものを選んでください';

// ── 描画と操作のヘルパー ───────────────────────────────────────────────────────
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

/** 差し替えた URL の静的メソッドを元に戻す (元から無ければ消す) */
function restoreUrlMethod(name: 'createObjectURL' | 'revokeObjectURL', original: PropertyDescriptor | undefined) {
  if (original) {
    Object.defineProperty(URL, name, original);
  } else {
    delete (URL as unknown as Record<string, unknown>)[name];
  }
}

const text = () => container.textContent ?? '';

async function renderPage(Page: ComponentType, query = '') {
  mocks.query.value = query;
  await act(async () => {
    root.render(createElement(Page));
  });
  await act(async () => {});
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
}

async function click(el: HTMLElement | undefined | null, what: string) {
  expect(el, `クリック対象が見つからない: ${what}\n--- 画面のテキスト ---\n${text()}`).toBeTruthy();
  await act(async () => {
    el!.click();
  });
}

/** 条件を満たすまで待つ (FileReader など、act だけでは進まない非同期処理を待つため) */
async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`待機がタイムアウト: ${what}\n--- 画面のテキスト ---\n${text()}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/** 撮影ステップか (写真を選ぶ入力が出ていて、モード選択の見出しが無い) */
const isCaptureStep = () =>
  container.querySelectorAll('input[type="file"]').length > 0 && !text().includes(MODE_SELECT_PROMPT);

const isModeSelectStep = () =>
  text().includes(MODE_SELECT_PROMPT) && container.querySelectorAll('input[type="file"]').length === 0;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** fetch の呼び出しのうち、指定 URL へのものを取り出す */
const callsTo = (url: string) => fetchMock.mock.calls.filter((call) => call[0] === url);

/** jsdom は画像を読み込まない (load も error も発火しない) ので、読み込み失敗として即座に返す偽物に差し替える。
 *  meals/new は読み込めなければ「圧縮せず元の画像をそのまま送る」経路に進む */
class UnloadableImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onerror?.());
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.value = '';

  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/ai/classify-photo') {
      return jsonResponse({ type: 'weight_scale', confidence: CONFIDENT, candidates: [], aiUsageGrant: GRANT });
    }
    if (url === '/api/ai/analyze-weight-scale') return jsonResponse({ weight: AI_READ_WEIGHT, confidence: CONFIDENT });
    if (url.startsWith('/api/health/records/history')) return jsonResponse([]);
    throw new Error(`想定外の fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Image', UnloadableImage);
  vi.stubGlobal('alert', vi.fn());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // jsdom には Blob URL の生成・解放が無い
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:http://localhost/weight-scale-photo'),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreUrlMethod('createObjectURL', originalCreateObjectURL);
  restoreUrlMethod('revokeObjectURL', originalRevokeObjectURL);
});

// ═══════════════════════════════════════════════════════════════════════════════
async function takePhoto() {
  const input = container.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
  expect(input, '撮影ステップに写真の入力が無い').not.toBeNull();
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'scale.jpg', { type: 'image/jpeg' });
  Object.defineProperty(input!, 'files', { value: [file], configurable: true });
  await act(async () => {
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function analyze(buttonLabel: string) {
  await takePhoto();
  await waitUntil(() => findButton(buttonLabel) !== undefined, `「${buttonLabel}」ボタン`);
  await click(findButton(buttonLabel), buttonLabel);
}

const analyzeBodies = () => callsTo('/api/ai/analyze-weight-scale').map((call) => JSON.parse(call[1].body as string) as Record<string, unknown>);

describe('#1149 写真の「オート」: 判別の数え済みの印を、続く解析に付ける', () => {
  it('判別できた: 続く解析の本文の aiUsageGrant に、判別が返した印を入れる', async () => {
    await renderPage(MealCaptureModal, 'mode=auto');
    await analyze('AIが判別して解析');
    await waitUntil(() => analyzeBodies().length > 0, '解析のリクエスト');

    expect(callsTo('/api/ai/classify-photo')).toHaveLength(1);
    expect(analyzeBodies()).toHaveLength(1);
    expect(analyzeBodies()[0].aiUsageGrant).toBe(GRANT);
  });

  it('判別できなかった (422) あと、種類を手で選んだ: その解析にも判別の印を入れる', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/ai/classify-photo') {
        return jsonResponse({ error: '判定できませんでした', code: 'unknown_type', message: '判定できませんでした', type: 'unknown', confidence: 0, aiUsageGrant: GRANT }, 422);
      }
      if (url === '/api/ai/analyze-weight-scale') return jsonResponse({ weight: AI_READ_WEIGHT, confidence: CONFIDENT });
      if (url.startsWith('/api/health/records/history')) return jsonResponse([]);
      throw new Error(`想定外の fetch: ${url}`);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage(MealCaptureModal, 'mode=auto');
    await analyze('AIが判別して解析');
    await waitUntil(() => findButton('体重計として続ける') !== undefined, '判別できなかった画面');

    await click(findButton('体重計として続ける'), '体重計として続ける');
    await waitUntil(() => analyzeBodies().length > 0, '解析のリクエスト');
    expect(analyzeBodies()[0].aiUsageGrant).toBe(GRANT);
  });

  it('種類を最初から選んだ (判別しない): 解析に印を入れない', async () => {
    await renderPage(MealCaptureModal, 'mode=weight_scale');
    await analyze('AIで解析する');
    await waitUntil(() => analyzeBodies().length > 0, '解析のリクエスト');

    expect(callsTo('/api/ai/classify-photo')).toHaveLength(0);
    expect(analyzeBodies()[0]).not.toHaveProperty('aiUsageGrant');
  });
});
