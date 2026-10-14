/**
 * #1127 プラン詳細画面 (/super-admin/plans/[id]) の「廃止する」操作が、API の止めた理由を運営者に見せるテスト
 *
 * 契約者がいるプランの廃止は API が 409 (OP_PLAN_HAS_SUBSCRIBERS) で止める。
 * 画面はその message (件数の内訳と次の手順が入っている) をそのまま表示し、
 * 廃止できなかったのにプランの表示だけが変わることがないようにする。
 *   - 409 (契約者あり)         : message を表示する。プランは再取得しない
 *   - 500 (契約者数を確認できず) : message を表示する。プランは再取得しない
 *   - 200 (契約者なし)         : 表示は出さず、プランを再取得して最新の状態にする
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/price-change-page-impact.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'plan-1' }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENDS_AT_INPUT = '2027-01-01';
const ENDS_AT_ISO = '2027-01-01T00:00:00.000Z';

/** 公開中のプラン (「廃止する」ボタンが出る状態) */
const PLAN = {
  id: 'plan-1',
  plan_key: 'pro',
  display_name: 'Pro',
  plan_type: 'personal',
  description: null,
  monthly_price_jpy: 1500,
  yearly_price_jpy: 15000,
  max_members: null,
  stripe_product_id: null,
  stripe_price_id: null,
  status: 'public',
  display_order: 0,
  trial_days: 0,
  feature_packages: [],
  price_history: [],
};

const HAS_SUBSCRIBERS_MESSAGE =
  '契約者がいるため、このプランは廃止できません (個人契約 2 件・組織 1 件)。' +
  '新しい申込だけを止めたいときは、「非公開にする」を使ってください。契約がすべて終了してから、もう一度廃止してください。';
const CHECK_FAILED_MESSAGE = '契約者数を確認できなかったため、廃止を中止しました。時間をおいて、もう一度お試しください。';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** GET (プラン取得) は常に公開中のプラン、PATCH (廃止) は引数の応答を返す */
function stubApi(patchResponse: ReturnType<typeof jsonResponse>) {
  fetchMock = vi.fn(async (_url: string, init?: { method?: string }) =>
    init?.method === 'PATCH' ? patchResponse : jsonResponse(200, { data: PLAN }),
  );
  vi.stubGlobal('fetch', fetchMock);
}

function planFetchCount() {
  return fetchMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === undefined).length;
}

function patchCalls() {
  return fetchMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH');
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
}

async function renderPage() {
  await act(async () => {
    root.render(<PlanDetailPage />);
  });
}

async function clickDeprecate() {
  const button = findButton('廃止する');
  expect(button, '「廃止する」ボタンが見つからない').toBeDefined();
  await act(async () => {
    button!.click();
  });
}

beforeEach(() => {
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'prompt').mockReturnValue(ENDS_AT_INPUT);
  vi.spyOn(window, 'confirm').mockReturnValue(true);

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
  vi.restoreAllMocks();
});

describe('プラン詳細画面: 契約者がいるプランの廃止 (#1127)', () => {
  it('409 (契約者あり): API の message をそのまま表示する。プランは再取得しない', async () => {
    stubApi(
      jsonResponse(409, {
        error: {
          code: 'OP_PLAN_HAS_SUBSCRIBERS',
          message: HAS_SUBSCRIBERS_MESSAGE,
          counts: { personal_subscriptions: 2, family_groups: 0, organizations: 1 },
        },
      }),
    );
    await renderPage();
    expect(planFetchCount()).toBe(1);

    await clickDeprecate();

    await vi.waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    expect(alertSpy).toHaveBeenCalledWith(HAS_SUBSCRIBERS_MESSAGE);
    // 廃止していないので、画面の状態を取り直さない (公開中のまま)
    expect(planFetchCount()).toBe(1);
    expect(container.textContent).toContain('公開中');
  });

  it('廃止の依頼には、入力した廃止予定日を ends_at として付けて status = deprecated を送る', async () => {
    stubApi(jsonResponse(409, { error: { code: 'OP_PLAN_HAS_SUBSCRIBERS', message: HAS_SUBSCRIBERS_MESSAGE } }));
    await renderPage();

    await clickDeprecate();

    await vi.waitFor(() => expect(patchCalls()).toHaveLength(1));
    const [url, init] = patchCalls()[0]! as [string, { body: string }];
    expect(url).toBe('/api/super-admin/plans/plan-1');
    expect(JSON.parse(init.body)).toEqual({ status: 'deprecated', ends_at: ENDS_AT_ISO });
  });

  it('500 (契約者数を確認できなかった): API の message を表示する。プランは再取得しない', async () => {
    stubApi(jsonResponse(500, { error: { code: 'OP_PLAN_SUBSCRIBER_CHECK_FAILED', message: CHECK_FAILED_MESSAGE } }));
    await renderPage();

    await clickDeprecate();

    await vi.waitFor(() => expect(alertSpy).toHaveBeenCalledWith(CHECK_FAILED_MESSAGE));
    expect(planFetchCount()).toBe(1);
  });

  it('200 (契約者なし): 失敗の表示は出さず、プランを再取得して最新の状態にする', async () => {
    stubApi(jsonResponse(200, { data: { ...PLAN, status: 'deprecated' } }));
    await renderPage();

    await clickDeprecate();

    await vi.waitFor(() => expect(planFetchCount()).toBe(2));
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('廃止予定日を入力しなかったときは、API を呼ばない', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    stubApi(jsonResponse(200, { data: PLAN }));
    await renderPage();

    await clickDeprecate();

    expect(patchCalls()).toHaveLength(0);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
