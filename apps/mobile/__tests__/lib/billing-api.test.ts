/**
 * billing-api.test.ts
 * apps/mobile/src/lib/billing-api.ts (課金の API の読み書き。billing/03 §8.10) のテスト (テスト 96)。
 *
 *  - 要約 (GET /api/billing/subscription・POST /api/billing/iap/sync) は @homegohan/shared の parseBillingSummaryWire で読み、
 *    形が違えば BillingSummaryShapeError
 *  - カタログ (GET /api/billing/iap/catalog?store=…) は形が違うプランを捨てる
 *  - 失敗の文: IAP の 4 つのコードはサーバの固定の文、ほかの HTTP のエラーは汎用の文、HTTP の形でない例外はその message
 */

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost }),
}));

import {
  BILLING_PURCHASE_FAILED_MESSAGE,
  BILLING_SUBSCRIPTION_API_PATH,
  BILLING_SUMMARY_LOAD_FAILED_MESSAGE,
  BillingSummaryShapeError,
  IAP_CATALOG_API_PATH,
  IAP_SYNC_API_PATH,
  billingErrorMessageOf,
  fetchBillingSummary,
  fetchIapCatalog,
  syncIapPurchases,
} from '../../src/lib/billing-api';

const UNFINISHED_WORDS = ['準備中', '販売開始前', '近日', '予定', 'まだ', '確定次第', 'これから'] as const;

const SUMMARY = {
  plan_key: 'pro',
  effective_plan_key: 'pro',
  status: 'active',
  source: 'app_store',
  manage_in_store: 'app_store',
  billing_interval: 'month',
  current_period_end: '2026-11-21T00:00:00.000Z',
  trial_ends_at: null,
  cancel_at_period_end: false,
  cancel_at: null,
  has_customer: false,
  can_purchase: false,
  can_cancel: false,
  can_resume: false,
  features: { ai_daily_limit: 30, ai_feature_caps: { menu_generation_ultimate: 2 } },
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('billing-api.ts (billing/03 §8.10)', () => {
  it('fetchBillingSummary / syncIapPurchases parse the data with parseBillingSummaryWire and throw BillingSummaryShapeError on a bad shape; fetchIapCatalog drops malformed plans; billingErrorMessageOf returns the server fixed text for the 4 IAP codes, the generic text for other HTTP errors, and none of UNFINISHED_WORDS appears', async () => {
    // 要約
    mockGet.mockResolvedValueOnce({ data: SUMMARY });
    await expect(fetchBillingSummary()).resolves.toEqual(SUMMARY);
    expect(mockGet).toHaveBeenLastCalledWith(BILLING_SUBSCRIPTION_API_PATH);
    expect(BILLING_SUBSCRIPTION_API_PATH).toBe('/api/billing/subscription');

    mockGet.mockResolvedValueOnce({ data: { ...SUMMARY, status: 'unknown_status' } });
    await expect(fetchBillingSummary()).rejects.toBeInstanceOf(BillingSummaryShapeError);
    mockGet.mockResolvedValueOnce(undefined);
    await expect(fetchBillingSummary()).rejects.toThrow(BILLING_SUMMARY_LOAD_FAILED_MESSAGE);

    // 同期 (本文なしの POST)
    mockPost.mockResolvedValueOnce({ data: { ...SUMMARY, status: null, plan_key: 'free', can_purchase: true } });
    await expect(syncIapPurchases()).resolves.toMatchObject({ status: null, plan_key: 'free', can_purchase: true });
    expect(mockPost).toHaveBeenLastCalledWith(IAP_SYNC_API_PATH);
    expect(IAP_SYNC_API_PATH).toBe('/api/billing/iap/sync');
    mockPost.mockResolvedValueOnce({ data: { ...SUMMARY, features: null } });
    await expect(syncIapPurchases()).rejects.toBeInstanceOf(BillingSummaryShapeError);

    // カタログ
    mockGet.mockResolvedValueOnce({
      data: {
        store: 'play_store',
        plans: [
          { plan_key: 'pro', display_name: '個人 Pro', max_members: null, products: [{ billing_interval: 'month', product_id: 'pro_month' }] },
          { plan_key: 'broken', display_name: 'x', max_members: 'many', products: [{ billing_interval: 'month', product_id: 'b' }] },
        ],
      },
    });
    await expect(fetchIapCatalog('play_store')).resolves.toEqual([
      { plan_key: 'pro', display_name: '個人 Pro', max_members: null, products: [{ billing_interval: 'month', product_id: 'pro_month' }] },
    ]);
    expect(mockGet).toHaveBeenLastCalledWith(`${IAP_CATALOG_API_PATH}?store=play_store`);
    expect(IAP_CATALOG_API_PATH).toBe('/api/billing/iap/catalog');
    // store が違う応答は空
    mockGet.mockResolvedValueOnce({ data: { store: 'app_store', plans: [] } });
    await expect(fetchIapCatalog('play_store')).resolves.toEqual([]);

    // 失敗の文: IAP の 4 つのコードはサーバの固定の文
    const fixedCodes = ['BILL_IAP_SYNC_CONFLICT', 'BILL_IAP_UNKNOWN_PRODUCT', 'EXT_REVENUECAT_NOT_CONFIGURED', 'EXT_REVENUECAT_API_FAILED'];
    for (const code of fixedCodes) {
      const serverText = `サーバの固定の文 ${code}`;
      const error = new Error(`HTTP 409 Conflict: ${JSON.stringify({ error: { code, message: serverText } })}`);
      expect(billingErrorMessageOf(error)).toBe(serverText);
    }
    // ほかのコード・JSON でない本文・本文に error が無い HTTP のエラーは汎用の文
    expect(billingErrorMessageOf(new Error(`HTTP 500 Internal Server Error: ${JSON.stringify({ error: { code: 'INTERNAL', message: 'raw db error' } })}`))).toBe(
      BILLING_PURCHASE_FAILED_MESSAGE,
    );
    expect(billingErrorMessageOf(new Error('HTTP 502 Bad Gateway: <html>bad gateway</html>'))).toBe(BILLING_PURCHASE_FAILED_MESSAGE);
    expect(billingErrorMessageOf(new Error('HTTP 400 Bad Request: {"message":"x"}'))).toBe(BILLING_PURCHASE_FAILED_MESSAGE);
    // HTTP の形でない例外 (getApi の通信の失敗の固定の文など) はその message
    expect(billingErrorMessageOf(new Error('通信できませんでした。電波の状況をご確認ください。'))).toBe(
      '通信できませんでした。電波の状況をご確認ください。',
    );
    // message が無い・空
    expect(billingErrorMessageOf(null)).toBe(BILLING_PURCHASE_FAILED_MESSAGE);
    expect(billingErrorMessageOf({ message: '' })).toBe(BILLING_PURCHASE_FAILED_MESSAGE);
    expect(billingErrorMessageOf('string error')).toBe(BILLING_PURCHASE_FAILED_MESSAGE);

    for (const text of [BILLING_SUMMARY_LOAD_FAILED_MESSAGE, BILLING_PURCHASE_FAILED_MESSAGE]) {
      for (const word of UNFINISHED_WORDS) expect(text).not.toContain(word);
    }
  });
});
