// src/__tests__/app/account/billing-pages.test.ts
// billing/01 §10.2・§10.3 (#1701 段 C): 契約の管理 (/account/billing) と特定商取引法の最終確認 (/account/billing/checkout)。
//
// - /account/billing?checkout=cancelled は「お申し込みは完了していません」を出し、同期の API を呼ばない (S17)
// - アプリの WebView では表示だけ (Portal・解約・取り消し・購入のボタンを出さない。S14)
// - 確認画面はアプリの WebView では「この操作はアプリでは行えません」とだけ描き、購入の API を呼ばない (S14)
// - 状態の文は §10.3 の表のとおり (live 5 値 × 解約の予約の有無)
// - プランの名前は planDisplayName (@homegohan/shared。free は「無料プラン」) で出す (billing/03 §10.3)
// - App Store / Google Play の契約は Portal・解約・取り消しのボタンを出さず、ストアの定期購読の管理を案内する (billing/03 §10.3・テスト 87)
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (設定画面のテストと同じ)。

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { IAP_STORE_LABELS, PURCHASE_STORES, STORE_SUBSCRIPTION_MANAGEMENT_URL, planDisplayName } from '@homegohan/shared';
import { EMPTY_PLAN_FEATURES, type BillingSummary, type SubscriptionStatus } from '@/lib/billing/core';

const h = React.createElement;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  isNativeApp: false,
  searchParams: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => mocks.searchParams,
}));
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => mocks.isNativeApp }));

import AccountBillingPage from '@/app/(main)/account/billing/page';
import AccountBillingCheckoutPage from '@/app/(main)/account/billing/checkout/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | undefined;
const fetchMock = vi.fn();

/** 要約 (GET /api/billing/subscription の data)。既定は Stripe の契約が active */
function summaryOf(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    plan_key: 'pro',
    effective_plan_key: 'pro',
    status: 'active',
    source: 'stripe',
    billing_interval: 'month',
    current_period_end: '2026-11-20T15:30:00Z',
    trial_ends_at: null,
    cancel_at_period_end: false,
    cancel_at: null,
    has_customer: true,
    can_purchase: false,
    can_cancel: true,
    can_resume: false,
    manage_in_store: null,
    features: EMPTY_PLAN_FEATURES,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isNativeApp = false;
  mocks.searchParams = new URLSearchParams();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    const mounted = root;
    act(() => {
      mounted.unmount();
    });
    root = undefined;
  }
  container.remove();
  vi.unstubAllGlobals();
});

async function render(Page: () => React.ReactElement): Promise<void> {
  act(() => {
    root = createRoot(container);
  });
  await act(async () => {
    root!.render(h(Page));
  });
  // fetch の応答と state の反映を待つ
  await act(async () => {});
  await act(async () => {});
}

function calledPaths(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

function buttonTexts(): string[] {
  return Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
}

/** 状態の文 (billingStatusLines の行) */
function statusLines(): string[] {
  const box = container.querySelector('[data-testid="billing-status-lines"]');
  expect(box, '状態の文の枠が無い').not.toBeNull();
  return Array.from(box!.querySelectorAll('p')).map((p) => p.textContent ?? '');
}

describe('billing/01 §10.3 /account/billing', () => {
  it('/account/billing?checkout=cancelled shows お申し込みは完了していません and does not call /api/billing/checkout/sync', async () => {
    mocks.searchParams = new URLSearchParams({ checkout: 'cancelled' });
    fetchMock.mockImplementation(async () => jsonResponse({ data: summaryOf({ status: null, plan_key: 'free', effective_plan_key: 'free', source: null, billing_interval: null, current_period_end: null, has_customer: true, can_purchase: true, can_cancel: false }) }));

    await render(AccountBillingPage);

    expect(container.textContent).toContain('お申し込みは完了していません');
    expect(calledPaths()).toEqual(['/api/billing/subscription']);
    expect(calledPaths()).not.toContain('/api/billing/checkout/sync');
  });

  it('/account/billing in native app mode shows plan and status only: no Portal / cancel / resume / purchase buttons', async () => {
    mocks.isNativeApp = true;
    for (const summary of [
      summaryOf(),
      summaryOf({ cancel_at_period_end: true, cancel_at: '2026-11-20T15:30:00Z', can_cancel: false, can_resume: true }),
      summaryOf({ status: null, plan_key: 'free', effective_plan_key: 'free', source: null, can_purchase: true, can_cancel: false }),
    ]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => jsonResponse({ data: summary }));
      await render(AccountBillingPage);

      expect(container.querySelector('[data-testid="billing-plan"]')?.textContent).toBe(planDisplayName(summary.plan_key));
      expect(buttonTexts()).toEqual([]);
      const text = container.textContent ?? '';
      for (const word of ['お支払い方法・請求書 (Stripe)', '解約する', '解約を取り消す', 'プランを見る']) {
        expect(text, `アプリの中に「${word}」が出ている`).not.toContain(word);
      }
      expect(container.querySelector('a[href="/pricing"]')).toBeNull();
      expect(calledPaths()).toEqual(['/api/billing/subscription']);

      act(() => {
        root!.unmount();
      });
      root = undefined;
    }
  });

  it('/account/billing shows the §10.3 status lines for every live status with and without a scheduled cancellation: active shows ご利用中 and never お支払いに問題があります, paused shows 一時停止中, and a scheduled cancellation adds …に解約されます under the status line', async () => {
    // 日付は日本時間で切る: 2026-10-20T15:30:00Z = 日本時間 2026年10月21日、2026-11-20T15:30:00Z = 2026年11月21日
    const cases: { status: SubscriptionStatus; first: string }[] = [
      { status: 'trialing', first: '無料期間中（2026年10月21日まで）' },
      { status: 'active', first: 'ご利用中' },
      { status: 'past_due', first: 'お支払いに問題があります。お支払い方法をご確認ください' },
      { status: 'grace', first: 'お支払いが確認できないため一部の機能を制限しています' },
      { status: 'paused', first: '一時停止中' },
    ];
    for (const { status, first } of cases) {
      for (const scheduled of [false, true]) {
        fetchMock.mockReset();
        fetchMock.mockImplementation(async () =>
          jsonResponse({
            data: summaryOf({
              status,
              trial_ends_at: '2026-10-20T15:30:00Z',
              current_period_end: '2026-11-20T15:30:00Z',
              cancel_at_period_end: scheduled,
              cancel_at: scheduled ? '2026-11-20T15:30:00Z' : null,
              can_cancel: !scheduled,
              can_resume: scheduled,
            }),
          }),
        );
        await render(AccountBillingPage);

        const expected = scheduled ? [first, '2026年11月21日に解約されます'] : [first];
        expect(statusLines(), `${status} / 予約 ${scheduled}`).toEqual(expected);
        if (status === 'active') expect(container.textContent).not.toContain('お支払いに問題があります');
        // Web では、予約の有無で「解約する」と「解約を取り消す」を出し分ける
        expect(buttonTexts().includes('解約する')).toBe(!scheduled);
        expect(buttonTexts().includes('解約を取り消す')).toBe(scheduled);

        act(() => {
          root!.unmount();
        });
        root = undefined;
      }
    }
  });
  it('account billing page shows the store contract wording with the store management link and no cancel / resume / portal buttons for app_store and play_store rows', async () => {
    for (const store of PURCHASE_STORES) {
      for (const scheduled of [false, true]) {
        fetchMock.mockReset();
        // can_cancel / can_resume / has_customer を真にしても、manage_in_store があればボタンを出さないことを見る
        fetchMock.mockImplementation(async () =>
          jsonResponse({
            data: summaryOf({
              source: store,
              manage_in_store: store,
              has_customer: true,
              cancel_at_period_end: scheduled,
              cancel_at: scheduled ? '2026-11-20T15:30:00Z' : null,
              can_cancel: !scheduled,
              can_resume: scheduled,
            }),
          }),
        );
        await render(AccountBillingPage);

        const label = `${store} / 予約 ${scheduled}`;
        expect(container.querySelector('[data-testid="billing-plan"]')?.textContent, label).toBe('個人 Pro');
        expect(container.textContent, label).toContain(
          `${IAP_STORE_LABELS[store]} でご契約中です。解約・お支払い方法の変更は ${IAP_STORE_LABELS[store]} の定期購読の管理から行えます。`,
        );
        const manageLink = container.querySelector(`a[href="${STORE_SUBSCRIPTION_MANAGEMENT_URL[store]}"]`);
        expect(manageLink?.textContent, label).toBe('定期購読の管理を開く');
        expect(manageLink?.getAttribute('target'), label).toBe('_blank');
        expect(manageLink?.getAttribute('rel'), label).toBe('noopener');
        for (const word of ['お支払い方法・請求書 (Stripe)', '解約する', '解約を取り消す']) {
          expect(buttonTexts(), `${label}: 「${word}」が出ている`).not.toContain(word);
        }
        expect(calledPaths(), label).toEqual(['/api/billing/subscription']);

        act(() => {
          root!.unmount();
        });
        root = undefined;
      }
    }

    // アプリの WebView では文だけ (管理のページへのリンクも出さない)
    mocks.isNativeApp = true;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => jsonResponse({ data: summaryOf({ source: 'play_store', manage_in_store: 'play_store' }) }));
    await render(AccountBillingPage);
    expect(container.textContent).toContain(`${IAP_STORE_LABELS.play_store} でご契約中です。`);
    expect(container.querySelector('a[href^="https://"]')).toBeNull();
    expect(buttonTexts()).toEqual([]);
    act(() => {
      root!.unmount();
    });
    root = undefined;

    // Stripe の契約には出さない
    mocks.isNativeApp = false;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => jsonResponse({ data: summaryOf() }));
    await render(AccountBillingPage);
    expect(container.textContent).not.toContain('でご契約中です。');
    expect(buttonTexts()).toEqual(['お支払い方法・請求書 (Stripe)', '解約する']);
  });
});

describe('billing/01 §10.2 /account/billing/checkout', () => {
  it('/account/billing/checkout in native app mode renders この操作はアプリでは行えません only and never calls /api/billing/checkout', async () => {
    mocks.isNativeApp = true;
    mocks.searchParams = new URLSearchParams({ plan_key: 'pro', interval: 'month' });
    fetchMock.mockImplementation(async () => jsonResponse({ data: { url: 'https://checkout.stripe.test/x' } }));

    await render(AccountBillingCheckoutPage);

    expect(container.textContent).toBe('この操作はアプリでは行えません');
    expect(buttonTexts()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calledPaths().filter((p) => p.startsWith('/api/billing/checkout'))).toEqual([]);
  });
});
