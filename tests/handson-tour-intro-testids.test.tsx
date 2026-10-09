/**
 * #846 ハンズオンツアーの intro 吹き出しの testID (tour-step-1-intro / tour-step-2-intro / tour-step-3-intro)
 *
 * 背景:
 *   E2E (tests/e2e/tour) は、各 Step の最初の intro 吹き出しを testID で見分ける。設計書の testID 一覧
 *   (docs/design/family/09-onboarding-handson-tour/11-testing.md) にはあったが、Web の実装に無く、
 *   E2E 側は「未実装」のまま test.skip になっていた。
 *
 * ここで確かめること:
 *   1. TourBubble は、bubble.testId があるときだけ、その testID を持つ要素で中身を包む
 *      (無い吹き出しは、これまでと同じ DOM のまま。tour-bubble-body などの testID は変わらない)
 *   2. 各 Step のページは、intro の段階 (1.1 / 2.1 / 3.1) の吹き出しにだけ testId を渡す
 *      (次の段階に進んだら外れる。intro 以外の吹き出しに付けると、E2E が intro の終わりを見分けられなくなる)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 * オーバーレイ本体 (framer-motion / focus-trap) はこのテストの関心外なので、ページが渡す props だけを受ける差し替えにしている。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TourBubble } from '@/components/handson-tour/TourBubble';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

// ログインしていない状態にして、プロフィールの取得 (このテストの関心外) を走らせない
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

// Step 3 のページは動きを減らす設定 (matchMedia。jsdom には無い) を見る。このテストの関心外
vi.mock('@/components/handson-tour/useReducedMotion', () => ({
  useReducedMotion: () => false,
}));

type CapturedOverlay = {
  bubble: { body: string; testId?: string };
  onAutoAdvance?: () => void;
};

// ページが TourSandboxWrapper (Step 1 / 2) と TourOverlay (Step 3) に渡す吹き出しを、そのまま画面に出す
vi.mock('@/components/handson-tour/TourSandboxWrapper', () => ({
  TourSandboxWrapper: ({ overlay }: { overlay: CapturedOverlay }) => <CapturedBubble overlay={overlay} />,
}));
vi.mock('@/components/handson-tour/TourOverlay', () => ({
  TourOverlay: (props: CapturedOverlay) => <CapturedBubble overlay={props} />,
}));

function CapturedBubble({ overlay }: { overlay: CapturedOverlay }) {
  return (
    <div>
      <p data-testid="captured-test-id">{overlay.bubble.testId ?? ''}</p>
      {overlay.onAutoAdvance && (
        <button data-testid="auto-advance" onClick={overlay.onAutoAdvance}>
          auto
        </button>
      )}
    </div>
  );
}

const { default: HandsonTourPhotoPage } = await import('@/app/handson-tour/photo/page');
const { default: HandsonTourMenuPage } = await import('@/app/handson-tour/menu/page');
const { default: HandsonTourBadgesPage } = await import('@/app/handson-tour/badges/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await flush();
}

/** 解決済みの Promise の連鎖 (fetch の応答 → setState) を流し切る */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function capturedTestId(): string {
  return byTestId('captured-test-id')?.textContent ?? '';
}

async function autoAdvance() {
  const button = byTestId('auto-advance');
  expect(button, 'auto-advance が見つからない').not.toBeNull();
  await act(async () => {
    button!.click();
  });
}

beforeEach(() => {
  mocks.push.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ badges: [] }) })),
  );
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('TourBubble: bubble.testId', () => {
  const baseProps = {
    target: null,
    position: 'auto' as const,
    offset: 12,
    progress: { current: 2, total: 5 },
  };

  it('testId があるときは、その testID を持つ要素が吹き出し (tour-bubble) の中で、タイトル・本文を包む', async () => {
    await mount(
      <TourBubble {...baseProps} bubble={{ body: '写真 1 枚で食事が記録できます', testId: 'tour-step-1-intro' }} />,
    );

    const intro = byTestId('tour-step-1-intro');
    expect(intro).not.toBeNull();
    expect(byTestId('tour-bubble')?.contains(intro)).toBe(true);
    expect(intro?.querySelector('[data-testid="tour-bubble-body"]')?.textContent).toBe('写真 1 枚で食事が記録できます');
    expect(intro?.querySelector('[data-testid="tour-progress-dots"]')).not.toBeNull();
  });

  it('testId があっても、primaryAction のボタン (tour-next-button) は同じ testID のまま、包まれた中にある', async () => {
    await mount(
      <TourBubble
        {...baseProps}
        bubble={{ title: 'タイトル', body: '本文', testId: 'tour-step-3-intro' }}
        primaryAction={{ label: '次へ', onPress: () => {} }}
      />,
    );

    const intro = byTestId('tour-step-3-intro');
    expect(intro?.querySelector('[data-testid="tour-bubble-title"]')?.textContent).toBe('タイトル');
    expect(intro?.querySelector('[data-testid="tour-next-button"]')?.textContent).toBe('次へ');
  });

  it('testId が無いときは、余計な要素を足さない (tour-bubble の直下に本文が並ぶ。これまでと同じ DOM)', async () => {
    await mount(<TourBubble {...baseProps} bubble={{ body: 'camera' }} />);

    const bubble = byTestId('tour-bubble');
    const body = byTestId('tour-bubble-body');
    expect(body?.parentElement).toBe(bubble);
    expect(container.querySelector('[data-testid^="tour-step-"]')).toBeNull();
  });
});

describe('各 Step のページ: intro の段階の吹き出しにだけ testId を渡す', () => {
  it('Step 1 (写真): 1.1 の intro は tour-step-1-intro、次の段階 (1.2 カメラ) では外れる', async () => {
    await mount(<HandsonTourPhotoPage />);
    expect(capturedTestId()).toBe('tour-step-1-intro');

    await autoAdvance(); // 1.1 → 1.2
    expect(capturedTestId()).toBe('');
  });

  it('Step 2 (献立): 2.1 の intro は tour-step-2-intro、次の段階 (2.2 条件フラグ) では外れる', async () => {
    await mount(<HandsonTourMenuPage />);
    expect(capturedTestId()).toBe('tour-step-2-intro');

    await autoAdvance(); // 2.1 → 2.2
    expect(capturedTestId()).toBe('');
  });

  it('Step 3 (バッジ): バッジの読み込みが終わった 3.1 の intro は tour-step-3-intro、次の段階 (3.2) では外れる', async () => {
    await mount(<HandsonTourBadgesPage />);
    expect(capturedTestId()).toBe('tour-step-3-intro');

    await autoAdvance(); // 3.1 → 3.2
    expect(capturedTestId()).toBe('');
  });
});
