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
const mockEnsurePurchasesIdentity = jest.fn();
const mockFetchOfferings = jest.fn();
const mockFetchTrialEligibility = jest.fn();
const mockPurchase = jest.fn();
const mockRestore = jest.fn();
const mockCurrentCustomerInfo = jest.fn();
jest.mock('../../src/lib/purchases', () => ({
  isPurchasesAvailable: (...args: unknown[]) => mockIsPurchasesAvailable(...args),
  identifyPurchases: (...args: unknown[]) => mockIdentifyPurchases(...args),
  ensurePurchasesIdentity: (...args: unknown[]) => mockEnsurePurchasesIdentity(...args),
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

import { ORG_PLAN_DISPLAY_NAME, PAID_PLAN_GENERIC_DISPLAY_NAME, STORE_SUBSCRIPTION_MANAGEMENT_URL } from '@homegohan/shared';

import PlanSettingsScreen, {
  PLAN_GENERIC_STATUS_TEXT,
  PLAN_ORG_STATUS_TEXT,
  PLAN_PURCHASE_COMPLETED_MESSAGE,
  PLAN_PURCHASE_NOT_REFLECTED_MESSAGE,
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
  mockEnsurePurchasesIdentity.mockResolvedValue(undefined);
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

    // 家族のプラン (自分の契約は無い)。家族の文に「組織」は出さない (#1912)
    summaryResponse = { data: { ...FREE_SUMMARY, effective_plan_key: 'family_pro' } };
    api = await renderScreen();
    expect(api.getByText('家族 Proをご利用中です (ご家族のプラン)')).toBeTruthy();
    for (const text of renderedTexts(api.toJSON())) expect(text).not.toContain('組織');
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

  // #1912: 組織の利用者 (自分の契約も家族も無い) の effective_plan_key は organizations.plan の値 (standard / premium / enterprise) か
  // org_* になる。画面のどこにもその内部の値を出さず、固定の文 (組織のプラン) を出す
  it.each(['standard', 'premium', 'enterprise', 'org_standard', 'org_starter'])(
    'plan screen never shows the internal org plan_key %s and shows the fixed organization plan text instead',
    async (orgPlanKey) => {
      summaryResponse = { data: { ...FREE_SUMMARY, effective_plan_key: orgPlanKey } };
      const api = await renderScreen();
      expect(api.getByText(PLAN_ORG_STATUS_TEXT)).toBeTruthy();
      expect(PLAN_ORG_STATUS_TEXT).toBe(`${ORG_PLAN_DISPLAY_NAME}をご利用中です`);
      const texts = renderedTexts(api.toJSON());
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) expect(text).not.toContain(orgPlanKey);
      // 家族のプランの文 (「(ご家族のプラン)」) にはならない
      expect(api.queryByText(/ご家族/)).toBeNull();
      api.unmount();
    },
  );

  // #1912: PLAN_CATALOG にも組織のプランの値にも無い key (private の家族の追加枠 family_addon・運営が新しく作った個人や家族のプラン) は、
  // 「組織のプラン」と出さず、汎用の名前 (有料プラン) で出す。内部の値も出さない
  it.each(['family_addon', 'personal_lite', 'unknown_plan_value'])(
    'plan screen shows the generic paid plan text (never 組織 nor the internal value) when the effective plan_key %s is neither free, a PLAN_CATALOG key nor an organization plan value',
    async (planKey) => {
      summaryResponse = { data: { ...FREE_SUMMARY, effective_plan_key: planKey } };
      const api = await renderScreen();
      expect(api.getByText(PLAN_GENERIC_STATUS_TEXT)).toBeTruthy();
      expect(PLAN_GENERIC_STATUS_TEXT).toBe(`${PAID_PLAN_GENERIC_DISPLAY_NAME}をご利用中です`);
      expect(PAID_PLAN_GENERIC_DISPLAY_NAME).toBe('有料プラン');
      const texts = renderedTexts(api.toJSON());
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        expect(text).not.toContain(planKey);
        expect(text).not.toContain('組織');
      }
      expect(api.queryByText(PLAN_ORG_STATUS_TEXT)).toBeNull();
      api.unmount();
    },
  );

  // #1912: live な契約の plan_key が family_addon (PLAN_CATALOG に無い) でも、「組織のプラン」と出さず汎用の名前で出す
  it('plan screen shows the generic paid plan name for a live contract whose plan_key is family_addon, never 組織 nor the internal value', async () => {
    summaryResponse = { data: liveSummary('manual', { plan_key: 'family_addon', effective_plan_key: 'family_addon' }) };
    const api = await renderScreen();
    expect(api.getByText(PLAN_GENERIC_STATUS_TEXT)).toBeTruthy();
    const texts = renderedTexts(api.toJSON());
    for (const text of texts) {
      expect(text).not.toContain('family_addon');
      expect(text).not.toContain('組織');
    }
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
    // 購入の前に、SDK の利用者がログイン中の利用者であることを確かめている (#1912)
    expect(mockEnsurePurchasesIdentity).toHaveBeenLastCalledWith('uid-plan');
    const ensureOrder = mockEnsurePurchasesIdentity.mock.invocationCallOrder;
    const purchaseOrder = mockPurchase.mock.invocationCallOrder;
    expect(purchaseOrder.length).toBeGreaterThan(0);
    expect(ensureOrder.length).toBe(purchaseOrder.length);
    purchaseOrder.forEach((order, index) => expect(ensureOrder[index]).toBeLessThan(order));
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
  // #1912 P3: RevenueCat の利用者の結び付けが確かめられないうちは、カードを出さず、購入も復元もしない
  describe('ストアの購入の利用者の結び付け (#1912 P3)', () => {
    it('画面を開いたときの結び付けが失敗したらカードを読まず (カタログ・offerings を読まない)、前面復帰で結び付けられたらカードを出す', async () => {
      mockIdentifyPurchases.mockRejectedValue(new Error('logIn failed'));
      const api = await renderScreen();
      expect(mockIdentifyPurchases).toHaveBeenCalledWith('uid-plan');
      // 要約は出す (状態の文)。カードは出さない
      expect(api.getByText('無料プランをご利用中です')).toBeTruthy();
      expect(api.queryByTestId('plan-card-pro')).toBeNull();
      expect(mockGet).not.toHaveBeenCalledWith('/api/billing/iap/catalog?store=app_store');
      expect(mockFetchOfferings).not.toHaveBeenCalled();
      expect(mockFetchTrialEligibility).not.toHaveBeenCalled();

      // 前面復帰でもう一度失敗: まだ出さない
      await act(async () => {
        appStateHandler?.('active');
      });
      expect(api.queryByTestId('plan-card-pro')).toBeNull();
      expect(mockFetchOfferings).not.toHaveBeenCalled();

      // 前面復帰で結び付けられた: カードを出す
      mockIdentifyPurchases.mockResolvedValue(undefined);
      await act(async () => {
        appStateHandler?.('active');
      });
      await waitFor(() => expect(api.getByTestId('plan-card-pro')).toBeTruthy());
      expect(mockFetchOfferings).toHaveBeenCalledTimes(1);
      api.unmount();
    });

    it('購入の前の確かめ (ensurePurchasesIdentity) が投げたら購入を呼ばず、固定の文を出す (ストアの生の文は出さない)', async () => {
      const api = await renderScreen();
      const offeringsCalls = mockFetchOfferings.mock.calls.length;
      const postsBefore = mockPost.mock.calls.length;
      mockEnsurePurchasesIdentity.mockRejectedValueOnce(new Error('raw identity error'));
      await act(async () => {
        fireEvent.press(api.getByTestId('plan-buy-pro-month'));
      });
      expect(mockEnsurePurchasesIdentity).toHaveBeenCalledWith('uid-plan');
      expect(mockPurchase).not.toHaveBeenCalled();
      expect(mockFetchOfferings.mock.calls.length).toBe(offeringsCalls);
      expect(mockPost.mock.calls.length).toBe(postsBefore);
      expect(api.getByText(BILLING_PURCHASE_FAILED_MESSAGE)).toBeTruthy();
      expect(api.queryByText('raw identity error')).toBeNull();
      expect(api.queryByText(PLAN_PURCHASE_COMPLETED_MESSAGE)).toBeNull();
      // 押せる形に戻る (次の押下で確かめ直す)
      mockPurchase.mockResolvedValueOnce({ ok: true, customerInfo: {} });
      mockPost.mockResolvedValueOnce({ data: liveSummary('app_store') });
      await act(async () => {
        fireEvent.press(api.getByTestId('plan-buy-pro-month'));
      });
      expect(mockPurchase).toHaveBeenCalledTimes(1);
      expect(api.getByText(PLAN_PURCHASE_COMPLETED_MESSAGE)).toBeTruthy();
      api.unmount();
    });

    it('復元の前の確かめが投げたら復元を呼ばず、固定の文を出す', async () => {
      const api = await renderScreen();
      const postsBefore = mockPost.mock.calls.length;
      mockEnsurePurchasesIdentity.mockRejectedValueOnce(new Error('raw identity error'));
      await act(async () => {
        fireEvent.press(api.getByTestId('plan-restore'));
      });
      expect(mockEnsurePurchasesIdentity).toHaveBeenCalledWith('uid-plan');
      expect(mockRestore).not.toHaveBeenCalled();
      expect(mockPost.mock.calls.length).toBe(postsBefore);
      expect(api.getByText(BILLING_PURCHASE_FAILED_MESSAGE)).toBeTruthy();
      expect(api.queryByText('raw identity error')).toBeNull();
      api.unmount();
    });

    it.each([
      ['契約なし (status が null)', FREE_SUMMARY],
      ['終わった契約 (expired)', { ...FREE_SUMMARY, plan_key: 'pro', status: 'expired', source: 'app_store' }],
      ['終わった契約 (cancelled)', { ...FREE_SUMMARY, plan_key: 'pro', status: 'cancelled', source: 'app_store' }],
    ])('購入のあとの同期が %s を返したら、完了の文を出さず、購入の復元を案内する', async (_label, synced) => {
      const api = await renderScreen();
      mockPurchase.mockResolvedValueOnce({ ok: true, customerInfo: {} });
      mockPost.mockResolvedValueOnce({ data: synced });
      await act(async () => {
        fireEvent.press(api.getByTestId('plan-buy-pro-month'));
      });
      expect(mockPurchase).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenLastCalledWith('/api/billing/iap/sync');
      expect(api.queryByText(PLAN_PURCHASE_COMPLETED_MESSAGE)).toBeNull();
      expect(api.getByTestId('plan-notice').props.children).toBe(PLAN_PURCHASE_NOT_REFLECTED_MESSAGE);
      api.unmount();
    });

    it('復元のあとの同期が終わった契約 (expired) を返したら、復元できる購入が無かった旨を出す', async () => {
      const api = await renderScreen();
      mockPost.mockResolvedValueOnce({ data: { ...FREE_SUMMARY, plan_key: 'pro', status: 'expired', source: 'app_store' } });
      await act(async () => {
        fireEvent.press(api.getByTestId('plan-restore'));
      });
      expect(mockRestore).toHaveBeenCalledTimes(1);
      expect(api.getByText(PLAN_RESTORE_NOTHING_MESSAGE)).toBeTruthy();
      api.unmount();
    });
  });

  // #1912 P4: 要約の読み込みが失敗しても、並行の同期が要約を読めていれば、カードも出す
  describe('要約の読み込みの失敗と並行の同期 (#1912 P4)', () => {
    /** 外から決着をつけられる Promise */
    function deferred<T>() {
      let resolve: (value: T) => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('同期が先に要約を置き換え、そのあと要約の読み込みが失敗した: 失敗の表示にせず、カードを出す', async () => {
      const summaryLoad = deferred<unknown>();
      mockGet.mockImplementation(async (path: string) => {
        if (path === '/api/billing/subscription') return summaryLoad.promise;
        if (path.startsWith('/api/billing/iap/catalog')) return catalogResponse;
        throw new Error(`unexpected GET ${path}`);
      });
      mockPost.mockResolvedValueOnce({ data: FREE_SUMMARY });
      const api = await renderScreen();
      await act(async () => {
        summaryLoad.reject(new Error('HTTP 500 Internal Server Error: {}'));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => expect(api.getByTestId('plan-card-pro')).toBeTruthy());
      expect(api.queryByTestId('plan-load-error')).toBeNull();
      expect(api.getByText('無料プランをご利用中です')).toBeTruthy();
      expect(mockFetchOfferings).toHaveBeenCalledTimes(1);
      api.unmount();
    });

    it('要約の読み込みが先に失敗し、そのあと同期が要約を読めた: 失敗の表示を消して、カードを出す', async () => {
      const sync = deferred<unknown>();
      summaryResponse = new Error('HTTP 500 Internal Server Error: {}');
      mockPost.mockImplementationOnce(() => sync.promise);
      const api = await renderScreen();
      expect(api.getByTestId('plan-load-error')).toBeTruthy();
      expect(mockFetchOfferings).not.toHaveBeenCalled();
      await act(async () => {
        sync.resolve({ data: FREE_SUMMARY });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => expect(api.getByTestId('plan-card-pro')).toBeTruthy());
      expect(api.queryByTestId('plan-load-error')).toBeNull();
      expect(mockFetchOfferings).toHaveBeenCalledTimes(1);
      api.unmount();
    });

    it('要約の読み込みも同期も失敗した: 失敗の表示で、カードは読まない', async () => {
      summaryResponse = new Error('HTTP 500 Internal Server Error: {}');
      const api = await renderScreen();
      expect(api.getByTestId('plan-load-error')).toBeTruthy();
      expect(mockIdentifyPurchases).not.toHaveBeenCalled();
      expect(mockFetchOfferings).not.toHaveBeenCalled();
      api.unmount();
    });
  });
});
