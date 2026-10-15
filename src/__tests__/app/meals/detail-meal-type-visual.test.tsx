/**
 * #1665: 食事の詳細 (/meals/[id]) の区分の表示名と色は、区分の見た目の表 (MEAL_LABELS・MEAL_TYPE_RECORD_THEME) から引く。
 *
 * 以前この画面は朝・昼・夕の 3 値の表だけを持ち、DB の meal_type をキャストでその型にしていた。
 * おやつ・夜食の食事を開くと表に行が無く (undefined の icon を読もうとして) 描画が止まっていた。
 * 5 値すべてで表示名と色が出ること、朝・昼・夕は移す前と同じ色であること、5 値以外の値は元の値をそのまま名前にすることを、
 * 画面を実際に描画して確かめる。期待する名前と色は手で書く (表から求めない)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (challenges-expiry-jst.test.tsx と同じ)。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: MealDetailPage } = await import('@/app/(main)/meals/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEAL_ID = 'meal-1665';

/** 区分ごとに期待する表示名と色。朝・昼・夕は移す前の 3 値の表の色、おやつ・夜食は食事の追加 (/meals/new) の表の色 */
const CASES: ReadonlyArray<{ mealType: string; label: string; color: string }> = [
  { mealType: 'breakfast', label: '朝食', color: '#E5A84B' },
  { mealType: 'lunch', label: '昼食', color: '#E07A5F' },
  { mealType: 'dinner', label: '夕食', color: '#7C6BA0' },
  { mealType: 'snack', label: 'おやつ', color: '#6B9B6B' },
  { mealType: 'midnight_snack', label: '夜食', color: '#5B8BC7' },
  // 5 値以外は元の値をそのまま名前にし、控えめな色 (この画面の textMuted) で出す
  { mealType: 'brunch', label: 'brunch', color: '#A0A0A0' },
];

/** 食事の詳細の API の応答 (区分だけを変える) */
function mealResponse(mealType: string) {
  return {
    id: MEAL_ID,
    daily_meal_id: 'day-1',
    meal_type: mealType,
    mode: 'cook',
    dish_name: 'テストの料理',
    description: null,
    recipe_url: null,
    image_url: null,
    ingredients: null,
    calories_kcal: null,
    protein_g: null,
    fat_g: null,
    carbs_g: null,
    is_completed: false,
    completed_at: null,
    dishes: null,
    is_simple: false,
    cooking_time_minutes: null,
    user_daily_meals: { day_date: '2026-10-15' },
    source_type: null,
    catalog_product_id: null,
    generation_metadata: null,
  };
}

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
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
});

/** jsdom が style.color に入れた色を書き直す形 (hex → rgb など) にそろえて比べる */
function normalizedColor(color: string): string {
  const probe = document.createElement('span');
  probe.style.color = color;
  return probe.style.color;
}

async function renderWithMealType(mealType: string) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === `/api/meals/${MEAL_ID}`) return Response.json(mealResponse(mealType));
    // 人数の設定 (/api/profile) は無いものとして扱う
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(createElement(MealDetailPage, { params: Promise.resolve({ id: MEAL_ID }) }));
  });
  // 取得 (useEffect の fetch) の後の描画を待つ
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 料理名の上の行にある、区分の表示名の span */
function mealTypeLabelSpan(label: string): HTMLSpanElement | undefined {
  return Array.from(container.querySelectorAll<HTMLSpanElement>('span.text-xs.font-bold')).find(
    (span) => span.textContent === label,
  );
}

describe('食事の詳細: 区分の表示名と色は区分の見た目の表から引く (#1665)', () => {
  it.each(CASES)('$mealType の食事は「$label」を $color で出す (描画が止まらない)', async ({ mealType, label, color }) => {
    await renderWithMealType(mealType);
    expect(container.textContent).toContain('テストの料理');
    const span = mealTypeLabelSpan(label);
    expect(span, `${mealType} の表示名 ${label}`).toBeDefined();
    const expectedColor = normalizedColor(color);
    // 色を読めずに両方が空になって素通りしない
    expect(expectedColor).not.toBe('');
    expect(span!.style.color).toBe(expectedColor);
  });
});
