// src/app/(main)/health/graphs/__tests__/page.status-colors.test.ts
// #590 推移グラフ (/health/graphs) の状態色を、実際に画面を描画して検証する。
//   - 文字 (目標体重の文言・変化量の数字・グラフ内の「目標」) は文字用の濃い色 (successText / dangerText)
//   - アイコン・グラフの線は塗りの色 (success / error) のまま
//   - 値は packages/shared の STATUS_COLOR_TOKENS (A 系)。旧 B 系の値 (#4CAF50 など) が出ないこと
// ソース全体の走査 (hex の直書き・文字に塗りの色を使っていないか) は src/__tests__/config/status-color-tokens.test.ts。

import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { STATUS_COLOR_TOKENS } from '@homegohan/shared';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
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

const h = React.createElement;

// 「今日」を固定する (Date だけ。setTimeout などは本物のまま)。記録の日付はファイルの読み込み時にも作るため、ここで固定する
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
afterAll(() => {
  vi.useRealTimers();
});

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
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

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatLocalDate(d);
}

/** 画面が呼ぶ API (記録 / 健診 / 目標) を差し替える */
function stubApis(fixture: { records?: Record<string, unknown>[]; goals?: Record<string, unknown>[] }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/health/records')
        ? { records: fixture.records ?? [] }
        : url.includes('/api/health/goals')
          ? { goals: fixture.goals ?? [] }
          : url.includes('/api/health/checkups')
            ? { checkups: [] }
            : {};
      return { ok: true, json: async () => body } as Response;
    }),
  );
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPage(fixture: Parameters<typeof stubApis>[0]) {
  stubApis(fixture);
  await act(async () => {
    root.render(h(HealthGraphsPage));
  });
  await flush();
}

/** 色の書き方 (#4A704A / rgb(74, 112, 74)) の違いを吸収するため、ブラウザ (jsdom) の正規化に通して比べる */
function normalizeColor(color: string): string {
  const probe = document.createElement('div');
  probe.style.color = color;
  return probe.style.color;
}

function textElement(text: string, selector = 'p, span'): HTMLElement {
  const found = Array.from(container.querySelectorAll<HTMLElement>(selector)).find((el) => el.textContent?.trim().startsWith(text));
  if (!found) throw new Error(`「${text}」で始まる要素が見つかりません`);
  return found;
}

function icon(name: string): SVGElement {
  const found = container.querySelector<SVGElement>(`svg.lucide-${name}`);
  if (!found) throw new Error(`アイコン ${name} が見つかりません`);
  return found;
}

// 66.0 → 65.0 → 64.2 kg と減っていく記録 (期間中の変化は -1.8 kg)
const WEIGHT_RECORDS = [
  { record_date: daysAgo(20), weight: 66.0 },
  { record_date: daysAgo(10), weight: 65.0 },
  { record_date: daysAgo(0), weight: 64.2 },
];

describe('推移グラフ: 目標体重 65kg (グラフの範囲の中) の状態色 (#590)', () => {
  it('目標体重の文言は文字用の色 (successText)。アイコンは塗りの色 (success)', async () => {
    await renderPage({ records: WEIGHT_RECORDS, goals: [{ goal_type: 'weight', target_value: 65 }] });

    const label = textElement('目標体重: 65kg');
    expect(normalizeColor(label.style.color)).toBe(normalizeColor(STATUS_COLOR_TOKENS.successText));
    const detail = textElement('目標まであと');
    expect(normalizeColor(detail.style.color)).toBe(normalizeColor(STATUS_COLOR_TOKENS.successText));
    expect(normalizeColor(icon('target').style.color)).toBe(normalizeColor(STATUS_COLOR_TOKENS.success));
  });

  it('グラフ内の「目標」の文字は successText、目標ラインは success', async () => {
    await renderPage({ records: WEIGHT_RECORDS, goals: [{ goal_type: 'weight', target_value: 65 }] });

    const svg = container.querySelector('svg[role="img"]');
    expect(svg).not.toBeNull();
    const targetText = Array.from(svg!.querySelectorAll('text')).find((t) => t.textContent === '目標');
    expect(targetText, 'グラフ内に「目標」の文字が描かれていません').toBeDefined();
    expect(targetText!.getAttribute('fill')?.toUpperCase()).toBe(STATUS_COLOR_TOKENS.successText);

    const targetLine = Array.from(svg!.querySelectorAll('line')).find((l) => l.getAttribute('stroke-dasharray') === '6,4');
    expect(targetLine, '目標ラインが描かれていません').toBeDefined();
    expect(targetLine!.getAttribute('stroke')?.toUpperCase()).toBe(STATUS_COLOR_TOKENS.success);
  });

  it('旧 B 系の success (#4CAF50) の色は、どこにも出ない', async () => {
    await renderPage({ records: WEIGHT_RECORDS, goals: [{ goal_type: 'weight', target_value: 65 }] });
    const html = container.innerHTML.toUpperCase();
    expect(html).not.toContain('#4CAF50');
    expect(html).not.toContain(normalizeColor('#4CAF50').toUpperCase());
  });
});

describe('推移グラフ: 体重の変化量チップの状態色 (#590)', () => {
  it('目標から遠ざかる変化 (悪化): 数字は dangerText、矢印のアイコンは error', async () => {
    // 目標 65kg に対して 64.2kg まで下がった (目標を下回って離れていく) ので「悪化」扱い
    await renderPage({ records: WEIGHT_RECORDS, goals: [{ goal_type: 'weight', target_value: 65 }] });

    const change = textElement('-1.8 kg', 'span');
    expect(normalizeColor(change.style.color)).toBe(normalizeColor(STATUS_COLOR_TOKENS.dangerText));
    expect(normalizeColor(icon('trending-down').style.color)).toBe(normalizeColor(STATUS_COLOR_TOKENS.error));
    expect(normalizeColor((change.parentElement as HTMLElement).style.backgroundColor)).toBe(normalizeColor(STATUS_COLOR_TOKENS.errorLight));
  });

  it('目標に近づく変化 (改善): 数字は successText、矢印のアイコンは success', async () => {
    // 目標 63kg に対して 66.0 → 64.2kg と近づいたので「改善」扱い
    await renderPage({ records: WEIGHT_RECORDS, goals: [{ goal_type: 'weight', target_value: 63 }] });

    const change = textElement('-1.8 kg', 'span');
    expect(normalizeColor(change.style.color)).toBe(normalizeColor(STATUS_COLOR_TOKENS.successText));
    expect(normalizeColor(icon('trending-down').style.color)).toBe(normalizeColor(STATUS_COLOR_TOKENS.success));
    expect(normalizeColor((change.parentElement as HTMLElement).style.backgroundColor)).toBe(normalizeColor(STATUS_COLOR_TOKENS.successLight));
  });
});
