/**
 * #1102 (旧 #1212) 価格変更画面 (/super-admin/plans/[id]/price-change) のテスト
 *
 * オーナー判断 (2026-10-08): 価格変更は新規契約だけに適用する。
 * 従来は適用範囲 (新規契約のみ / 次回更新時から全契約 / 即時に全契約) を選べたが、既存契約へ新価格を反映する処理は
 * 無く (選んでも請求額は変わらない)、偽の選択肢だったため、画面から外した。
 *   - 適用範囲の選択欄 (select) は無い。「新規契約のみ」を固定の説明として表示する
 *   - 影響シミュレーションの結果は常に「既存契約への影響なし」。影響契約数・MRR 変化・未実装 (#1102) の注記は出さない
 *   - 価格変更 API へは、変えた方の金額だけを送る (月額・年額を両方変えたら両方を 1 回のリクエストで送る)。applies_to は new_only
 * また、入力 (新月額) を変えたら古いシミュレーション結果を捨てて再実行を必須にする (#1212)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'plan-1' }),
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: PriceChangePage } = await import('@/app/super-admin/plans/[id]/price-change/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 現行月額 1,500 円・年額 15,000 円のプラン */
const PLAN = {
  id: 'plan-1',
  plan_key: 'pro',
  display_name: 'Pro',
  monthly_price_jpy: 1500,
  yearly_price_jpy: 15000,
  status: 'public',
};

/** 値上げ後の価格 (桁区切りが出ない小さい値にして locale 差を避ける) */
const NEW_MONTHLY_PRICE = '1600';
const NEW_YEARLY_PRICE = '16000';

/** route.ts (price-impact) の返却内容を再現したレスポンス。新規契約のみなので、既存契約への影響は常に 0 */
function impactResponse() {
  return {
    data: {
      affected_subscription_count: 0,
      affected_mrr_change_jpy: 0,
      current_monthly_price_jpy: 1500,
      new_monthly_price_jpy: Number(NEW_MONTHLY_PRICE),
      applies_to: 'new_only',
      effective_timing: 'none',
      affected_user_sample: [],
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
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

/** index 0 = 新しい月額 / 1 = 新しい年額 */
function numberInput(index: number): HTMLInputElement {
  return container.querySelectorAll('input[type="number"]')[index] as HTMLInputElement;
}

async function setNumberInput(index: number, value: string) {
  const input = numberInput(index);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const setMonthlyPrice = (value: string) => setNumberInput(0, value);
const setYearlyPrice = (value: string) => setNumberInput(1, value);

async function setReason(value: string) {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement | undefined) {
  expect(button, 'クリック対象のボタンが見つからない').toBeDefined();
  await act(async () => {
    button!.click();
  });
}

/** 新月額を入力し、影響シミュレーションを実行する */
async function simulateMonthly() {
  await setMonthlyPrice(NEW_MONTHLY_PRICE);
  await click(findButton('影響をシミュレーション'));
}

/** price-change (POST) へ送られた JSON ボディ */
function priceChangePostBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    (c) => String(c[0]).includes('/price-change') && (c[1] as RequestInit | undefined)?.method === 'POST',
  );
  expect(call, 'price-change への POST が呼ばれていない').toBeDefined();
  return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
}

beforeEach(async () => {
  pushMock.mockClear();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/price-impact')) return jsonResponse(impactResponse());
    if (url.includes('/price-change') && init?.method === 'POST') return jsonResponse({ data: { plan_id: 'plan-1' } });
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

describe('価格変更画面: 適用範囲は新規契約のみ (#1102)', () => {
  it('適用範囲の選択欄 (select) が無く、「新規契約のみ」を固定の説明として表示する', () => {
    expect(container.querySelector('select')).toBeNull();
    expect(text()).toContain('適用範囲: 新規契約のみ');
    expect(text()).toContain('既存の契約者の請求額は変わりません');
  });

  it('従来の選択肢 (次回更新時から全契約 / 即時に全契約) や未実装の注記は、どこにも出ない', async () => {
    await simulateMonthly();
    await click(findButton('確認ステップへ'));

    for (const gone of ['次回更新時', '即時', '日割り', '未実装', '全アクティブ契約']) {
      expect(text(), `「${gone}」が残っている`).not.toContain(gone);
    }
  });
});

describe('価格変更画面: 影響シミュレーション結果の表示 (#1102)', () => {
  it('「既存契約への影響なし」を出し、影響契約数・MRR 変化・反映タイミングは出さない', async () => {
    await simulateMonthly();

    expect(text()).toContain('影響シミュレーション結果');
    expect(text()).toContain('既存契約への影響なし');
    expect(text()).toContain('新しい価格は新規契約にのみ適用されます');
    expect(text()).toContain('適用範囲: 新規契約のみ');
    expect(text()).not.toContain('影響契約数');
    expect(text()).not.toContain('MRR 変化');
    expect(text()).not.toContain('反映タイミング');
  });

  it('price-impact API には新月額だけを渡し、applies_to は渡さない (API は新規契約のみ固定)', async () => {
    await simulateMonthly();

    const impactCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/price-impact'));
    expect(impactCalls).toHaveLength(1);
    const params = new URL(impactCalls[0]!, 'http://localhost').searchParams;
    expect(params.get('new_monthly_price_jpy')).toBe(NEW_MONTHLY_PRICE);
    expect(params.has('applies_to')).toBe(false);
  });

  it('年額だけ変えた場合もシミュレーションでき、「確認ステップへ」に進める', async () => {
    await setYearlyPrice(NEW_YEARLY_PRICE);
    await click(findButton('影響をシミュレーション'));

    expect(text()).toContain('既存契約への影響なし');
    expect(findButton('確認ステップへ')).toBeDefined();
  });

  it('何も変えていない状態では、シミュレーションのボタンが押せない', () => {
    expect(findButton('影響をシミュレーション')!.disabled).toBe(true);
    expect(text()).toContain('変更がありません');
  });

  it('シミュレーションに失敗したら API のエラー message を表示し、確認ステップへ進めない', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/price-impact')) return jsonResponse({ error: { message: 'プランが見つかりません' } }, 404);
      return jsonResponse({ data: PLAN });
    });

    await simulateMonthly();

    expect(text()).toContain('プランが見つかりません');
    expect(findButton('確認ステップへ')).toBeUndefined();
  });
});

describe('価格変更画面: 確認ステップの表示 (#1102)', () => {
  it('「適用範囲: 新規契約のみ」「既存契約への影響: なし」を出し、影響契約数・MRR 変化は出さない', async () => {
    await simulateMonthly();
    await click(findButton('確認ステップへ'));

    expect(text()).toContain('価格変更の確認');
    expect(text()).toContain('適用範囲:新規契約のみ');
    expect(text()).toContain('既存契約への影響:なし');
    expect(text()).toContain('既存の契約者は現行価格のまま');
    expect(text()).not.toContain('影響契約数');
    expect(text()).not.toContain('MRR 変化');
  });

  it('月額・年額の両方を変えたら、確認ステップに両方の旧 → 新が出る', async () => {
    await setMonthlyPrice(NEW_MONTHLY_PRICE);
    await setYearlyPrice(NEW_YEARLY_PRICE);
    await click(findButton('影響をシミュレーション'));
    await click(findButton('確認ステップへ'));

    expect(text()).toContain('旧月額 → 新月額:¥1,500 → ¥1,600');
    expect(text()).toContain('旧年額 → 新年額:¥15,000 → ¥16,000');
  });

  it('年額だけ変えたら、月額は「変更なし」、年額は旧 → 新が出る', async () => {
    await setYearlyPrice(NEW_YEARLY_PRICE);
    await click(findButton('影響をシミュレーション'));
    await click(findButton('確認ステップへ'));

    expect(text()).toContain('変更なし (¥1,500)');
    expect(text()).toContain('旧年額 → 新年額:¥15,000 → ¥16,000');
  });
});

describe('価格変更画面: 価格変更 API へ送る内容 (#1102)', () => {
  /** 価格を変えてシミュレーション → 確認ステップへ進み、理由を入れて実行する */
  async function runChange(prices: { monthly?: string; yearly?: string }) {
    if (prices.monthly !== undefined) await setMonthlyPrice(prices.monthly);
    if (prices.yearly !== undefined) await setYearlyPrice(prices.yearly);
    await click(findButton('影響をシミュレーション'));
    await click(findButton('確認ステップへ'));
    await setReason('物価上昇に伴う改定');
    await click(findButton('価格変更を実行する'));
  }

  it('月額だけ変えたら、年額は null (変えていない方は送らない) で、applies_to は new_only', async () => {
    await runChange({ monthly: NEW_MONTHLY_PRICE });

    const body = priceChangePostBody();
    expect(body).toMatchObject({
      new_monthly_price_jpy: 1600,
      new_yearly_price_jpy: null,
      applies_to: 'new_only',
      reason: '物価上昇に伴う改定',
    });
    expect(Number.isNaN(Date.parse(body.effective_at as string))).toBe(false);
    expect(pushMock).toHaveBeenCalledWith('/super-admin/plans/plan-1?tab=history');
  });

  it('年額だけ変えたら、月額は null で送る', async () => {
    await runChange({ yearly: NEW_YEARLY_PRICE });

    expect(priceChangePostBody()).toMatchObject({
      new_monthly_price_jpy: null,
      new_yearly_price_jpy: 16000,
      applies_to: 'new_only',
    });
  });

  it('月額・年額の両方を変えたら、1 回のリクエストで両方を送る (従来は Stripe 同期が必須だと拒否されていた)', async () => {
    await runChange({ monthly: NEW_MONTHLY_PRICE, yearly: NEW_YEARLY_PRICE });

    const posts = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes('/price-change') && (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
    expect(priceChangePostBody()).toMatchObject({
      new_monthly_price_jpy: 1600,
      new_yearly_price_jpy: 16000,
      applies_to: 'new_only',
    });
  });

  it('API がエラーを返したら message を表示し、一覧へは遷移しない', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/price-impact')) return jsonResponse(impactResponse());
      if (url.includes('/price-change') && init?.method === 'POST') {
        return jsonResponse({ error: { code: 'OP_STRIPE_SYNC_FAILED', message: 'Stripe との価格同期に失敗しました' } }, 502);
      }
      return jsonResponse({ data: PLAN });
    });

    await runChange({ monthly: NEW_MONTHLY_PRICE });

    expect(text()).toContain('Stripe との価格同期に失敗しました');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('変更理由が空のあいだは、実行のボタンが押せない', async () => {
    await setMonthlyPrice(NEW_MONTHLY_PRICE);
    await click(findButton('影響をシミュレーション'));
    await click(findButton('確認ステップへ'));

    expect(findButton('価格変更を実行する')!.disabled).toBe(true);
    const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(posts).toHaveLength(0);
  });
});

describe('価格変更画面: 入力を変えたら古いシミュレーション結果を捨てる (#1212)', () => {
  it('新しい月額を変えると結果と「確認ステップへ」が消え、再シミュレーションが必要になる', async () => {
    await simulateMonthly();
    expect(findButton('確認ステップへ')).toBeDefined();

    await setMonthlyPrice('1700');

    expect(text()).not.toContain('影響シミュレーション結果');
    expect(findButton('確認ステップへ')).toBeUndefined();

    // 再シミュレーションすると、また結果が出る
    await click(findButton('影響をシミュレーション'));
    expect(text()).toContain('既存契約への影響なし');
    expect(findButton('確認ステップへ')).toBeDefined();
  });

  it('シミュレーション中は新しい月額を固定する (入力を変えた後に古い結果が届いて表示されるのを防ぐ)', async () => {
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
    const monthlyInput = numberInput(0);

    await setMonthlyPrice(NEW_MONTHLY_PRICE);
    await click(findButton('影響をシミュレーション'));

    // 応答待ちの間は変更できない
    expect(monthlyInput.disabled).toBe(true);

    await act(async () => {
      respondImpact(jsonResponse(impactResponse()));
    });

    // 応答後は再び変更でき、結果が表示される
    expect(monthlyInput.disabled).toBe(false);
    expect(text()).toContain('既存契約への影響なし');
  });
});
