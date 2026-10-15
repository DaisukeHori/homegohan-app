/**
 * #1604 ハンズオンツアー (Web) の不具合 3 件の回帰テスト。#846 の E2E で見つけたもの。
 *
 *   1. Step 1 (src/app/handson-tour/photo/page.tsx) の保存: 本文に mealType が無く 400 になり、画面は失敗を無視して Step 2 へ進んでいた。
 *      設計書 03-step1 §3.7 の本文 (夕食) で送り、失敗したら §3.10 のエラー画面 (もう一度 / あとで) を出して先へ進まない。
 *      ただし「お試しの保存の対象でない」(sandbox_not_eligible。設定からのやり直しなど) は、エラーにせず Step 2 へ進む。
 *   2. Step 3 (src/app/handson-tour/badges/page.tsx) の「獲得済」: 応答に無い obtained_at を見ていた。/api/badges の earned を見る。
 *   3. Step 3 の自動スクロール: 吹き出しの対象のカードを画面の中へスクロールする (設計書 05-step3 §7.2 / §7.3)。
 *
 * 吹き出しとスポットライトの描画 (framer-motion / focus-trap) は関心外なので、TourSandboxWrapper / TourOverlay は
 * 吹き出しの文言とボタンだけを出す差し替えにする (tests/handson-tour-profile-pages.test.tsx と同じ方法)。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HANDSON_TOUR_CONSTANTS,
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  STEP3_BADGES_EARNED_IN_TOUR,
  personalize,
} from '@homegohan/handson-tour-shared';
import { createFakeTourDb } from './helpers/fake-tour-profile-db';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  fireAnalytics: vi.fn(),
  logToServer: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@/lib/db-logger', () => ({
  logToServer: mocks.logToServer,
}));

vi.mock('@homegohan/handson-tour-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@homegohan/handson-tour-shared')>()),
  fireAnalytics: mocks.fireAnalytics,
}));

type OverlayLike = {
  bubble: { title?: string; body: string };
  primaryAction?: { label: string; onPress: () => void };
  onAutoAdvance?: () => void;
};

function FakeOverlay({ bubble, primaryAction, onAutoAdvance }: OverlayLike) {
  return (
    <div data-testid="fake-overlay">
      <p data-testid="bubble-title">{bubble.title ?? ''}</p>
      <p data-testid="bubble-body">{bubble.body}</p>
      {primaryAction && (
        <button data-testid="primary" onClick={primaryAction.onPress}>
          {primaryAction.label}
        </button>
      )}
      {onAutoAdvance && (
        <button data-testid="auto-advance" onClick={onAutoAdvance}>
          auto
        </button>
      )}
    </div>
  );
}

vi.mock('@/components/handson-tour/TourSandboxWrapper', () => ({
  TourSandboxWrapper: ({ overlay }: { overlay: OverlayLike }) => <FakeOverlay {...overlay} />,
}));

vi.mock('@/components/handson-tour/TourOverlay', () => ({
  TourOverlay: (props: OverlayLike) => <FakeOverlay {...props} />,
}));

const { default: HandsonTourPhotoPage } = await import('@/app/handson-tour/photo/page');
const { default: HandsonTourBadgesPage } = await import('@/app/handson-tour/badges/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_ERROR = 500;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

async function mountPage(Page: () => React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Page />);
  });
  await flush();
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function click(testId: string) {
  const el = byTestId(testId);
  expect(el, `${testId} が見つからない`).not.toBeNull();
  await act(async () => {
    el!.click();
  });
  await flush();
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function callsTo(path: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(path));
}

function analyticsEvents(name: string) {
  return mocks.fireAnalytics.mock.calls.filter(([event]) => event === name);
}

beforeEach(() => {
  mocks.createClient.mockReset();
  mocks.fireAnalytics.mockReset();
  mocks.logToServer.mockReset();
  mocks.push.mockReset();
  mocks.createClient.mockReturnValue(createFakeTourDb({ profile: { nickname: 'はなこ' } }).supabase);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Step 1 の保存
// ─────────────────────────────────────────────────────────────────────────────

/** 1.1 → 1.5 (自動) → [次へ] で 1.6 → [保存] */
async function advancePhotoToSaveAndPress() {
  for (let i = 0; i < 4; i += 1) await click('auto-advance');
  await click('primary'); // 1.5 → 1.6
  expect(byTestId('primary')?.textContent).toBe('保存');
  await click('primary'); // 保存
}

describe('#1604 Step 1: 保存の本文と失敗の扱い', () => {
  it('保存は夕食のお試しの記録の本文で POST し、成功したら Step 2 へ進み、完了を記録する', async () => {
    fetchMock.mockResolvedValue(jsonResponse(HTTP_OK, { success: true }));
    await mountPage(HandsonTourPhotoPage);

    await advancePhotoToSaveAndPress();

    const saves = callsTo('/api/meal-plans/add-from-photo');
    expect(saves).toHaveLength(1);
    const [url, init] = saves[0];
    expect(url).toBe('/api/meal-plans/add-from-photo?source=handson_tour');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ sandbox: true, mealType: 'dinner', totalCalories: 780, imageUrl: null });
    // お試しの記録は meals に入り、食べた時刻はサーバーの今。日付 (dayDate) は送らない
    expect(body).not.toHaveProperty('dayDate');
    expect(body.dishes).toEqual([{ name: '鶏の唐揚げ定食', cal: 780, role: 'main' }]);

    expect(mocks.push).toHaveBeenCalledWith(HANDSON_TOUR_ROUTES.step2);
    expect(byTestId('tour-step-1-error')).toBeNull();
    expect(analyticsEvents('handson_tour_step_completed')).toHaveLength(1);
    expect(analyticsEvents('handson_tour_step_error')).toHaveLength(0);
  });

  it('保存が 400 なら Step 2 へ進まず、エラー画面を出し、失敗 (http_status) を記録して完了は記録しない', async () => {
    fetchMock.mockResolvedValue(jsonResponse(HTTP_BAD_REQUEST, { error: 'bad' }));
    await mountPage(HandsonTourPhotoPage);

    await advancePhotoToSaveAndPress();

    expect(mocks.push).not.toHaveBeenCalled();
    expect(byTestId('tour-step-1-error')).not.toBeNull();
    expect(byTestId('tour-step-1-error')?.textContent).toContain('保存できませんでした');
    expect(byTestId('fake-overlay')).toBeNull();
    const errors = analyticsEvents('handson_tour_step_error');
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toMatchObject({ step: 1, error_code: 'sandbox_save_failed', http_status: HTTP_BAD_REQUEST });
    expect(analyticsEvents('handson_tour_step_completed')).toHaveLength(0);
  });

  it('通信そのものが失敗しても (ネットワーク断) エラー画面を出して先へ進まない', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await mountPage(HandsonTourPhotoPage);

    await advancePhotoToSaveAndPress();

    expect(mocks.push).not.toHaveBeenCalled();
    expect(byTestId('tour-step-1-error')).not.toBeNull();
    expect(analyticsEvents('handson_tour_step_error')[0][1]).toMatchObject({ error_code: 'sandbox_save_network_error' });
  });

  // 設定からのやり直し (完了・スキップ済み) では、お試しの保存は 409 already_finished で必ず断られる (設計書 17-security §2.1)。
  // 以前はこれをエラー画面にしていて、【もう一度】は永久に失敗し、Step 2〜4 へ進めなかった (R1 blocking 1)
  it.each([
    [HTTP_CONFLICT, 'already_finished'],
    [HTTP_CONFLICT, 'existing_user'],
    [HTTP_FORBIDDEN, 'admin_role'],
  ])(
    '保存が %i sandbox_not_eligible (%s) なら、エラー画面を出さずに Step 2 へ進み、完了を記録して失敗は記録しない',
    async (status, reason) => {
      fetchMock.mockResolvedValue(
        jsonResponse(status, {
          error: { code: 'sandbox_not_eligible', message: 'サンドボックスの利用条件を満たしていません', reason },
        }),
      );
      await mountPage(HandsonTourPhotoPage);

      await advancePhotoToSaveAndPress();

      expect(callsTo('/api/meal-plans/add-from-photo')).toHaveLength(1);
      expect(mocks.push).toHaveBeenCalledWith(HANDSON_TOUR_ROUTES.step2);
      expect(byTestId('tour-step-1-error')).toBeNull();
      expect(analyticsEvents('handson_tour_step_completed')).toHaveLength(1);
      expect(analyticsEvents('handson_tour_step_error')).toHaveLength(0);
    },
  );

  it.each([
    [HTTP_CONFLICT, { error: { code: 'conflict' } }],
    [HTTP_INTERNAL_ERROR, { error: 'Failed to save sandbox meal' }],
    [HTTP_INTERNAL_ERROR, 'not json'],
  ])('保存の対象でないという応答でない失敗 (%i) は、これまでどおりエラー画面を出して進まない', async (status, body) => {
    fetchMock.mockResolvedValue(
      typeof body === 'string' ? new Response(body, { status }) : jsonResponse(status, body),
    );
    await mountPage(HandsonTourPhotoPage);

    await advancePhotoToSaveAndPress();

    expect(mocks.push).not.toHaveBeenCalled();
    expect(byTestId('tour-step-1-error')).not.toBeNull();
    expect(analyticsEvents('handson_tour_step_error')[0][1]).toMatchObject({
      error_code: 'sandbox_save_failed',
      http_status: status,
    });
  });

  it('【もう一度】で同じ本文を送り直し、成功したら Step 2 へ進む', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(HTTP_BAD_REQUEST, { error: 'bad' }))
      .mockResolvedValueOnce(jsonResponse(HTTP_OK, { success: true }));
    await mountPage(HandsonTourPhotoPage);
    await advancePhotoToSaveAndPress();

    await click('tour-step-1-error-retry');

    const saves = callsTo('/api/meal-plans/add-from-photo');
    expect(saves).toHaveLength(2);
    expect(JSON.parse(saves[1][1].body)).toEqual(JSON.parse(saves[0][1].body));
    expect(mocks.push).toHaveBeenCalledWith(HANDSON_TOUR_ROUTES.step2);
    expect(byTestId('tour-step-1-error')).toBeNull();
  });

  it(`連続 ${HANDSON_TOUR_CONSTANTS.ERROR_CONSECUTIVE_THRESHOLD} 回失敗したら【あとで】を太字で強調する (それまでは強調しない)`, async () => {
    fetchMock.mockResolvedValue(jsonResponse(HTTP_BAD_REQUEST, { error: 'bad' }));
    await mountPage(HandsonTourPhotoPage);
    await advancePhotoToSaveAndPress();

    for (let failures = 1; failures < HANDSON_TOUR_CONSTANTS.ERROR_CONSECUTIVE_THRESHOLD; failures += 1) {
      expect(byTestId('tour-step-1-error-skip')?.className).not.toContain('font-bold');
      await click('tour-step-1-error-retry');
    }
    expect(byTestId('tour-step-1-error-skip')?.className).toContain('font-bold');
  });

  it('【あとで】でスキップを記録し (skip API)、ホームへ戻る', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).startsWith('/api/handson-tour/skip')
        ? jsonResponse(HTTP_OK, { ok: true })
        : jsonResponse(HTTP_BAD_REQUEST, { error: 'bad' }),
    );
    await mountPage(HandsonTourPhotoPage);
    await advancePhotoToSaveAndPress();

    await click('tour-step-1-error-skip');

    const skips = callsTo('/api/handson-tour/skip');
    expect(skips).toHaveLength(1);
    expect(JSON.parse(skips[0][1].body)).toEqual({ step: 1, reason: 'user_action' });
    expect(mocks.push).toHaveBeenCalledWith('/home');
    expect(mocks.push).not.toHaveBeenCalledWith(HANDSON_TOUR_ROUTES.step2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2・3. Step 3 の「獲得済」と自動スクロール
// ─────────────────────────────────────────────────────────────────────────────

/** /api/badges の実際の応答の形 (src/app/api/badges/route.ts: badges の行 + earned + obtainedAt) */
function badge(code: string, earned: boolean) {
  return {
    id: `id-${code}`,
    code,
    name: `name-${code}`,
    description: '',
    icon: null,
    earned,
    obtainedAt: earned ? '2026-10-15T00:00:00.000Z' : null,
  };
}

/** ツアーを通した利用者が Step 3 に来たときの獲得状態 (#1626: お試しの記録は first_bite に数えないので、付いているのは planner だけ) */
const earnedInTour = (code: string): boolean => (STEP3_BADGES_EARNED_IN_TOUR as readonly string[]).includes(code);

const BADGES_RESPONSE = {
  badges: [
    badge('first_bite', earnedInTour('first_bite')),
    badge('streak_3', false),
    badge('planner', earnedInTour('planner')),
    badge('tutorial_complete', false),
  ],
  newEarnedCount: 0,
  newEarnedBadgeCodes: [],
  stats: { completedMeals: 0, cookMeals: 0, streak: 0 },
};

let scrollCalls: Array<{ testId: string | null; options: ScrollIntoViewOptions | boolean | undefined }>;
let reducedMotion: boolean;

function stubBrowserApis() {
  scrollCalls = [];
  // jsdom には scrollIntoView / matchMedia が無い
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element, options?: ScrollIntoViewOptions | boolean) {
    scrollCalls.push({ testId: this.getAttribute('data-testid'), options });
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: reducedMotion,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

async function mountBadges() {
  fetchMock.mockImplementation(async (url: string) =>
    String(url) === '/api/badges' ? jsonResponse(HTTP_OK, BADGES_RESPONSE) : jsonResponse(HTTP_OK, {}),
  );
  await mountPage(HandsonTourBadgesPage);
}

describe('#1604 Step 3: 「獲得済」は /api/badges の earned で出す', () => {
  beforeEach(() => {
    reducedMotion = false;
    stubBrowserApis();
  });

  it('earned のバッジ (ツアーで付く planner) だけに「獲得済」が付き、first_bite (お試しの記録では付かない。#1626) や tutorial_complete などには付かない', async () => {
    await mountBadges();

    expect(byTestId('badge-card-planner')?.textContent).toContain('獲得済');
    expect(byTestId('badge-card-first_bite')?.textContent).not.toContain('獲得済');
    expect(byTestId('badge-card-tutorial_complete')?.textContent).not.toContain('獲得済');
    expect(byTestId('badge-card-streak_3')?.textContent).not.toContain('獲得済');
    // 未獲得の tutorial_complete は半透明 (設計書 05-step3 §3.6)
    expect(byTestId('badge-card-tutorial_complete')?.className).toContain('opacity-50');
    expect(byTestId('badge-card-planner')?.className).toContain('bg-blue-50');
    expect(byTestId('badge-card-first_bite')?.className).not.toContain('bg-blue-50');
  });

  it('first_bite が獲得済み (本物の食事の記録がある人のやり直しのツアー) なら「獲得済」を付ける', async () => {
    BADGES_RESPONSE.badges[0] = badge('first_bite', true);
    try {
      await mountBadges();
      expect(byTestId('badge-card-first_bite')?.textContent).toContain('獲得済');
      expect(byTestId('badge-card-first_bite')?.className).toContain('bg-blue-50');
    } finally {
      BADGES_RESPONSE.badges[0] = badge('first_bite', earnedInTour('first_bite'));
    }
  });

  // #1626: first_bite の吹き出し (3.2) は、カードが「獲得済」でもそうでなくても同じ文言で指す。
  // 獲得済みのカードを「…するともらえます」と言ったり、未獲得のカードを「…しました」と言ったりして、画面が食い違わないこと
  it.each([
    { label: 'ツアーを通しただけ (first_bite は未獲得)', earned: false },
    { label: 'やり直しのツアーで first_bite が獲得済み', earned: true },
  ])('$label: first_bite の吹き出しは、カードの「獲得済」の有無と食い違わない', async ({ earned }) => {
    BADGES_RESPONSE.badges[0] = badge('first_bite', earned);
    try {
      await mountBadges();
      await click('auto-advance'); // 3.1 → 3.2 (first_bite のカード)

      const body = byTestId('bubble-body')?.textContent ?? '';
      expect(byTestId('bubble-title')?.textContent).toBe(HANDSON_TOUR_I18N_JA.tour.step3.first_bite_title);
      expect(body).toBe(HANDSON_TOUR_I18N_JA.tour.step3.first_bite_bubble);
      expect(byTestId('badge-card-first_bite')?.textContent?.includes('獲得済')).toBe(earned);
      // 獲得済みの言い方も未獲得の言い方もしない
      expect(body).not.toMatch(/しました|もらえます/);
    } finally {
      BADGES_RESPONSE.badges[0] = badge('first_bite', earnedInTour('first_bite'));
    }
  });

  // #1626: 以前は intro が「もう 2 つ獲得しています」で、実際に「獲得済」が付くのは planner の 1 つだけだった
  it('intro の「もう n つ獲得しています」の n が、ツアーを通した状態で「獲得済」が付くカードの数と同じ', async () => {
    await mountBadges();

    const earnedCards = [...container.querySelectorAll('[data-testid^="badge-card-"]')].filter((card) =>
      card.textContent?.includes('獲得済'),
    );
    const intro = byTestId('bubble-body')?.textContent ?? '';
    const introCount = Number(/(\d+)\s*つ獲得/.exec(intro)?.[1]);

    // 吹き出しは共有の文言 (packages/handson-tour-shared の intro_title) を、プロフィールのニックネームで埋めたもの
    expect(intro).toBe(personalize(HANDSON_TOUR_I18N_JA.tour.step3.intro_title, { nickname: 'はなこ' }));
    expect(earnedCards.map((card) => card.getAttribute('data-testid'))).toEqual(['badge-card-planner']);
    expect(introCount).toBe(earnedCards.length);
    expect(introCount).toBe(STEP3_BADGES_EARNED_IN_TOUR.length);
  });
  // 注: intro の数は固定の文言 (ツアーを通した人の数)。やり直しのツアーで planner のほかにも獲得済みのバッジがある人には
  // 「獲得済」のカードの数と合わない (#1626 では文言を「1 つ獲得」に直す範囲にとどめた。数を応答から埋める形にはしていない)

  it('tutorial_complete が獲得済み (やり直しのツアー) なら「獲得済」を付け、半透明にしない', async () => {
    BADGES_RESPONSE.badges[3] = badge('tutorial_complete', true);
    try {
      await mountBadges();
      expect(byTestId('badge-card-tutorial_complete')?.textContent).toContain('獲得済');
      expect(byTestId('badge-card-tutorial_complete')?.className).not.toContain('opacity-50');
    } finally {
      BADGES_RESPONSE.badges[3] = badge('tutorial_complete', false);
    }
  });
});

describe('#1604 Step 3: 吹き出しの対象のカードを画面の中へ自動でスクロールする (設計書 05-step3 §7.2)', () => {
  beforeEach(() => {
    reducedMotion = false;
    stubBrowserApis();
  });

  it('first_bite → planner → tutorial_complete の各段階で、その段階のカードを画面の中央へ smooth でスクロールする', async () => {
    await mountBadges();
    // intro (3.1) は対象のカードが無いのでスクロールしない
    expect(scrollCalls).toEqual([]);

    await click('auto-advance'); // 3.1 → 3.2
    await click('primary'); // 3.2 → 3.3
    await click('primary'); // 3.3 → 3.4

    expect(scrollCalls).toEqual([
      { testId: 'badge-card-first_bite', options: { behavior: 'smooth', block: 'center' } },
      { testId: 'badge-card-planner', options: { behavior: 'smooth', block: 'center' } },
      { testId: 'badge-card-tutorial_complete', options: { behavior: 'smooth', block: 'center' } },
    ]);
  });

  it('reduce-motion のときは instant (behavior: auto) でスクロールする (設計書 05-step3 §7.3)', async () => {
    reducedMotion = true;
    await mountBadges();

    await click('auto-advance'); // 3.1 → 3.2

    expect(scrollCalls).toEqual([{ testId: 'badge-card-first_bite', options: { behavior: 'auto', block: 'center' } }]);
  });

  it('ツアー中は一覧の下に余白を足し、最後の行のカードも画面の中央まで上げられるようにする', async () => {
    await mountBadges();

    const list = byTestId('badge-card-first_bite')?.parentElement?.parentElement;
    expect(list?.style.paddingBottom).toBe('50vh');
  });

  it('[次へ] を最後まで押すと Step 4 へ進む', async () => {
    await mountBadges();

    await click('auto-advance');
    await click('primary');
    await click('primary');
    await click('primary');

    expect(mocks.push).toHaveBeenCalledWith(HANDSON_TOUR_ROUTES.step4);
  });
});
