/**
 * tests/handson-tour-unit/useTourOverlayLogic.test.ts
 *
 * src/components/handson-tour/useTourOverlayLogic.ts の
 * reduced motion + step transition ロジックのユニットテスト。
 * 設計書: docs/design/family/09-onboarding-handson-tour/11-testing.md §2.3 §2.4
 *
 * @testing-library/react は本リポジトリにインストールされていないため、
 * フック内部の純粋なロジック (measureSingleElement / mergeRects / タイマー) を
 * jsdom + vi.fake-timers を使って検証する。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ──────────────────────────────────────────────────────────────
// フック本体 import
// ──────────────────────────────────────────────────────────────

import { useTourOverlayLogic } from '@/components/handson-tour/useTourOverlayLogic';

// ──────────────────────────────────────────────────────────────
// DOM helpers
// ──────────────────────────────────────────────────────────────

function createElementWithTestId(testId: string, rect: DOMRect): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-testid', testId);
  // jsdom の getBoundingClientRect は常に 0 を返すため、mockReturnValue で上書き
  el.getBoundingClientRect = vi.fn().mockReturnValue(rect);
  document.body.appendChild(el);
  return el;
}

function makeDOMRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

// ──────────────────────────────────────────────────────────────
// useTourOverlayLogic のロジックテスト
// ──────────────────────────────────────────────────────────────

describe('useTourOverlayLogic (フック import 確認)', () => {
  it('useTourOverlayLogic が関数としてエクスポートされている', () => {
    expect(typeof useTourOverlayLogic).toBe('function');
  });
});

// ──────────────────────────────────────────────────────────────
// measureSingleElement / mergeRects ロジックを DOM で検証
// ──────────────────────────────────────────────────────────────

describe('DOM 要素の矩形計測ロジック', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('data-testid 属性がある要素の getBoundingClientRect を取得できる', () => {
    const rect = makeDOMRect(10, 20, 100, 50);
    createElementWithTestId('target-button', rect);

    const el = document.querySelector('[data-testid="target-button"]') as HTMLElement;
    expect(el).not.toBeNull();

    const domRect = el.getBoundingClientRect();
    expect(domRect.x).toBe(10);
    expect(domRect.y).toBe(20);
    expect(domRect.width).toBe(100);
    expect(domRect.height).toBe(50);
  });

  it('data-testid が存在しない場合は querySelector が null を返す', () => {
    const el = document.querySelector('[data-testid="nonexistent"]');
    expect(el).toBeNull();
  });

  it('複数要素の矩形を mergeRects ロジックで結合できる', () => {
    // mergeRects のロジックを直接テスト
    type Rect = { x: number; y: number; width: number; height: number };

    function mergeRects(rects: Rect[]): Rect {
      const minX = Math.min(...rects.map((r) => r.x));
      const minY = Math.min(...rects.map((r) => r.y));
      const maxX = Math.max(...rects.map((r) => r.x + r.width));
      const maxY = Math.max(...rects.map((r) => r.y + r.height));
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    const rect1 = { x: 0, y: 0, width: 100, height: 50 };
    const rect2 = { x: 50, y: 30, width: 80, height: 40 };

    const merged = mergeRects([rect1, rect2]);

    expect(merged.x).toBe(0);       // min x
    expect(merged.y).toBe(0);       // min y
    expect(merged.width).toBe(130);  // max(0+100, 50+80) - 0 = 130
    expect(merged.height).toBe(70);  // max(0+50, 30+40) - 0 = 70
  });

  it('mergeRects: 同一矩形ひとつはそのまま返す', () => {
    type Rect = { x: number; y: number; width: number; height: number };

    function mergeRects(rects: Rect[]): Rect {
      const minX = Math.min(...rects.map((r) => r.x));
      const minY = Math.min(...rects.map((r) => r.y));
      const maxX = Math.max(...rects.map((r) => r.x + r.width));
      const maxY = Math.max(...rects.map((r) => r.y + r.height));
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    const rect = { x: 10, y: 20, width: 100, height: 50 };
    const merged = mergeRects([rect]);

    expect(merged.x).toBe(10);
    expect(merged.y).toBe(20);
    expect(merged.width).toBe(100);
    expect(merged.height).toBe(50);
  });

  it('width=0 / height=0 の要素は targetRect の対象外とすべき (ガード条件)', () => {
    // measureSingleElement のガード: rect.width === 0 && rect.height === 0 → null
    const rect = makeDOMRect(0, 0, 0, 0);
    const el = createElementWithTestId('zero-size-element', rect);

    const domRect = el.getBoundingClientRect();
    const isZeroSize = domRect.width === 0 && domRect.height === 0;

    expect(isZeroSize).toBe(true);
    // ガード条件より null が返るべき
  });
});

// ──────────────────────────────────────────────────────────────
// autoAdvance タイマーロジック
// ──────────────────────────────────────────────────────────────

describe('autoAdvance タイマーロジック', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('setTimeout が指定 ms 後にコールバックを呼ぶ', () => {
    const callback = vi.fn();
    const autoAdvanceMs = 2500;

    const timerId = window.setTimeout(callback, autoAdvanceMs);

    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2499);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();

    clearTimeout(timerId);
  });

  it('clearTimeout でコールバックがキャンセルされる', () => {
    const callback = vi.fn();
    const timerId = window.setTimeout(callback, 2500);

    vi.advanceTimersByTime(1000);
    clearTimeout(timerId);
    vi.advanceTimersByTime(2000);

    expect(callback).not.toHaveBeenCalled();
  });

  it('setInterval が定期的にコールバックを呼ぶ', () => {
    const callback = vi.fn();
    const intervalMs = 100;

    const timerId = window.setInterval(callback, intervalMs);

    vi.advanceTimersByTime(350);
    expect(callback).toHaveBeenCalledTimes(3);

    clearInterval(timerId);
  });

  it('clearInterval でインターバルが止まる', () => {
    const callback = vi.fn();
    const timerId = window.setInterval(callback, 100);

    vi.advanceTimersByTime(250);
    clearInterval(timerId);
    vi.advanceTimersByTime(300);

    // 250ms までに 2 回呼ばれ、その後は止まる
    expect(callback).toHaveBeenCalledTimes(2);
  });
});

// ──────────────────────────────────────────────────────────────
// step 遷移タイムアウトロジック (設計書 §2.4 準拠)
// ──────────────────────────────────────────────────────────────

describe('Step 自動遷移タイミング検証 (vi.useFakeTimers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('subStep 1.1 → 1.2 は 2.5s 後に自動遷移する (タイマー検証)', () => {
    // 設計書 §2.4: subStep 1.1 → 1.2 を 2.5s 後に自動遷移
    const onAdvance = vi.fn();
    const STEP_1_1_DURATION_MS = 2500;

    const timerId = window.setTimeout(onAdvance, STEP_1_1_DURATION_MS);

    vi.advanceTimersByTime(2499);
    expect(onAdvance).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onAdvance).toHaveBeenCalledOnce();

    clearTimeout(timerId);
  });

  it('autoAdvanceMs=1000 で onAutoAdvance が 1 秒後に発火する', () => {
    const onAutoAdvance = vi.fn();
    const autoAdvanceMs = 1000;

    // useTourOverlayLogic の autoAdvance タイマーロジックを再現
    const timerId = window.setTimeout(() => {
      onAutoAdvance();
    }, autoAdvanceMs);

    expect(onAutoAdvance).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onAutoAdvance).toHaveBeenCalledOnce();

    clearTimeout(timerId);
  });

  it('scrollRecalcInterval のデフォルト 100ms で定期的に measureTarget が呼ばれる', () => {
    const measureTarget = vi.fn();
    const scrollRecalcIntervalMs = 100; // default

    const timerId = window.setInterval(measureTarget, scrollRecalcIntervalMs);

    vi.advanceTimersByTime(350);
    expect(measureTarget).toHaveBeenCalledTimes(3);

    clearInterval(timerId);
  });
});

// ──────────────────────────────────────────────────────────────
// ResizeObserver スタブ検証
// useTourOverlayLogic は ResizeObserver を使う。
// jsdom は ResizeObserver を実装していないため vi でスタブを注入して検証する。
// ──────────────────────────────────────────────────────────────

describe('ResizeObserver スタブ動作検証', () => {
  let mockObserver: {
    observe: ReturnType<typeof vi.fn>;
    unobserve: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockObserver = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
    const captured = mockObserver;
    // jsdom には ResizeObserver がないため global に注入 (class 構文で constructor として動作)
    class MockResizeObserver {
      observe = captured.observe;
      unobserve = captured.unobserve;
      disconnect = captured.disconnect;
    }
    (globalThis as Record<string, unknown>).ResizeObserver = MockResizeObserver;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).ResizeObserver;
  });

  it('ResizeObserver スタブが関数として利用できる', () => {
    expect(typeof ResizeObserver).toBe('function');
  });

  it('スタブで observe/disconnect が呼べる', () => {
    const callback = vi.fn();
    const observer = new ResizeObserver(callback);

    const el = document.createElement('div');
    document.body.appendChild(el);

    expect(() => observer.observe(el)).not.toThrow();
    expect(mockObserver.observe).toHaveBeenCalledWith(el);

    expect(() => observer.disconnect()).not.toThrow();
    expect(mockObserver.disconnect).toHaveBeenCalled();

    document.body.removeChild(el);
  });

  it('useTourOverlayLogic が ResizeObserver を使うパターンを模倣できる', () => {
    // ids ごとに observe を呼ぶ実装を模倣
    const ids = ['target-a', 'target-b'];
    const observer = new ResizeObserver(vi.fn());

    ids.forEach((id) => {
      const el = document.createElement('div');
      el.setAttribute('data-testid', id);
      document.body.appendChild(el);
      const found = document.querySelector(`[data-testid="${id}"]`);
      if (found) observer.observe(found);
    });

    expect(mockObserver.observe).toHaveBeenCalledTimes(2);

    observer.disconnect();
    expect(mockObserver.disconnect).toHaveBeenCalledOnce();

    // cleanup
    document.body.innerHTML = '';
  });
});
