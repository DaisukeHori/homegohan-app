/**
 * #1528 Web の獲得済みのバッジの一覧 (src/app/(main)/badges/page.tsx) で、確定した期間に取ったバッジ (先週・先月の 1 位など) に
 * どの期間のものかを添える。
 *
 * GET /api/badges は、比較ランキングのバッジを取った期間がある獲得済みのバッジに periodAwards (最新の期間と取った回数) を付ける。
 *   - カード: 期間の文 (formatBadgePeriodAwards。2 回以上なら「（通算 n 回）」つき)
 *   - 詳細: 「獲得した期間」に最新の期間・その判定の文、2 回以上なら回数。取得日時 (初めて取った日) の見出しは「初めて取得した日」
 *   - periodAwards の無いバッジ・未獲得のバッジには出さない
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (tests/handson-tour-1604-pages.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(),
}));

const { default: BadgesPage } = await import('@/app/(main)/badges/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function badge(overrides: Record<string, unknown>) {
  return {
    id: 'b-1',
    code: 'segment_rank_1',
    name: 'セグメント1位',
    description: 'セグメント内で1位を獲得しました！',
    earned: true,
    obtainedAt: '2026-09-01T15:05:00Z',
    periodAwards: null,
    ...overrides,
  };
}

async function mountWith(badges: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ badges, newEarnedCount: 0, newEarnedBadgeCodes: [] }), { status: 200 })),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<BadgesPage />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function cardOf(code: string): HTMLElement {
  const card = container.querySelector<HTMLElement>(`[data-badge-code="${code}"]`);
  expect(card, `${code} のカードが無い`).not.toBeNull();
  return card!;
}

async function openDetail(code: string): Promise<HTMLElement> {
  await act(async () => {
    cardOf(code).click();
  });
  const modal = document.querySelector<HTMLElement>('[data-testid="badge-detail-modal"]');
  expect(modal).not.toBeNull();
  return modal!;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('バッジの一覧 (Web) の、確定した期間に取ったバッジの期間 (#1528)', () => {
  it('1 回だけ取ったバッジは、カードに期間を出し、詳細に期間と判定の文を出す (回数の文は出さない)', async () => {
    await mountWith([
      badge({
        periodAwards: {
          count: 1,
          latest: { periodType: 'weekly', periodStart: '2026-09-28', label: '2026年9月28日〜10月4日の週', message: '🏆 全体の朝食率で1位！' },
        },
      }),
    ]);

    expect(cardOf('segment_rank_1').querySelector('[data-testid="badge-card-period"]')?.textContent).toBe('2026年9月28日〜10月4日の週');

    const modal = await openDetail('segment_rank_1');
    const detail = modal.querySelector('[data-testid="badge-detail-period"]');
    expect(detail?.textContent).toContain('獲得した期間');
    expect(detail?.textContent).toContain('2026年9月28日〜10月4日の週');
    expect(detail?.textContent).toContain('🏆 全体の朝食率で1位！');
    expect(detail?.textContent).not.toContain('回獲得しました');
    expect(modal.textContent).toContain('取得日時');
    expect(modal.textContent).not.toContain('初めて取得した日');
  });

  it('複数の期間で取ったバッジは、カードに通算の回数を添え、詳細に回数と「初めて取得した日」を出す', async () => {
    await mountWith([
      badge({
        periodAwards: { count: 3, latest: { periodType: 'monthly', periodStart: '2026-09-01', label: '2026年9月', message: null } },
      }),
    ]);

    expect(cardOf('segment_rank_1').querySelector('[data-testid="badge-card-period"]')?.textContent).toBe('2026年9月（通算 3 回）');

    const modal = await openDetail('segment_rank_1');
    const detail = modal.querySelector('[data-testid="badge-detail-period"]');
    expect(detail?.textContent).toContain('2026年9月');
    expect(detail?.textContent).toContain('これまでに 3 回獲得しました');
    expect(modal.textContent).toContain('初めて取得した日');
  });

  it('期間の無いバッジ・未獲得のバッジには、期間を出さない', async () => {
    await mountWith([
      badge({ id: 'b-first', code: 'first_bite', name: '最初の一口', periodAwards: null }),
      badge({
        id: 'b-top10',
        code: 'segment_top_10',
        name: '上位10%',
        earned: false,
        obtainedAt: null,
        periodAwards: { count: 1, latest: { periodType: 'daily', periodStart: '2026-10-01', label: '2026年10月1日', message: null } },
      }),
    ]);

    expect(cardOf('first_bite').querySelector('[data-testid="badge-card-period"]')).toBeNull();
    expect(cardOf('segment_top_10').querySelector('[data-testid="badge-card-period"]')).toBeNull();
    const modal = await openDetail('first_bite');
    expect(modal.querySelector('[data-testid="badge-detail-period"]')).toBeNull();
  });
});
