/**
 * #2050 (P8): 食事の記録の画面 (/meals/new) で、写真の解析の野菜スコアが 0 点のとき 50 点と表示されていた
 *
 * 野菜スコアは 0〜100 で、野菜が無ければ 0 (supabase/functions/_shared/veg-score.ts の vegScoreOfVegetableGrams)。
 * 画面は解析の応答を `data.vegScore || 50` で受けていたため、0 が 50 に置き換わっていた。
 * ここでは、解析の応答の vegScore をそのまま結果の「野菜」の欄に出すことを確かめる:
 *   - 0 点: 0 と出す (50 にしない)
 *   - 0 より大きい点: その値を出す
 *   - 応答に数が無い: 既定の 0 (画面の初期値) を出す。前の解析の値を残さない
 * 描画の仕組みは tests/meals-new-ai-usage-grant.test.tsx と同じ (react-dom/client + act)。
 */

import { act, createElement, type ReactNode } from 'react';
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
const ANALYZE_MEAL_PHOTO_URL = '/api/ai/analyze-meal-photo';
/** 結果の「野菜」の欄 */
const VEG_SCORE_TEST_ID = 'meal-result-veg-score';
/** 以前の画面が 0 の代わりに出していた値 (`data.vegScore || 50`) */
const FORMER_FALLBACK_VEG_SCORE = 50;
/** 0 より大きい野菜スコアの例 (0〜100 のうち、以前の置き換えの値と違うもの) */
const SOME_VEG_SCORE = 35;
/** 結果の画面に進むための解析の応答 (vegScore 以外) */
const ANALYSIS_BASE = {
  dishes: [{ name: '白ごはん', role: 'main', cal: 252, calories_kcal: 252 }],
  totalCalories: 252,
  totalProtein: 3.8,
  totalCarbs: 55.7,
  totalFat: 0.5,
  overallScore: 72,
  praiseComment: '',
  nutritionTip: '',
  nutritionalAdvice: '',
};

// ── 描画と操作のヘルパー ───────────────────────────────────────────────────────
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
/** 解析の応答の本文 (テストごとに差し替える) */
let analysisBody: Record<string, unknown>;

/** 差し替えた URL の静的メソッドを元に戻す (元から無ければ消す) */
function restoreUrlMethod(name: 'createObjectURL' | 'revokeObjectURL', original: PropertyDescriptor | undefined) {
  if (original) {
    Object.defineProperty(URL, name, original);
  } else {
    delete (URL as unknown as Record<string, unknown>)[name];
  }
}

const text = () => container.textContent ?? '';

async function renderPage(query: string) {
  mocks.query.value = query;
  await act(async () => {
    root.render(createElement(MealCaptureModal));
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

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** jsdom は画像を読み込まない (load も error も発火しない) ので、読み込み失敗として即座に返す偽物に差し替える。
 *  meals/new は読み込めなければ「圧縮せず元の画像をそのまま送る」経路に進む */
class UnloadableImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onerror?.());
  }
}

const vegScoreCell = () => container.querySelector(`[data-testid="${VEG_SCORE_TEST_ID}"]`);

/** 食事の写真を選んで「AIで解析する」を押し、結果の「野菜」の欄が出るまで待って、その文字を返す */
async function analyzeMealPhotoAndReadVegScore(): Promise<string> {
  const input = container.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
  expect(input, '撮影ステップに写真の入力が無い').not.toBeNull();
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'meal.jpg', { type: 'image/jpeg' });
  Object.defineProperty(input!, 'files', { value: [file], configurable: true });
  await act(async () => {
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitUntil(() => findButton('AIで解析する') !== undefined, '「AIで解析する」ボタン');
  await click(findButton('AIで解析する'), 'AIで解析する');
  await waitUntil(() => vegScoreCell() !== null, '結果の「野菜」の欄');
  return vegScoreCell()!.textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.value = '';
  analysisBody = { ...ANALYSIS_BASE };

  fetchMock = vi.fn(async (url: string) => {
    if (url === ANALYZE_MEAL_PHOTO_URL) return jsonResponse(analysisBody);
    throw new Error(`想定外の fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Image', UnloadableImage);
  vi.stubGlobal('alert', vi.fn());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // jsdom には Blob URL の生成・解放が無い
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:http://localhost/meal-photo'),
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
describe('#2050 食事の写真の解析の野菜スコアを、そのまま結果に出す', () => {
  it('野菜スコアが 0 点: 「野菜」の欄に 0 と出す (50 にしない)', async () => {
    analysisBody = { ...ANALYSIS_BASE, vegScore: 0 };
    await renderPage('mode=meal');

    const shown = await analyzeMealPhotoAndReadVegScore();

    expect(fetchMock.mock.calls.filter((call) => call[0] === ANALYZE_MEAL_PHOTO_URL)).toHaveLength(1);
    expect(shown).not.toBe(String(FORMER_FALLBACK_VEG_SCORE));
    expect(shown).toBe('0');
  });

  it('野菜スコアが 0 より大きい: その値を出す', async () => {
    analysisBody = { ...ANALYSIS_BASE, vegScore: SOME_VEG_SCORE };
    await renderPage('mode=meal');

    expect(await analyzeMealPhotoAndReadVegScore()).toBe(String(SOME_VEG_SCORE));
  });

  it('応答に野菜スコアの数が無い: 画面の既定の 0 を出す (50 を作らない)', async () => {
    analysisBody = { ...ANALYSIS_BASE, vegScore: null };
    await renderPage('mode=meal');

    expect(await analyzeMealPhotoAndReadVegScore()).toBe('0');
  });
});
