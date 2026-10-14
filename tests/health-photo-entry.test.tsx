/**
 * #1141: 健康記録のクイック記録 (/health/record/quick) の「写真で記録」を、
 * すでに動いている体重計の AI 読み取りフロー (/meals/new の weight_scale モード) につなぐ
 *
 * 経緯:
 *   - クイック記録の「写真で記録」は、#1051 で「AI 読み取りが未実装でダミー値 (65.2kg) を
 *     実測値として出していた」ため、無効カード + 「準備中」表示にしていた。
 *   - しかし AI 読み取り自体は /meals/new の体重計モード (POST /api/ai/analyze-weight-scale) に
 *     実装済みで、健康画面からは入口が無いだけだった。
 *
 * 修正:
 *   - クイック記録の「写真で記録」を /meals/new?mode=weight_scale へのリンクにする。
 *   - /meals/new は mode クエリを読み、撮影の種類 (オート / 食事 / 冷蔵庫 / 健診 / 体重計) が
 *     指定されていればモード選択を飛ばして、その種類の撮影ステップから始める。
 *     未知の値は無視して従来どおりモード選択から始める。
 *     (ネイティブアプリの WebView は全 URL に mode=app を付けるので、mode には撮影の種類以外の値も来る)
 *   - 解析結果は従来の確認ステップ (weight-result) を必ず通り、利用者が「この体重を記録」を
 *     押すまで保存しない (#1051 のダミー値・自動保存の再発防止)。
 *
 * カバレッジ:
 *   A. クイック記録ページ: 「写真で記録」が /meals/new?mode=weight_scale へのリンク。手入力は従来どおり
 *   B. /meals/new: ?mode=weight_scale で体重計の撮影ステップから始まる / クエリ無しは従来どおり /
 *      未知の値は無視
 *   C. A のリンク先をそのまま B に渡すと撮影ステップが開く (リンクと受け側のずれを検知する)
 *   D. 撮影 → 解析 → 確認 → 保存: 確認ステップで利用者が押すまで保存せず、AI が読んだ値で保存する
 *   E. 使い方ガイド (/guide) の説明が実際の入口と一致している (ソース文字列の契約テスト)
 *
 * @testing-library/react は未インストールのため、他のコンポーネントテストと同じく
 * react-dom/client + act で実際にレンダリングする。
 */

import fs from 'node:fs';
import path from 'node:path';
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

import QuickRecordPage from '@/app/(main)/health/record/quick/page';
import MealCaptureModal from '@/app/(main)/meals/new/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── 定数 ───────────────────────────────────────────────────────────────────────
const WEIGHT_SCALE_ENTRY_HREF = '/meals/new?mode=weight_scale';

/** AI が読み取った値。旧ダミー値 (65.2kg) と区別できる値にして、ダミー値の再発も検知する */
const AI_READ_WEIGHT = 62.3;
const AI_READ_BODY_FAT = 18.5;

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
    if (url === '/api/ai/analyze-weight-scale') {
      return jsonResponse({ weight: AI_READ_WEIGHT, bodyFat: AI_READ_BODY_FAT, confidence: 0.92 });
    }
    if (url.startsWith('/api/health/records/history')) return jsonResponse([]);
    if (url === '/api/health/records/quick') return jsonResponse({ message: '記録しました' });
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
// A. クイック記録ページ
// ═══════════════════════════════════════════════════════════════════════════════
describe('#1141 A: クイック記録の「写真で記録」', () => {
  it('/meals/new?mode=weight_scale へのリンクになっている (無効カード・「準備中」ではない)', async () => {
    await renderPage(QuickRecordPage);

    const link = container.querySelector(`a[href="${WEIGHT_SCALE_ENTRY_HREF}"]`);
    expect(link, '「写真で記録」が体重計の撮影フローへのリンクになっていない').not.toBeNull();
    expect(link!.textContent).toContain('写真で記録');

    // #1051 の暫定対応 (aria-disabled + 「準備中」) が残っていない
    expect(container.querySelector('[aria-disabled="true"]')).toBeNull();
    expect(text()).not.toContain('準備中');
  });

  it('手入力は従来どおり使える (選ぶと体重の入力欄が出る)', async () => {
    await renderPage(QuickRecordPage);

    await click(findButton('手入力で記録'), '手入力で記録');

    expect(container.querySelector('input[type="number"]')).not.toBeNull();
    expect(findButton('記録する')).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. /meals/new の mode クエリ
// ═══════════════════════════════════════════════════════════════════════════════
describe('#1141 B: /meals/new は ?mode= の指定でモード選択を飛ばす', () => {
  it('?mode=weight_scale: 体重計の撮影ステップから始まる', async () => {
    await renderPage(MealCaptureModal, 'mode=weight_scale');

    expect(isCaptureStep(), `撮影ステップになっていない\n${text()}`).toBe(true);
    // 体重計モードの撮影画面 (他の種類の文言ではない)
    expect(text()).toContain('体重計や体組成計のディスプレイを撮影してください');
    expect(findButton('体重計を撮影')).toBeDefined();
    expect(findButton('体重計写真を選ぶ')).toBeDefined();
    // モード選択は出ない
    expect(text()).not.toContain(MODE_SELECT_PROMPT);
    expect(findButton('撮影へ進む')).toBeUndefined();
  });

  it('クエリ無し: 従来どおりモード選択から始まる', async () => {
    await renderPage(MealCaptureModal);

    expect(isModeSelectStep(), `モード選択になっていない\n${text()}`).toBe(true);
    expect(findButton('撮影へ進む')).toBeDefined();
  });

  it('クエリ無しでモードを選んで進むと、従来どおり選んだ種類の撮影ステップになる', async () => {
    await renderPage(MealCaptureModal);

    await click(findButton('体重計'), 'モード選択の「体重計」');
    await click(findButton('撮影へ進む'), '撮影へ進む');

    expect(isCaptureStep()).toBe(true);
    expect(text()).toContain('体重計や体組成計のディスプレイを撮影してください');
  });

  // mode=app はネイティブアプリの WebView が全 URL に付ける値 (src/middleware.ts / useNativeAppMode)。
  // constructor / toString / __proto__ は、オブジェクトの `in` 判定だと「ある」と誤判定される値。
  it.each([
    ['app', 'ネイティブアプリの WebView が付ける mode=app'],
    ['unknown', '存在しない種類'],
    ['', '空'],
    ['WEIGHT_SCALE', '大文字小文字違い (別の値として扱う)'],
    ['weight_scale ', '前後に空白がある値'],
    ['constructor', 'オブジェクトの組み込みプロパティ名'],
    ['toString', 'オブジェクトの組み込みプロパティ名'],
    ['__proto__', 'オブジェクトの組み込みプロパティ名'],
  ])('未知の値 mode=%j は無視してモード選択から始まる (%s)', async (value) => {
    await renderPage(MealCaptureModal, `mode=${encodeURIComponent(value)}`);

    expect(isModeSelectStep(), `モード選択になっていない\n${text()}`).toBe(true);
  });

  it('mode=app に他のクエリが付いていても、モード選択から始まる', async () => {
    await renderPage(MealCaptureModal, 'source=home&mode=app');

    expect(isModeSelectStep()).toBe(true);
  });

  // 撮影の種類として使える値はすべて同じ仕組みで開く (体重計だけの特別扱いにしない)
  it.each([
    ['auto', 'AIが写真の種類を自動判別します'],
    ['meal', '食事の写真を撮影してください'],
    ['fridge', '冷蔵庫の中や買ってきた食材を撮影してください'],
    ['health_checkup', '健康診断結果や検査票を撮影してください'],
    ['weight_scale', '体重計や体組成計のディスプレイを撮影してください'],
  ])('?mode=%s: その種類の撮影ステップから始まる', async (mode, description) => {
    await renderPage(MealCaptureModal, `mode=${mode}`);

    expect(isCaptureStep(), `撮影ステップになっていない\n${text()}`).toBe(true);
    expect(text()).toContain(description);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. リンクと受け側のつなぎ込み
// ═══════════════════════════════════════════════════════════════════════════════
describe('#1141 C: クイック記録のリンク先を /meals/new に渡すと、体重計の撮影ステップが開く', () => {
  it('リンクの href のクエリをそのまま /meals/new に渡す', async () => {
    await renderPage(QuickRecordPage);
    const link = container.querySelector('a[href^="/meals/new"]') as HTMLAnchorElement | null;
    expect(link, 'クイック記録に /meals/new へのリンクが無い').not.toBeNull();

    const url = new URL(link!.getAttribute('href')!, 'http://localhost');
    expect(url.pathname).toBe('/meals/new');

    await renderPage(MealCaptureModal, url.search.slice(1));

    expect(isCaptureStep(), `撮影ステップになっていない\n${text()}`).toBe(true);
    expect(findButton('体重計写真を選ぶ')).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. 撮影 → 解析 → 確認 → 保存
// ═══════════════════════════════════════════════════════════════════════════════
describe('#1141 D: AI が読み取った値は、利用者が確認して押すまで保存しない', () => {
  async function takeWeightScalePhoto() {
    const input = container.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
    expect(input, '撮影ステップに写真の入力が無い').not.toBeNull();

    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'scale.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input!, 'files', { value: [file], configurable: true });
    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('体重計の写真を解析すると確認ステップで止まり、「この体重を記録」を押して初めて AI の値で保存する', async () => {
    await renderPage(MealCaptureModal, 'mode=weight_scale');

    // 撮影 → 「AIで解析する」
    await takeWeightScalePhoto();
    await waitUntil(() => findButton('AIで解析する') !== undefined, '「AIで解析する」ボタン');
    await click(findButton('AIで解析する'), 'AIで解析する');

    // 解析 API は体重計用 (device_type は API 側で weight_scale 固定)。写真は base64 で送る
    await waitUntil(() => text().includes('体重計読み取り結果'), '確認ステップ (体重計読み取り結果)');
    const analyzeCalls = callsTo('/api/ai/analyze-weight-scale');
    expect(analyzeCalls).toHaveLength(1);
    const analyzeBody = JSON.parse(analyzeCalls[0][1].body as string);
    expect(typeof analyzeBody.image).toBe('string');
    expect(analyzeBody.image.length).toBeGreaterThan(0);

    // 確認ステップ: AI が読んだ値が出ていて、まだ何も保存していない
    expect(text()).toContain(AI_READ_WEIGHT.toFixed(1));
    expect(text()).toContain(AI_READ_BODY_FAT.toFixed(1));
    expect(callsTo('/api/health/records/quick')).toHaveLength(0);

    // 利用者が確認して押す → AI が読んだ値で、写真由来 (source: 'photo') として保存
    await click(findButton('この体重を記録'), 'この体重を記録');
    await waitUntil(() => callsTo('/api/health/records/quick').length > 0, '保存リクエスト');

    const saveCalls = callsTo('/api/health/records/quick');
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0][1].method).toBe('POST');
    const saveBody = JSON.parse(saveCalls[0][1].body as string);
    expect(saveBody.weight).toBe(AI_READ_WEIGHT);
    expect(saveBody.bodyFat).toBe(AI_READ_BODY_FAT);
    expect(saveBody.source).toBe('photo');
    // #1051 のダミー値 (65.2kg) ではない
    expect(saveBody.weight).not.toBe(65.2);
  });

  it('解析に失敗したら、何も保存しない', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/ai/analyze-weight-scale') {
        return jsonResponse({ error: 'mode_mismatch', message: '体重計の表示が読み取れませんでした。' }, 422);
      }
      throw new Error(`想定外の fetch: ${url}`);
    });
    await renderPage(MealCaptureModal, 'mode=weight_scale');

    await takeWeightScalePhoto();
    await waitUntil(() => findButton('AIで解析する') !== undefined, '「AIで解析する」ボタン');
    await click(findButton('AIで解析する'), 'AIで解析する');
    await waitUntil(() => callsTo('/api/ai/analyze-weight-scale').length > 0, '解析リクエスト');
    // 失敗時は通知してモード選択に戻る (従来どおり)
    await waitUntil(() => isModeSelectStep(), '解析失敗後のモード選択');

    expect(callsTo('/api/health/records/quick')).toHaveLength(0);
    expect(text()).not.toContain(AI_READ_WEIGHT.toFixed(1));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. 使い方ガイド
// ═══════════════════════════════════════════════════════════════════════════════
describe('#1141 E: 使い方ガイドの「写真で記録」が、実際の入口と一致している', () => {
  const read = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

  it('ガイドが案内する入口の名前が、健康画面のクイックアクションに実在する', () => {
    const guide = read('src/app/guide/page.tsx');
    const healthPage = read('src/app/(main)/health/page.tsx');

    expect(guide).toContain('健康画面の「写真で記録」');
    expect(healthPage).toMatch(/>\s*写真で記録\s*</);
  });

  it('AI の読み取りは確認してから記録する、と案内している (確認なしの「自動認識」とは言わない)', () => {
    const guide = read('src/app/guide/page.tsx');

    expect(guide).toContain('内容を確認してから記録できます');
    expect(guide).not.toContain('自動認識');
  });
});
