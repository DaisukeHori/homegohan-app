/**
 * #2254 M2 健康のチャレンジ (/health/challenges) の残りの日数の回帰テスト。
 *
 * 問題 (直す前): 行ごとに daysUntilLocal (中で時計を読む) を呼んでいたので、0 時をまたいだ描画の中で、行ごとに別の日から数えうった
 *   (同じ終了日のチャレンジが、同じ画面で「残り 3 日」と「残り 2 日」になる)
 * 直したあと: 今日は描画ごとに 1 回だけ読み (todayLocal)、その描画の行はどれも daysUntilFrom でその今日から数える
 *
 * 0 時をまたぐ描画の極端な形として、日付の関数 (@/lib/date-utils) を 1 回呼ぶたびに時計を 1 日進める
 * (行ごとに時計を読むと、行ごとに違う日になる)。このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 日付の関数を呼ぶたびに時計を 1 日進めるか */
const clock = vi.hoisted(() => ({ advancing: false }));
/** 1 日のミリ秒 */
const DAY_MS = vi.hoisted(() => 24 * 60 * 60 * 1000);

vi.mock('@/lib/date-utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    wrapped[name] =
      typeof value === 'function'
        ? (...args: unknown[]) => {
            try {
              return (value as (...a: unknown[]) => unknown)(...args);
            } finally {
              if (clock.advancing) vi.setSystemTime(new Date(Date.now() + DAY_MS));
            }
          }
        : value;
  }
  return wrapped;
});
vi.mock('next/navigation', () => ({
  usePathname: () => '/health/challenges',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
}));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const MOTION_PROPS = new Set([
    'initial', 'animate', 'exit', 'transition', 'variants', 'whileHover', 'whileTap', 'whileInView', 'whileFocus',
    'layout', 'layoutId', 'drag', 'dragConstraints', 'onAnimationComplete', 'viewport', 'custom',
  ]);
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          const MotionElement = React.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
            const rest: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) if (!MOTION_PROPS.has(key)) rest[key] = value;
            return React.createElement(tag, { ...rest, ref });
          });
          MotionElement.displayName = `motion.${tag}`;
          cache.set(tag, MotionElement);
        }
        return cache.get(tag);
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});

const { default: HealthChallengesPage } = await import('@/app/(main)/health/challenges/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 取得の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 10;
/** 開いたときの時計 (JST 2026-11-05 (木) 12:00) */
const OPENED_AT = '2026-11-05T03:00:00.000Z';
/** 3 つのチャレンジの終了日 (どれも同じ日) */
const END_DATE = '2026-11-10';
const CHALLENGE_COUNT = 3;

function challengeOf(index: number) {
  return {
    id: `challenge-${index}`,
    challenge_type: 'vegetable',
    title: `チャレンジ ${index}`,
    description: '野菜を食べる',
    start_date: '2026-11-03',
    end_date: END_DATE,
    target_metric: 'vegetable_days',
    target_value: 7,
    target_unit: '日',
    current_value: 1,
    status: 'active',
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clock.advancing = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(OPENED_AT));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ challenges: Array.from({ length: CHALLENGE_COUNT }, (_, i) => challengeOf(i)), templates: [] }),
    })),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TASKS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** 行ごとの残りの日数の文 (「残りn日」) */
const remainingTexts = () => (container.textContent ?? '').match(/残り-?\d+日/g) ?? [];

describe('健康のチャレンジの残りの日数は、描画で 1 回だけ読んだ今日から数える (#2254 M2)', () => {
  it('時計が止まっていれば、同じ終了日の行はどれも同じ残りの日数 (検査の前提)', async () => {
    await act(async () => {
      root.render(<HealthChallengesPage />);
    });
    await settle();
    // JST 2026-11-05 から 2026-11-10 まで
    expect(remainingTexts()).toEqual(Array.from({ length: CHALLENGE_COUNT }, () => '残り5日'));
  });

  it('描画の途中で日付が進んでも、同じ描画の行はどれも同じ今日から数える (直す前は行ごとに時計を読み、行ごとに違った)', async () => {
    clock.advancing = true;
    await act(async () => {
      root.render(<HealthChallengesPage />);
    });
    await settle();
    clock.advancing = false;
    const texts = remainingTexts();
    expect(texts, 'チャレンジの行が描かれていない (検査の前提が崩れた)').toHaveLength(CHALLENGE_COUNT);
    expect(new Set(texts).size, `同じ描画の行が別の日から数えている: ${texts.join(' / ')}`).toBe(1);
  });
});
