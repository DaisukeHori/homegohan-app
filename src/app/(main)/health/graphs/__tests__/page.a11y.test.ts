// src/app/(main)/health/graphs/__tests__/page.a11y.test.ts
// #1119 (3): 推移グラフ (/health/graphs) の a11y 残債の対応を、実際に画面を描画して検証する。
//   - <svg> に role="img" と aria-label (指標・期間・最新値・最小/最大・変化)、<title>/<desc> が付く
//   - 健診由来の点 (菱形) があるときだけ、丸/菱形の凡例が出る
//   - X 軸ラベルが 1 週間以外 (1 ヶ月 / 3 ヶ月 / 1 年) でも出る
//   - 指標・期間の切替ボタンに aria-pressed が付く
//   - Y 軸ラベルが左に見切れない

import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

const backMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: backMock, push: vi.fn() }),
}));

// Realtime の購読は画面の見た目に関係しないため、何もしない購読に差し替える
vi.mock('@/lib/supabase/client', () => {
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  return {
    createClient: () => ({
      channel: () => channel,
      removeChannel: vi.fn(async () => 'ok'),
    }),
  };
});

import HealthGraphsPage from '../page';
import { formatLocalDate } from '@/lib/date-utils';
import { estimateSvgTextWidth } from '@/lib/health-trend-chart-a11y';

const h = React.createElement;

// 「今日」を固定する (Date だけ。setTimeout などは本物のまま)。
// 画面は new Date() を 2 回呼んで期間を作るため、実行がちょうど 1 ミリ秒をまたぐと
// 最後の日 (今日) の点が落ちてテストが揺れる。日付をまたぐ瞬間に走っても同じ結果になるようにもしておく。
// 記録の日付 (daysAgo) はファイルの読み込み時にも作るため、beforeEach ではなくここで固定する。
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
afterAll(() => {
  vi.useRealTimers();
});

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // React に「テスト中で、更新は act() の中で行う」と伝える (act の警告を出さないための設定)
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  backMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

/** 今日から n 日前の日付 (YYYY-MM-DD)。画面と同じ formatLocalDate を使う */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatLocalDate(d);
}

interface ApiFixture {
  records?: Record<string, unknown>[];
  checkups?: Record<string, unknown>[];
  goals?: Record<string, unknown>[];
}

/** 画面が呼ぶ 3 つの API (記録 / 健診 / 目標) を差し替える */
function stubApis(fixture: ApiFixture) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/health/records')
        ? { records: fixture.records ?? [] }
        : url.includes('/api/health/checkups')
          ? { checkups: fixture.checkups ?? [] }
          : url.includes('/api/health/goals')
            ? { goals: fixture.goals ?? [] }
            : {};
      return { ok: true, json: async () => body } as Response;
    }),
  );
}

/** 読み込み (fetch → setState → 再描画) が終わるまで、マイクロタスクとタイマーを数回流す */
async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPage(fixture: ApiFixture) {
  stubApis(fixture);
  await act(async () => {
    root.render(h(HealthGraphsPage));
  });
  await flush();
}

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`「${text}」ボタンが見つかりません`);
  return button as HTMLButtonElement;
}

async function click(text: string) {
  await act(async () => {
    findButton(text).click();
  });
  await flush();
}

function chart(): SVGSVGElement {
  const svg = container.querySelector('svg[role="img"]');
  if (!svg) throw new Error('role="img" の <svg> が見つかりません');
  return svg as SVGSVGElement;
}

/** グラフ内の X 軸ラベル (日付) の文字列。Y 軸ラベル・目標ラベルは含めない */
function xAxisLabels(): string[] {
  return Array.from(chart().querySelectorAll('text'))
    .map((t) => t.textContent ?? '')
    .filter((text) => /^(\d{4}\/)?\d{1,2}\/\d{1,2}$/.test(text));
}

const WEIGHT_RECORDS = [
  { record_date: daysAgo(20), weight: 66.0 },
  { record_date: daysAgo(10), weight: 65.0 },
  { record_date: daysAgo(0), weight: 64.2 },
];

describe('推移グラフ: <svg> の代替テキスト (#1119, WCAG 1.1.1)', () => {
  it('role="img" と、指標・期間・最新値・最小/最大・変化を含む aria-label が付く', async () => {
    await renderPage({ records: WEIGHT_RECORDS });
    const label = chart().getAttribute('aria-label') ?? '';
    expect(label).toContain('体重の推移グラフ');
    expect(label).toContain('期間は1ヶ月');
    expect(label).toContain('最新値は64.2kg');
    expect(label).toContain('最小64.2kg、最大66.0kg');
    expect(label).toContain('期間中の変化は1.8kg減少');
  });

  it('<title> と <desc> があり、aria-describedby が <desc> を指す', async () => {
    await renderPage({ records: WEIGHT_RECORDS });
    const svg = chart();
    expect(svg.querySelector('title')?.textContent).toBe('体重の推移（1ヶ月）');
    const desc = svg.querySelector('desc');
    expect(desc).not.toBeNull();
    expect(desc!.id).toBeTruthy();
    expect(svg.getAttribute('aria-describedby')).toBe(desc!.id);
    expect(desc!.textContent).toContain('値がある日は3日');
    // 今日 (2026-10-08 に固定) から 30 日分。日付は「ハイフン」で読まれないよう年月日で書く
    expect(desc!.textContent).toContain('2026年9月9日から2026年10月8日まで');
  });

  it('期間や指標を切り替えると aria-label も追従する', async () => {
    await renderPage({ records: WEIGHT_RECORDS });
    await click('1年');
    expect(chart().getAttribute('aria-label')).toContain('期間は1年');

    await click('睡眠');
    // 睡眠のデータは無いため、グラフではなく空状態になる (誤った代替テキストを残さない)
    expect(container.querySelector('svg[role="img"]')).toBeNull();
  });

  it('血圧は収縮期と拡張期の両方、最小は拡張期・最大は収縮期と読み上げる', async () => {
    await renderPage({
      records: [
        { record_date: daysAgo(10), systolic_bp: 130, diastolic_bp: 84 },
        { record_date: daysAgo(0), systolic_bp: 124, diastolic_bp: 78 },
      ],
    });
    await click('血圧');
    const label = chart().getAttribute('aria-label') ?? '';
    expect(label).toContain('血圧(収縮期/拡張期)の推移グラフ');
    expect(label).toContain('最新値は収縮期124.0、拡張期78.0mmHg');
    expect(label).toContain('最小は拡張期の78.0mmHg、最大は収縮期の130.0mmHg');
    expect(label).toContain('収縮期の期間中の変化は6mmHg減少');
  });

  it('データが無いときは role="img" のグラフを出さず、記録への導線を出す', async () => {
    await renderPage({ records: [] });
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(container.textContent).toContain('データがありません');
    expect(container.querySelector('a[href="/health/record"]')).not.toBeNull();
  });
});

describe('推移グラフ: 丸/菱形の凡例 (#1119)', () => {
  it('健診由来の点が無いときは凡例を出さず、菱形も描かない', async () => {
    await renderPage({ records: WEIGHT_RECORDS });
    expect(container.querySelector('[data-testid="trend-chart-legend"]')).toBeNull();
    expect(chart().querySelectorAll('polygon')).toHaveLength(0);
    expect(chart().getAttribute('aria-label')).not.toContain('健診');
    expect(chart().querySelector('desc')?.textContent).not.toContain('菱形');
  });

  it('健診由来の点があるときだけ、丸=日々の記録 / 菱形=健診 の凡例を出す', async () => {
    await renderPage({
      records: WEIGHT_RECORDS,
      checkups: [{ checkup_date: daysAgo(5), weight: 65.5 }],
    });
    const legend = container.querySelector('[data-testid="trend-chart-legend"]');
    expect(legend).not.toBeNull();
    expect(legend!.textContent).toContain('日々の記録');
    expect(legend!.textContent).toContain('健診');
    // 凡例の見本 (丸と菱形) は装飾なので支援技術には出さない
    const swatches = Array.from(legend!.querySelectorAll('svg'));
    expect(swatches).toHaveLength(2);
    for (const swatch of swatches) expect(swatch.getAttribute('aria-hidden')).toBe('true');
    expect(legend!.querySelector('svg circle')).not.toBeNull();
    expect(legend!.querySelector('svg polygon')).not.toBeNull();
    // グラフ本体にも、その日の点が菱形で描かれている
    expect(chart().querySelectorAll('polygon')).toHaveLength(1);
    // 読み上げ側にも健診の日数が伝わる
    expect(chart().querySelector('desc')?.textContent).toContain('うち健診の値は1日');
  });

  it('同じ日に日々の記録がある健診は丸のままなので、菱形も凡例も出ない', async () => {
    await renderPage({
      records: WEIGHT_RECORDS,
      checkups: [{ checkup_date: WEIGHT_RECORDS[1].record_date, weight: 65.2 }],
    });
    expect(container.querySelector('[data-testid="trend-chart-legend"]')).toBeNull();
    expect(chart().querySelectorAll('polygon')).toHaveLength(0);
  });

  it('血圧: 収縮期/拡張期の凡例は従来どおり出る。健診由来の拡張期の点も菱形で描かれる', async () => {
    await renderPage({
      records: [{ record_date: daysAgo(0), systolic_bp: 124, diastolic_bp: 78 }],
      checkups: [{ checkup_date: daysAgo(7), blood_pressure_systolic: 130, blood_pressure_diastolic: 84 }],
    });
    await click('血圧');
    const legend = container.querySelector('[data-testid="trend-chart-legend"]');
    expect(legend).not.toBeNull();
    expect(legend!.textContent).toContain('収縮期');
    expect(legend!.textContent).toContain('拡張期');
    expect(legend!.textContent).toContain('健診');
    // 健診の日は収縮期・拡張期のどちらも菱形 (凡例の「菱形=健診」が系列によらず成り立つ)
    expect(chart().querySelectorAll('polygon')).toHaveLength(2);
  });

  it('血圧で健診由来の点が無いときは、収縮期/拡張期の凡例だけで丸/菱形の説明は出ない', async () => {
    await renderPage({ records: [{ record_date: daysAgo(0), systolic_bp: 124, diastolic_bp: 78 }] });
    await click('血圧');
    const legend = container.querySelector('[data-testid="trend-chart-legend"]');
    expect(legend).not.toBeNull();
    expect(legend!.textContent).toContain('収縮期');
    expect(legend!.textContent).not.toContain('菱形');
  });
});

describe('推移グラフ: X 軸ラベル (#1119)', () => {
  it.each([
    ['1週間', /^\d{1,2}\/\d{1,2}$/],
    ['1ヶ月', /^\d{1,2}\/\d{1,2}$/],
    ['3ヶ月', /^\d{1,2}\/\d{1,2}$/],
    ['1年', /^\d{4}\/\d{1,2}\/\d{1,2}$/],
  ])('%s 表示でも先頭・中央・末尾の 3 点に日付ラベルが出る', async (period, pattern) => {
    await renderPage({ records: WEIGHT_RECORDS });
    await click(period);
    const labels = xAxisLabels();
    expect(labels).toHaveLength(3);
    for (const label of labels) expect(label).toMatch(pattern);
  });

  it('末尾のラベルは今日の日付', async () => {
    await renderPage({ records: WEIGHT_RECORDS });
    const today = new Date();
    expect(xAxisLabels()[2]).toBe(`${today.getMonth() + 1}/${today.getDate()}`);
  });

  it('先頭は左寄せ・中央は中央寄せ・末尾は右寄せになる', async () => {
    await renderPage({ records: WEIGHT_RECORDS });
    const anchors = Array.from(chart().querySelectorAll('text'))
      .filter((t) => /^\d{1,2}\/\d{1,2}$/.test(t.textContent ?? ''))
      .map((t) => t.getAttribute('text-anchor'));
    expect(anchors).toEqual(['start', 'middle', 'end']);
  });
});

describe('推移グラフ: Y 軸ラベルが左に見切れない (#1119)', () => {
  it.each([
    ['体重', [{ record_date: daysAgo(3), weight: 70.5 }, { record_date: daysAgo(0), weight: 71.2 }]],
    ['血圧', [{ record_date: daysAgo(3), systolic_bp: 142, diastolic_bp: 90 }, { record_date: daysAgo(0), systolic_bp: 138, diastolic_bp: 86 }]],
    ['睡眠', [{ record_date: daysAgo(3), sleep_hours: 6.5 }, { record_date: daysAgo(0), sleep_hours: 7.5 }]],
  ])('%s: 右寄せの Y 軸ラベルの左端が viewBox の外に出ない', async (metricLabel, records) => {
    await renderPage({ records });
    if (metricLabel !== '体重') await click(metricLabel);
    const yLabels = Array.from(chart().querySelectorAll('text[text-anchor="end"]')).filter(
      (t) => !/^\d{1,2}\/\d{1,2}$/.test(t.textContent ?? ''),
    );
    expect(yLabels.length).toBeGreaterThanOrEqual(2);
    for (const label of yLabels) {
      const right = Number(label.getAttribute('x'));
      const fontSize = Number(label.getAttribute('font-size'));
      expect(right - estimateSvgTextWidth(label.textContent ?? '', fontSize)).toBeGreaterThanOrEqual(0);
    }
  });

  it('グラフ内の文字は 12 (360px 幅の画面で約 11px) 以上。目標ラインの「目標」も含む', async () => {
    // 目標体重がグラフの範囲 (64.0〜66.2) に入っているときだけ「目標」の文字が描かれる
    await renderPage({ records: WEIGHT_RECORDS, goals: [{ goal_type: 'weight', target_value: 65 }] });
    const texts = Array.from(chart().querySelectorAll('text'));
    expect(texts.map((t) => t.textContent)).toContain('目標');
    for (const text of texts) expect(Number(text.getAttribute('font-size'))).toBeGreaterThanOrEqual(12);
  });
});

describe('推移グラフ: 切替ボタンの aria-pressed (#1119)', () => {
  it('指標ボタン: 選択中だけ aria-pressed="true"、選択を変えると追従する', async () => {
    await renderPage({ records: WEIGHT_RECORDS });
    const metrics = ['体重', '体脂肪率', '血圧', '睡眠'];
    expect(metrics.map((m) => findButton(m).getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false']);

    await click('睡眠');
    expect(metrics.map((m) => findButton(m).getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true']);
  });

  it('期間ボタン: 選択中だけ aria-pressed="true"、選択を変えると追従する', async () => {
    await renderPage({ records: WEIGHT_RECORDS });
    const periods = ['1週間', '1ヶ月', '3ヶ月', '1年'];
    expect(periods.map((p) => findButton(p).getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false']);

    await click('1年');
    expect(periods.map((p) => findButton(p).getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true']);
  });

  it('切替ボタンのグループに名前が付く', async () => {
    await renderPage({ records: WEIGHT_RECORDS });
    expect(container.querySelector('[role="group"][aria-label="表示する指標"]')).not.toBeNull();
    expect(container.querySelector('[role="group"][aria-label="表示する期間"]')).not.toBeNull();
  });

  it('戻るボタンに名前が付き、押すと前の画面へ戻る', async () => {
    await renderPage({ records: WEIGHT_RECORDS });
    const back = container.querySelector('button[aria-label="戻る"]') as HTMLButtonElement;
    expect(back).not.toBeNull();
    await act(async () => {
      back.click();
    });
    expect(backMock).toHaveBeenCalledTimes(1);
  });
});
