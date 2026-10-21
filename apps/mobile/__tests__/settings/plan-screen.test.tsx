/**
 * plan-screen.test.tsx
 * 購入の画面「プランとお支払い」(apps/mobile/app/settings/plan.tsx。billing/03 §10.6) のテスト (テスト 54・55・56)。
 *
 * 通信は getApi() (../../src/lib/api) を差し替え、本物の billing-api.ts (要約・カタログの読み取りと失敗の文) と
 * iap-catalog.ts (カタログ × ストアの突き合わせ・無料体験の文) を通す。ストア (RevenueCat) は ../../src/lib/purchases を差し替える
 * (本物のストアを呼ばない)。
 */

import React from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// ---- Mocks ----

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost }),
}));

const mockIsPurchasesAvailable = jest.fn();
const mockIdentifyPurchases = jest.fn();
const mockFetchOfferings = jest.fn();
const mockFetchTrialEligibility = jest.fn();
const mockPurchase = jest.fn();
const mockRestore = jest.fn();
const mockCurrentCustomerInfo = jest.fn();
jest.mock('../../src/lib/purchases', () => ({
  isPurchasesAvailable: (...args: unknown[]) => mockIsPurchasesAvailable(...args),
  identifyPurchases: (...args: unknown[]) => mockIdentifyPurchases(...args),
  fetchOfferings: (...args: unknown[]) => mockFetchOfferings(...args),
  fetchTrialEligibility: (...args: unknown[]) => mockFetchTrialEligibility(...args),
  purchase: (...args: unknown[]) => mockPurchase(...args),
  restore: (...args: unknown[]) => mockRestore(...args),
  currentCustomerInfo: (...args: unknown[]) => mockCurrentCustomerInfo(...args),
}));

jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'uid-plan' } }),
}));
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

import { STORE_SUBSCRIPTION_MANAGEMENT_URL } from '@homegohan/shared';

import PlanSettingsScreen, {
  PLAN_PURCHASE_COMPLETED_MESSAGE,
  PLAN_RESTORE_NOTHING_MESSAGE,
  PLAN_STRIPE_SOURCE_TEXT,
} from '../../app/settings/plan';
import { BILLING_PURCHASE_FAILED_MESSAGE, BILLING_SUMMARY_LOAD_FAILED_MESSAGE } from '../../src/lib/billing-api';
import { getPrivacyUrl, getTermsUrl, webPageUrl } from '../../src/lib/siteConfig';

const UNFINISHED_WORDS = ['準備中', '販売開始前', '近日', '予定', 'まだ', '確定次第', 'これから'] as const;

// ---- 応答の材料 ----

type Summary = Record<string, unknown>;

const FREE_SUMMARY: Summary = {
  plan_key: 'free',
  effective_plan_key: 'free',
  status: null,
  source: null,
  manage_in_store: null,
  billing_interval: null,
  current_period_end: null,
  trial_ends_at: null,
  cancel_at_period_end: false,
  cancel_at: null,
  has_customer: false,
  can_purchase: true,
  can_cancel: false,
  can_resume: false,
  features: { ai_daily_limit: 3, ai_feature_caps: { menu_generation_ultimate: 0 } },
};

function liveSummary(source: 'stripe' | 'manual' | 'app_store' | 'play_store', overrides: Summary = {}): Summary {
  return {
    ...FREE_SUMMARY,
    plan_key: 'pro',
    effective_plan_key: 'pro',
    status: 'active',
    source,
    manage_in_store: source === 'app_store' || source === 'play_store' ? source : null,
    billing_interval: 'month',
    current_period_end: '2026-11-21T00:00:00.000Z',
    can_purchase: false,
    features: { ai_daily_limit: 30, ai_feature_caps: { menu_generation_ultimate: 2 } },
    ...overrides,
  };
}

const CATALOG = {
  store: 'app_store',
  plans: [
    {
      plan_key: 'pro',
      display_name: '個人 Pro',
      max_members: null,
      products: [
        { billing_interval: 'month', product_id: 'pro_month' },
        { billing_interval: 'year', product_id: 'pro_year' },
      ],
    },
    {
      plan_key: 'family_basic',
      display_name: '家族 Basic',
      max_members: 4,
      products: [{ billing_interval: 'month', product_id: 'family_basic_month' }],
    },
  ],
};

const FREE_WEEK = { price: 0, periodUnit: 'WEEK', periodNumberOfUnits: 1, cycles: 1 };
const PACKAGES = [
  { identifier: '$rc_monthly', product: { identifier: 'pro_month', priceString: '¥580', introPrice: FREE_WEEK } },
  { identifier: '$rc_annual', product: { identifier: 'pro_year', priceString: '¥5,800', introPrice: FREE_WEEK } },
  { identifier: 'family_basic_monthly', product: { identifier: 'family_basic_month', priceString: '¥980', introPrice: null } },
];

let summaryResponse: unknown;
let catalogResponse: unknown;
let appStateHandler: ((state: string) => void) | null = null;
let openUrlSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  summaryResponse = { data: FREE_SUMMARY };
  catalogResponse = { data: CATALOG };
  mockGet.mockImplementation(async (path: string) => {
    if (path === '/api/billing/subscription') {
      if (summaryResponse instanceof Error) throw summaryResponse;
      return summaryResponse;
    }
    if (path.startsWith('/api/billing/iap/catalog')) return catalogResponse;
    throw new Error(`unexpected GET ${path}`);
  });
  // 画面を開いたときの同期は、既定では失敗させる (読んだ要約で描く)
  mockPost.mockRejectedValue(new Error('HTTP 503 Service Unavailable: {}'));
  mockIsPurchasesAvailable.mockReturnValue(true);
  mockIdentifyPurchases.mockResolvedValue(undefined);
  mockFetchOfferings.mockResolvedValue({ current: { availablePackages: PACKAGES } });
  mockFetchTrialEligibility.mockResolvedValue({ pro_month: 'eligible', pro_year: 'ineligible' });
  mockPurchase.mockResolvedValue({ ok: false, cancelled: true });
  mockRestore.mockResolvedValue({});
  mockCurrentCustomerInfo.mockResolvedValue({ managementURL: null });
  openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  appStateHandler = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: (state: string) => void) => {
    appStateHandler = handler;
    return { remove: jest.fn() };
  }) as unknown as typeof AppState.addEventListener);
  jest.replaceProperty(Platform, 'OS', 'ios');
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** 描いた木の文字を全部集める (ボタンの文も含む) */
function renderedTexts(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) renderedTexts(child, out);
    return out;
  }
  if (typeof node === 'object' && 'children' in (node as Record<string, unknown>)) {
    renderedTexts((node as { children: unknown }).children, out);
  }
  return out;
}

async function renderScreen() {
  const api = render(<PlanSettingsScreen />);
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/billing/subscription'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return api;
}

describe('プランとお支払いの画面 (billing/03 §10.6)', () => {
  it('plan screen shows the current plan from the summary, hides purchase cards when a live contract exists, shows Web / store wording by source, and always shows 購入を復元 and the legal links', async () => {
    // 無料プラン: 状態の文とプランの一覧
    let api = await renderScreen();
    expect(api.getByText('無料プランをご利用中です')).toBeTruthy();
    expect(api.getByTestId('plan-card-pro')).toBeTruthy();
    expect(mockIdentifyPurchases).toHaveBeenCalledWith('uid-plan');
    expect(mockGet).toHaveBeenCalledWith('/api/billing/iap/catalog?store=app_store');
    api.unmount();

    // ストア (App Store) の live な契約: プランの一覧を出さず、ストアの文と購読の管理のボタン
    summaryResponse = { data: liveSummary('app_store', { cancel_at_period_end: true, cancel_at: '2026-11-21T00:00:00.000Z' }) };
    api = await renderScreen();
    expect(api.getByText('個人 Proをご利用中です')).toBeTruthy();
    expect(api.getByText('ご利用中')).toBeTruthy();
    expect(api.getByText('2026年11月21日に解約されます')).toBeTruthy();
    expect(api.queryByTestId('plan-card-pro')).toBeNull();
    expect(api.getByText('App Store でお申し込みのプランです。')).toBeTruthy();
    expect(api.queryByText(PLAN_STRIPE_SOURCE_TEXT)).toBeNull();
    // 管理の URL が無ければストアの購読の管理のページ
    await act(async () => {
      fireEvent.press(api.getByTestId('plan-manage-store'));
    });
    expect(openUrlSpy).toHaveBeenLastCalledWith(STORE_SUBSCRIPTION_MANAGEMENT_URL.app_store);
    // RevenueCat が管理の URL を返せばそれを開く
    mockCurrentCustomerInfo.mockResolvedValueOnce({ managementURL: 'https://apps.apple.com/account/subscriptions?x=1' });
    await act(async () => {
      fireEvent.press(api.getByTestId('plan-manage-store'));
    });
    expect(openUrlSpy).toHaveBeenLastCalledWith('https://apps.apple.com/account/subscriptions?x=1');
    api.unmount();

    // Google Play の live な契約
    summaryResponse = { data: liveSummary('play_store') };
    api = await renderScreen();
    expect(api.getByText('Google Play でお申し込みのプランです。')).toBeTruthy();
    api.unmount();

    // Web (Stripe) の live な契約: Web の文 (リンクは無い)。購読の管理のボタンは出さない
    summaryResponse = { data: liveSummary('stripe', { status: 'trialing', trial_ends_at: '2026-10-28T00:00:00.000Z' }) };
    api = await renderScreen();
    expect(api.getByText(PLAN_STRIPE_SOURCE_TEXT)).toBeTruthy();
    expect(api.getByText('無料期間中（2026年10月28日まで）')).toBeTruthy();
    expect(api.queryByTestId('plan-manage-store')).toBeNull();
    expect(api.queryByTestId('plan-card-pro')).toBeNull();
    api.unmount();

    // 手動の付与: 出どころの文なし
    summaryResponse = { data: liveSummary('manual') };
    api = await renderScreen();
    expect(api.queryByTestId('plan-source-stripe')).toBeNull();
    expect(api.queryByTestId('plan-source-store')).toBeNull();
    api.unmount();

    // 家族・組織のプラン (自分の契約は無い)
    summaryResponse = { data: { ...FREE_SUMMARY, effective_plan_key: 'family_pro' } };
    api = await renderScreen();
    expect(api.getByText('家族 Proをご利用中です (ご家族または組織のプラン)')).toBeTruthy();
    api.unmount();

    // 要約を読めない: 失敗の文と再読み込み。状態とプランの一覧は出さず、復元と規約のリンクは出す
    summaryResponse = new Error('HTTP 500 Internal Server Error: {}');
    api = await renderScreen();
    expect(api.getByText(BILLING_SUMMARY_LOAD_FAILED_MESSAGE)).toBeTruthy();
    expect(api.queryByTestId('plan-current')).toBeNull();
    expect(api.queryByTestId('plan-card-pro')).toBeNull();
    expect(api.getByTestId('plan-restore')).toBeTruthy();
    expect(api.getByText('購入を復元')).toBeTruthy();
    for (const [testID, url] of [
      ['plan-terms', getTermsUrl()],
      ['plan-privacy', getPrivacyUrl()],
      ['plan-legal', webPageUrl('/legal')],
    ] as const) {
      fireEvent.press(api.getByTestId(testID));
      expect(openUrlSpy).toHaveBeenLastCalledWith(url);
    }
    expect(api.getByText('利用規約')).toBeTruthy();
    expect(api.getByText('プライバシーポリシー')).toBeTruthy();
    expect(api.getByText('特定商取引法に基づく表記')).toBeTruthy();
    // 再読み込みで読めれば描く
    summaryResponse = { data: FREE_SUMMARY };
    await act(async () => {
      fireEvent.press(api.getByTestId('plan-reload'));
    });
    await waitFor(() => expect(api.getByText('無料プランをご利用中です')).toBeTruthy());
    api.unmount();
  });

  it('plan screen purchases a package, then syncs and shows the updated summary; cancelled purchases show nothing; the trial wording appears only for options whose storeTrialOf is not null (an ineligible iOS user sees no trial wording)', async () => {
    const api = await renderScreen();

    // 体験の対象 (eligible) の月額だけに体験の文。年額 (ineligible) と体験の無い家族 Basic には出さない
    expect(api.getByTestId('plan-trial-pro-month')).toBeTruthy();
    expect(api.getByText('7 日間無料')).toBeTruthy();
    expect(api.getByText('体験の終了後は ¥580 が請求されます')).toBeTruthy();
    expect(api.queryByTestId('plan-trial-pro-year')).toBeNull();
    expect(api.queryByTestId('plan-trial-family_basic-month')).toBeNull();
    expect(api.getByText('7 日間の無料体験のあと、1 か月ごとに ¥580 が自動で更新されます。解約しない限り更新が続きます。')).toBeTruthy();
    expect(api.getByText('1 年ごとに ¥5,800 が自動で更新されます。解約しない限り更新が続きます。')).toBeTruthy();
    expect(api.getByText('4 人まで')).toBeTruthy();
    expect(api.getByText('個人 Proを月額で始める')).toBeTruthy();
    expect(api.getByText('個人 Proを年額で始める')).toBeTruthy();

    // 取り消し: 何も出さず、同期もしない
    const postsBefore = mockPost.mock.calls.length;
    await act(async () => {
      fireEvent.press(api.getByTestId('plan-buy-pro-month'));
    });
    expect(mockPurchase).toHaveBeenCalledWith(PACKAGES[0]);
    expect(api.queryByTestId('plan-notice')).toBeNull();
    expect(mockPost.mock.calls.length).toBe(postsBefore);

    // ストアの失敗: 汎用の文 (ストアの生の文は出さない)
    mockPurchase.mockResolvedValueOnce({ ok: false, cancelled: false, error: new Error('raw store error') });
    await act(async () => {
      fireEvent.press(api.getByTestId('plan-buy-pro-year'));
    });
    expect(mockPurchase).toHaveBeenLastCalledWith(PACKAGES[1]);
    expect(api.getByText(BILLING_PURCHASE_FAILED_MESSAGE)).toBeTruthy();
    expect(api.queryByText('raw store error')).toBeNull();

    // 同期が 409 BILL_IAP_SYNC_CONFLICT: サーバの固定の文
    mockPurchase.mockResolvedValueOnce({ ok: true, customerInfo: {} });
    mockPost.mockRejectedValueOnce(
      new Error(`HTTP 409 Conflict: ${JSON.stringify({ error: { code: 'BILL_IAP_SYNC_CONFLICT', message: 'サーバの固定の文' } })}`),
    );
    await act(async () => {
      fireEvent.press(api.getByTestId('plan-buy-pro-month'));
    });
    expect(api.getByText('サーバの固定の文')).toBeTruthy();

    // 購入 → 同期 → 要約を置き換え、完了の文。live になったのでプランの一覧は消える
    mockPurchase.mockResolvedValueOnce({ ok: true, customerInfo: {} });
    mockPost.mockResolvedValueOnce({ data: liveSummary('app_store') });
    await act(async () => {
      fireEvent.press(api.getByTestId('plan-buy-pro-month'));
    });
    expect(mockPost).toHaveBeenLastCalledWith('/api/billing/iap/sync');
    expect(api.getByText(PLAN_PURCHASE_COMPLETED_MESSAGE)).toBeTruthy();
    expect(api.getByText('個人 Proをご利用中です')).toBeTruthy();
    expect(api.queryByTestId('plan-card-pro')).toBeNull();
    api.unmount();

    // 体験の対象でない iOS の利用者 (判定の答えが無い・ineligible): 体験の文を出さない
    mockFetchTrialEligibility.mockResolvedValue({});
    const ineligible = await renderScreen();
    expect(ineligible.getByTestId('plan-card-pro')).toBeTruthy();
    expect(ineligible.queryByText(/無料体験/)).toBeNull();
    expect(ineligible.queryByText('7 日間無料')).toBeNull();
    ineligible.unmount();
  });

  it('復元は同期の結果で要約を置き換え、契約が無ければその旨を出す。アプリに戻ったときにも同期する', async () => {
    const api = await renderScreen();

    mockPost.mockResolvedValueOnce({ data: FREE_SUMMARY });
    await act(async () => {
      fireEvent.press(api.getByTestId('plan-restore'));
    });
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(api.getByText(PLAN_RESTORE_NOTHING_MESSAGE)).toBeTruthy();

    mockPost.mockResolvedValueOnce({ data: liveSummary('app_store') });
    await act(async () => {
      fireEvent.press(api.getByTestId('plan-restore'));
    });
    expect(api.queryByText(PLAN_RESTORE_NOTHING_MESSAGE)).toBeNull();
    expect(api.getByText('個人 Proをご利用中です')).toBeTruthy();

    // ストアの復元の失敗: 汎用の文
    mockRestore.mockRejectedValueOnce(new Error('raw store restore error'));
    await act(async () => {
      fireEvent.press(api.getByTestId('plan-restore'));
    });
    expect(api.getByText(BILLING_PURCHASE_FAILED_MESSAGE)).toBeTruthy();
    expect(api.queryByText('raw store restore error')).toBeNull();

    // アプリに戻ったとき (active) に同期し直す
    const posts = mockPost.mock.calls.length;
    mockPost.mockResolvedValueOnce({ data: FREE_SUMMARY });
    await act(async () => {
      appStateHandler?.('active');
    });
    expect(mockPost.mock.calls.length).toBe(posts + 1);
    expect(api.getByText('無料プランをご利用中です')).toBeTruthy();
    api.unmount();
  });

  it('plan screen shows no plan cards when the catalog is empty or purchases are unavailable, and no rendered text contains any of UNFINISHED_WORDS', async () => {
    const allTexts: string[] = [];

    // カタログが空
    catalogResponse = { data: { store: 'app_store', plans: [] } };
    let api = await renderScreen();
    expect(api.queryByTestId('plan-card-pro')).toBeNull();
    expect(api.getByText('無料プランをご利用中です')).toBeTruthy();
    allTexts.push(...renderedTexts(api.toJSON()));
    api.unmount();

    // offerings の読み込みの失敗
    catalogResponse = { data: CATALOG };
    mockFetchOfferings.mockRejectedValueOnce(new Error('offerings'));
    api = await renderScreen();
    expect(api.queryByTestId('plan-card-pro')).toBeNull();
    api.unmount();

    // このビルドでストアの購入を扱えない (キーが無い): 一覧を出さず、復元は押せない形で出す
    mockIsPurchasesAvailable.mockReturnValue(false);
    const offeringsCalls = mockFetchOfferings.mock.calls.length;
    api = await renderScreen();
    expect(api.queryByTestId('plan-card-pro')).toBeNull();
    // ストアに尋ねない
    expect(mockFetchOfferings.mock.calls.length).toBe(offeringsCalls);
    const restore = api.getByTestId('plan-restore');
    expect(restore.props.accessibilityState?.disabled ?? restore.props.disabled).toBe(true);
    fireEvent.press(restore);
    expect(mockRestore).not.toHaveBeenCalled();
    allTexts.push(...renderedTexts(api.toJSON()));
    api.unmount();

    // 一覧・体験・状態・失敗の文を出した画面の文も集める
    mockIsPurchasesAvailable.mockReturnValue(true);
    api = await renderScreen();
    allTexts.push(...renderedTexts(api.toJSON()));
    api.unmount();
    summaryResponse = { data: liveSummary('stripe', { cancel_at_period_end: true }) };
    api = await renderScreen();
    allTexts.push(...renderedTexts(api.toJSON()));
    api.unmount();
    summaryResponse = new Error('HTTP 500 Internal Server Error: {}');
    api = await renderScreen();
    allTexts.push(...renderedTexts(api.toJSON()));
    api.unmount();

    expect(allTexts.length).toBeGreaterThan(0);
    expect(allTexts.join('\n')).toContain('購入を復元');
    for (const text of allTexts) {
      for (const word of UNFINISHED_WORDS) expect(text).not.toContain(word);
    }
  });
});
