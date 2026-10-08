/**
 * #1212 価格変更画面 (/super-admin/plans/[id]/price-change) の影響シミュレーション表示テスト
 *
 * 従来は applies_to に関わらず「影響契約数 / MRR 変化」を同じ見た目で出していたため、
 * 新規契約のみ (new_only) でも既存契約者全員への即時の収益影響に見えていた。
 * 修正後は適用範囲ごとに表示を切り替える。
 *   - new_only    : 「既存契約への影響なし」を出し、影響契約数・MRR 変化は出さない
 *   - on_renewal  : 影響契約数・MRR 変化 + 反映タイミング (次回更新時) + 未実装 (#1102) の注記
 *   - immediately : 影響契約数・MRR 変化 + 反映タイミング (即時) + 未実装 (#1102) の注記
 * また、入力 (適用範囲・新月額) を変えたら古いシミュレーション結果を捨てて再実行を必須にする
 * (確認ステップで「選択中の適用範囲」と「別の適用範囲で計算した数値」が並ばないようにする)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'plan-1' }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: PriceChangePage } = await import('@/app/super-admin/plans/[id]/price-change/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 現行月額 1,500 円のプラン */
const PLAN = {
  id: 'plan-1',
  plan_key: 'pro',
  display_name: 'Pro',
  monthly_price_jpy: 1500,
  yearly_price_jpy: 15000,
  status: 'public',
};

/** 既存契約者 3 人 / 値上げ 100 円 (桁区切りが出ない小さい値にして locale 差を避ける) */
const EXISTING_SUBSCRIBERS = 3;
const NEW_MONTHLY_PRICE = '1600';

/** route.ts の applies_to 別の返却内容を再現したレスポンス */
function impactResponse(appliesTo: string) {
  const timing = { new_only: 'none', on_renewal: 'next_renewal', immediately: 'immediate' }[appliesTo] ?? 'none';
  const count = appliesTo === 'new_only' ? 0 : EXISTING_SUBSCRIBERS;
  return {
    data: {
      affected_subscription_count: count,
      affected_mrr_change_jpy: 100 * count,
      current_monthly_price_jpy: 1500,
      new_monthly_price_jpy: Number(NEW_MONTHLY_PRICE),
      applies_to: appliesTo,
      effective_timing: timing,
      affected_user_sample: [],
    },
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

async function renderPage() {
  await act(async () => {
    root.render(<PriceChangePage />);
  });
}

function text() {
  return container.textContent ?? '';
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
}

async function setMonthlyPrice(value: string) {
  const input = container.querySelector('input[type="number"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function selectAppliesTo(value: string) {
  const select = container.querySelector('select') as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement | undefined) {
  expect(button, 'クリック対象のボタンが見つからない').toBeDefined();
  await act(async () => {
    button!.click();
  });
}

/** 新月額を入力し、指定の適用範囲でシミュレーションを実行する */
async function simulate(appliesTo: string) {
  await selectAppliesTo(appliesTo);
  await setMonthlyPrice(NEW_MONTHLY_PRICE);
  await click(findButton('影響をシミュレーション'));
}

beforeEach(async () => {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/price-impact')) {
      const appliesTo = new URL(url, 'http://localhost').searchParams.get('applies_to') ?? 'new_only';
      return jsonResponse(impactResponse(appliesTo));
    }
    return jsonResponse({ data: PLAN });
  });
  vi.stubGlobal('fetch', fetchMock);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await renderPage();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('価格変更画面: 影響シミュレーション結果の表示 (#1212)', () => {
  it('new_only: 「既存契約への影響なし」を出し、影響契約数・MRR 変化・未実装の注記は出さない', async () => {
    await simulate('new_only');

    expect(text()).toContain('影響シミュレーション結果');
    expect(text()).toContain('既存契約への影響なし');
    expect(text()).toContain('適用範囲: 新規契約のみ');
    expect(text()).not.toContain('影響契約数');
    expect(text()).not.toContain('MRR 変化');
    expect(text()).not.toContain('未実装');
  });

  it('on_renewal: 影響契約数・MRR 変化に加えて、反映タイミング (次回更新時) と未実装 (#1102) の注記を出す', async () => {
    await simulate('on_renewal');

    expect(text()).not.toContain('既存契約への影響なし');
    expect(text()).toContain(`影響契約数: ${EXISTING_SUBSCRIBERS} 件`);
    expect(text()).toContain('MRR 変化: +¥300');
    expect(text()).toContain('反映タイミング: 各契約の次回更新時から');
    expect(text()).toContain('未実装です (#1102)');
    expect(text()).toContain('年額契約も月額の差額で計算しています');
  });

  it('immediately: 影響契約数・MRR 変化に加えて、反映タイミング (即時) と未実装 (#1102) の注記を出す', async () => {
    await simulate('immediately');

    expect(text()).not.toContain('既存契約への影響なし');
    expect(text()).toContain(`影響契約数: ${EXISTING_SUBSCRIBERS} 件`);
    expect(text()).toContain('MRR 変化: +¥300');
    expect(text()).toContain('反映タイミング: 即時');
    expect(text()).toContain('未実装です (#1102)');
  });

  it('API には選択中の適用範囲を applies_to として渡す', async () => {
    await simulate('on_renewal');

    const impactCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/price-impact'));
    expect(impactCalls).toHaveLength(1);
    const params = new URL(impactCalls[0]!, 'http://localhost').searchParams;
    expect(params.get('applies_to')).toBe('on_renewal');
    expect(params.get('new_monthly_price_jpy')).toBe(NEW_MONTHLY_PRICE);
  });
});

describe('価格変更画面: 確認ステップの表示 (#1212)', () => {
  it('new_only: 確認ステップでも「既存契約への影響: なし」を出し、影響契約数・MRR 変化は出さない', async () => {
    await simulate('new_only');
    await click(findButton('確認ステップへ'));

    expect(text()).toContain('価格変更の確認');
    expect(text()).toContain('適用範囲:新規契約のみ');
    expect(text()).toContain('既存契約への影響:なし');
    expect(text()).not.toContain('影響契約数');
    expect(text()).not.toContain('MRR 変化');
  });

  it('on_renewal: 確認ステップに影響契約数・MRR 変化・反映タイミング・未実装の注記を出す', async () => {
    await simulate('on_renewal');
    await click(findButton('確認ステップへ'));

    expect(text()).toContain('価格変更の確認');
    expect(text()).not.toContain('既存契約への影響:');
    expect(text()).toContain(`影響契約数:${EXISTING_SUBSCRIBERS} 件`);
    expect(text()).toContain('MRR 変化:+¥300');
    expect(text()).toContain('反映タイミング:各契約の次回更新時から');
    expect(text()).toContain('未実装です (#1102)');
  });
});

describe('価格変更画面: 入力を変えたら古いシミュレーション結果を捨てる (#1212)', () => {
  it('適用範囲を変えると結果と「確認ステップへ」が消え、再シミュレーションが必要になる', async () => {
    await simulate('immediately');
    expect(text()).toContain(`影響契約数: ${EXISTING_SUBSCRIBERS} 件`);
    expect(findButton('確認ステップへ')).toBeDefined();

    await selectAppliesTo('new_only');

    expect(text()).not.toContain('影響シミュレーション結果');
    expect(text()).not.toContain(`影響契約数`);
    expect(findButton('確認ステップへ')).toBeUndefined();

    // 再シミュレーションすると、今度は new_only の結果が出る
    await click(findButton('影響をシミュレーション'));
    expect(text()).toContain('既存契約への影響なし');
    expect(findButton('確認ステップへ')).toBeDefined();
  });

  it('新しい月額を変えると結果と「確認ステップへ」が消える', async () => {
    await simulate('on_renewal');
    expect(findButton('確認ステップへ')).toBeDefined();

    await setMonthlyPrice('1700');

    expect(text()).not.toContain('影響シミュレーション結果');
    expect(findButton('確認ステップへ')).toBeUndefined();
  });

  it('シミュレーション中は適用範囲と新しい月額を固定する (入力を変えた後に古い結果が届いて表示されるのを防ぐ)', async () => {
    // price-impact だけ、テスト側が好きなタイミングで応答できるようにする
    let respondImpact!: (response: unknown) => void;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/price-impact')) {
        return new Promise((resolve) => {
          respondImpact = resolve;
        });
      }
      return jsonResponse({ data: PLAN });
    });
    const select = container.querySelector('select') as HTMLSelectElement;
    const monthlyInput = container.querySelector('input[type="number"]') as HTMLInputElement;

    await selectAppliesTo('immediately');
    await setMonthlyPrice(NEW_MONTHLY_PRICE);
    await click(findButton('影響をシミュレーション'));

    // 応答待ちの間は変更できない
    expect(select.disabled).toBe(true);
    expect(monthlyInput.disabled).toBe(true);

    await act(async () => {
      respondImpact(jsonResponse(impactResponse('immediately')));
    });

    // 応答後は再び変更でき、結果が表示される
    expect(select.disabled).toBe(false);
    expect(monthlyInput.disabled).toBe(false);
    expect(text()).toContain(`影響契約数: ${EXISTING_SUBSCRIBERS} 件`);
  });
});
