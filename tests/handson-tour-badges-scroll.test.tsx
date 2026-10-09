/**
 * #846 ハンズオンツアー Step 3 (バッジ確認) の自動スクロール (設計書 05-step3-badges §7.2 / §7.3)
 *
 * 背景:
 *   Step 3 は /api/badges が返すバッジの一覧を出す。付与処理のあるバッジ (src/lib/badges/awardable.ts) が 20 種前後あり、
 *   1 画面に収まらない。Spotlight の対象 (first_bite → planner → tutorial_complete) のカードは一覧の下の方にあり、
 *   吹き出しはカードの下に出るため、画面の中央までスクロールしないと、吹き出しとその [次へ] ボタンが画面の外に出て
 *   押せない (1280x720 の E2E で [次へ] が "outside of the viewport" になり、Step 4 へ進めなかった)。
 *   設計書には「Spotlight 対象が画面外なら自動スクロール (smooth)」「動きを減らす設定ならアニメーションなし」とあったが、
 *   Web の実装に無かった。
 *
 * 一覧の最後の方のカードは、スクロールしても画面の下端までしか来られず、カードの下に吹き出しの場所が無い。
 * 吹き出しを「下」に固定していると、そのカードでも [次へ] が画面の外に出る (375x667 の確認で planner がそうだった)。
 * 下に余白が無ければ上に出す 'auto' にして、どのカードでも [次へ] が画面の中に来るようにした。
 *
 * ここで確かめること:
 *   - intro (3.1) など、Spotlight の対象が無い段階ではスクロールしない
 *   - 3.2 / 3.3 / 3.4 で、その段階の対象のカードを、画面の中央 (block: 'center') へスクロールする
 *   - 動きを減らす設定のときは behavior: 'auto' (アニメーションなし)、そうでなければ 'smooth'
 *   - 3.2 / 3.3 / 3.4 の吹き出しの位置は 'auto' (下に固定しない)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 * オーバーレイ本体 (framer-motion / focus-trap) はこのテストの関心外なので、ページが渡す進行用のボタンだけを出す差し替えにしている。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  reducedMotion: { current: false },
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

vi.mock('@/components/handson-tour/useReducedMotion', () => ({
  useReducedMotion: () => mocks.reducedMotion.current,
}));

vi.mock('@/components/handson-tour/TourOverlay', () => ({
  TourOverlay: (props: {
    bubble: { position: string };
    primaryAction?: { onPress: () => void };
    onAutoAdvance?: () => void;
  }) => (
    <div>
      <p data-testid="bubble-position">{props.bubble.position}</p>
      {props.onAutoAdvance && (
        <button data-testid="auto-advance" onClick={props.onAutoAdvance}>
          auto
        </button>
      )}
      {props.primaryAction && (
        <button data-testid="primary" onClick={props.primaryAction.onPress}>
          next
        </button>
      )}
    </div>
  ),
}));

const { default: HandsonTourBadgesPage } = await import('@/app/handson-tour/badges/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** /api/badges の応答。Spotlight の対象 3 枚の前に、関係の無いバッジが並ぶ (本番の一覧と同じく、対象は下の方にある) */
const BADGES = [
  { code: 'segment_rank_1', name: 'セグメント1位', description: '', icon: null },
  { code: 'segment_rank_top3', name: 'トップ3', description: '', icon: null },
  { code: 'first_bite', name: 'はじめの一歩', description: '', icon: '👣' },
  { code: 'planner', name: '計画上手', description: '', icon: '📋' },
  { code: 'tutorial_complete', name: '使い方マスター', description: '', icon: '🎓' },
].map((badge) => ({ ...badge, obtained_at: null }));

let container: HTMLDivElement;
let root: Root;
let scrollIntoView: ReturnType<typeof vi.fn>;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<HandsonTourBadgesPage />);
  });
  // fetch の応答 → setState (isLoading 解除 + 3.1) を流し切る
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
}

/** scrollIntoView が呼ばれた要素の testID と引数を、呼ばれた順に返す */
function scrolled(): Array<{ testId: string | null; options: unknown }> {
  return scrollIntoView.mock.calls.map((call, index) => ({
    testId: (scrollIntoView.mock.contexts[index] as HTMLElement).getAttribute('data-testid'),
    options: call[0],
  }));
}

beforeEach(() => {
  mocks.push.mockReset();
  mocks.reducedMotion.current = false;
  // jsdom には scrollIntoView が無い
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ badges: BADGES }) })),
  );
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe('Step 3 (バッジ確認): Spotlight の対象のカードを画面の中央へスクロールする', () => {
  it('intro (3.1) など、Spotlight の対象が無い段階ではスクロールしない', async () => {
    await mount();

    // バッジの一覧は出ていて、intro の段階
    expect(byTestId('badge-card-first_bite')).not.toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('3.2 → 3.3 → 3.4 で、first_bite → planner → tutorial_complete のカードを、順に画面の中央へスクロールする (smooth)', async () => {
    await mount();

    await click('auto-advance'); // 3.1 → 3.2
    await click('primary'); // 3.2 → 3.3
    await click('primary'); // 3.3 → 3.4

    expect(scrolled()).toEqual([
      { testId: 'badge-card-first_bite', options: { behavior: 'smooth', block: 'center' } },
      { testId: 'badge-card-planner', options: { behavior: 'smooth', block: 'center' } },
      { testId: 'badge-card-tutorial_complete', options: { behavior: 'smooth', block: 'center' } },
    ]);
  });

  it('動きを減らす設定のときは、アニメーションなし (behavior: auto) でスクロールする', async () => {
    mocks.reducedMotion.current = true;
    await mount();

    await click('auto-advance'); // 3.1 → 3.2

    expect(scrolled()).toEqual([
      { testId: 'badge-card-first_bite', options: { behavior: 'auto', block: 'center' } },
    ]);
  });

  it('3.2 / 3.3 / 3.4 の吹き出しは、下に固定せず、下に余白が無ければ上に出す位置 (auto) にする', async () => {
    await mount();

    await click('auto-advance'); // 3.1 → 3.2
    expect(byTestId('bubble-position')?.textContent).toBe('auto');
    await click('primary'); // 3.2 → 3.3
    expect(byTestId('bubble-position')?.textContent).toBe('auto');
    await click('primary'); // 3.3 → 3.4
    expect(byTestId('bubble-position')?.textContent).toBe('auto');
  });

  it('最後の [次へ] (3.4) は Step 4 へ進み、そのあと余計なスクロールはしない', async () => {
    await mount();
    await click('auto-advance'); // 3.1 → 3.2
    await click('primary'); // 3.2 → 3.3
    await click('primary'); // 3.3 → 3.4
    const callsBefore = scrollIntoView.mock.calls.length;

    await click('primary'); // 3.4 → Step 4

    expect(mocks.push).toHaveBeenCalledWith('/handson-tour/graduate');
    expect(scrollIntoView.mock.calls.length).toBe(callsBefore);
  });
});
