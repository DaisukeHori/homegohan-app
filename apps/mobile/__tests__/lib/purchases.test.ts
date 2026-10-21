/**
 * purchases.test.ts
 * apps/mobile/src/lib/purchases.ts (RevenueCat の薄い包み。billing/03 §8.10) のテスト (テスト 52)。
 *
 *  - identifyPurchases: 最初の 1 回だけ configure (appUserID = 利用者の id)。同じ利用者なら何もしない。別の利用者なら logIn で切り替える
 *  - resetPurchasesOnSignOut: 匿名でなければ logOut。configure の前は何もしない。失敗しても投げない。次の identify は logIn で切り替える
 *  - 公開 SDK キーが無いビルド (空・空白だけを含む) は、何もしない (isPurchasesAvailable が false)
 *  - fetchTrialEligibility: iOS だけ SDK に尋ね、4 値を画面の判定に写す。Android・失敗・configure の前は空
 *
 * SDK は jest.config.js の moduleNameMapper で __mocks__/react-native-purchases.js に差し替わる (本物のストアを呼ばない)。
 * purchases.ts はモジュールの中に「configure 済みの利用者」を持つので、テストごとに jest.isolateModules で読み直す。
 */

// Platform.OS はテストが切り替える。isolateModules で読み直しても同じ値を返すよう、変数から読む
let mockPlatformOS = 'ios';
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatformOS;
    },
  },
}));

type PurchasesModule = typeof import('../../src/lib/purchases');
type SdkMock = {
  default: Record<string, jest.Mock>;
  INTRO_ELIGIBILITY_STATUS: Record<string, number>;
};

const APPLE_KEY_NAME = 'EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY';
const GOOGLE_KEY_NAME = 'EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY';
const APPLE_KEY = 'appl_test_public_key';
const GOOGLE_KEY = 'goog_test_public_key';

// process.env は差し替えず、同じオブジェクトを書き換えて戻す (env.test.ts と同じ理由: jest-expo は読み込み時の process.env を握る)
const saved: Record<string, string | undefined> = {};

function load(): { purchases: PurchasesModule; sdk: SdkMock } {
  let purchases: PurchasesModule | undefined;
  let sdk: SdkMock | undefined;
  jest.isolateModules(() => {
    sdk = require('react-native-purchases') as SdkMock;
    purchases = require('../../src/lib/purchases') as PurchasesModule;
  });
  if (purchases === undefined || sdk === undefined) throw new Error('module not loaded');
  return { purchases, sdk };
}

function setPlatform(os: string): void {
  mockPlatformOS = os;
}

beforeEach(() => {
  saved[APPLE_KEY_NAME] = process.env[APPLE_KEY_NAME];
  saved[GOOGLE_KEY_NAME] = process.env[GOOGLE_KEY_NAME];
  process.env[APPLE_KEY_NAME] = APPLE_KEY;
  process.env[GOOGLE_KEY_NAME] = GOOGLE_KEY;
  setPlatform('ios');
});

afterEach(() => {
  for (const name of [APPLE_KEY_NAME, GOOGLE_KEY_NAME]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('purchases.ts (billing/03 §8.10)', () => {
  it('identifyPurchases configures once with the user id, logs in on user change, and resetPurchasesOnSignOut logs out only when not anonymous; without keys it does nothing', async () => {
    const { purchases, sdk } = load();
    const Purchases = sdk.default;

    expect(purchases.isPurchasesAvailable()).toBe(true);

    // 1 回目: configure (iOS は Apple のキー)
    await purchases.identifyPurchases('user-a');
    expect(Purchases.configure).toHaveBeenCalledTimes(1);
    expect(Purchases.configure).toHaveBeenCalledWith({ apiKey: APPLE_KEY, appUserID: 'user-a' });
    expect(Purchases.logIn).not.toHaveBeenCalled();

    // 同じ利用者: 何もしない
    await purchases.identifyPurchases('user-a');
    expect(Purchases.configure).toHaveBeenCalledTimes(1);
    expect(Purchases.logIn).not.toHaveBeenCalled();

    // 別の利用者: logIn で切り替える (configure は 1 回のまま)
    await purchases.identifyPurchases('user-b');
    expect(Purchases.configure).toHaveBeenCalledTimes(1);
    expect(Purchases.logIn).toHaveBeenCalledTimes(1);
    expect(Purchases.logIn).toHaveBeenCalledWith('user-b');

    // 匿名でなければ logOut。そのあとの identify は logIn で切り替える (configure は 1 回だけ)
    Purchases.isAnonymous.mockResolvedValueOnce(false);
    await purchases.resetPurchasesOnSignOut();
    expect(Purchases.logOut).toHaveBeenCalledTimes(1);
    expect(await purchases.currentCustomerInfo()).toBeNull();
    await purchases.identifyPurchases('user-c');
    expect(Purchases.configure).toHaveBeenCalledTimes(1);
    expect(Purchases.logIn).toHaveBeenLastCalledWith('user-c');

    // 匿名なら logOut しない
    Purchases.isAnonymous.mockResolvedValueOnce(true);
    await purchases.resetPurchasesOnSignOut();
    expect(Purchases.logOut).toHaveBeenCalledTimes(1);

    // 失敗しても投げない
    await purchases.identifyPurchases('user-d');
    Purchases.isAnonymous.mockRejectedValueOnce(new Error('network'));
    await expect(purchases.resetPurchasesOnSignOut()).resolves.toBeUndefined();

    // configure の前 (別のモジュールの読み直し) のサインアウトは何もしない
    const fresh = load();
    await fresh.purchases.resetPurchasesOnSignOut();
    expect(fresh.sdk.default.isAnonymous).not.toHaveBeenCalled();
    expect(fresh.sdk.default.logOut).not.toHaveBeenCalled();

    // キーが無いビルド (空・空白だけも無いとみなす): 何もしない
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env[APPLE_KEY_NAME];
      else process.env[APPLE_KEY_NAME] = value;
      const noKey = load();
      expect(noKey.purchases.isPurchasesAvailable()).toBe(false);
      await noKey.purchases.identifyPurchases('user-a');
      await noKey.purchases.resetPurchasesOnSignOut();
      expect(noKey.sdk.default.configure).not.toHaveBeenCalled();
      expect(noKey.sdk.default.logIn).not.toHaveBeenCalled();
      expect(noKey.sdk.default.logOut).not.toHaveBeenCalled();
    }
  });

  it('Android は Google のキーで configure し、前後の空白を外す。iOS / Android 以外は使えない', async () => {
    setPlatform('android');
    process.env[GOOGLE_KEY_NAME] = `  ${GOOGLE_KEY}  `;
    const { purchases, sdk } = load();
    expect(purchases.isPurchasesAvailable()).toBe(true);
    await purchases.identifyPurchases('user-a');
    expect(sdk.default.configure).toHaveBeenCalledWith({ apiKey: GOOGLE_KEY, appUserID: 'user-a' });

    setPlatform('web');
    const web = load();
    expect(web.purchases.isPurchasesAvailable()).toBe(false);
  });

  it('purchase は利用者の取り消しを cancelled に、ほかの失敗を error に分ける', async () => {
    const { purchases, sdk } = load();
    const pkg = { identifier: '$rc_monthly' } as unknown as Parameters<PurchasesModule['purchase']>[0];

    sdk.default.purchasePackage.mockResolvedValueOnce({ customerInfo: { managementURL: null } });
    await expect(purchases.purchase(pkg)).resolves.toEqual({ ok: true, customerInfo: { managementURL: null } });

    sdk.default.purchasePackage.mockRejectedValueOnce({ userCancelled: true, message: 'cancelled' });
    await expect(purchases.purchase(pkg)).resolves.toEqual({ ok: false, cancelled: true });

    const failure = { userCancelled: false, message: 'store problem' };
    sdk.default.purchasePackage.mockRejectedValueOnce(failure);
    await expect(purchases.purchase(pkg)).resolves.toEqual({ ok: false, cancelled: false, error: failure });
  });

  it('fetchTrialEligibility は iOS だけ尋ねて 4 値を写し、Android・失敗・configure の前・商品なしは空', async () => {
    const { purchases, sdk } = load();
    const STATUS = sdk.INTRO_ELIGIBILITY_STATUS;

    // configure の前
    expect(await purchases.fetchTrialEligibility(['p1'])).toEqual({});
    expect(sdk.default.checkTrialOrIntroductoryPriceEligibility).not.toHaveBeenCalled();

    await purchases.identifyPurchases('user-a');
    sdk.default.checkTrialOrIntroductoryPriceEligibility.mockResolvedValueOnce({
      p_unknown: { status: STATUS.INTRO_ELIGIBILITY_STATUS_UNKNOWN },
      p_ineligible: { status: STATUS.INTRO_ELIGIBILITY_STATUS_INELIGIBLE },
      p_eligible: { status: STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE },
      p_none: { status: STATUS.INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS },
    });
    expect(await purchases.fetchTrialEligibility(['p_unknown', 'p_ineligible', 'p_eligible', 'p_none'])).toEqual({
      p_unknown: 'unknown',
      p_ineligible: 'ineligible',
      p_eligible: 'eligible',
      p_none: 'no_offer',
    });
    expect(sdk.default.checkTrialOrIntroductoryPriceEligibility).toHaveBeenCalledWith([
      'p_unknown',
      'p_ineligible',
      'p_eligible',
      'p_none',
    ]);

    // 商品なし
    expect(await purchases.fetchTrialEligibility([])).toEqual({});
    // 失敗
    sdk.default.checkTrialOrIntroductoryPriceEligibility.mockRejectedValueOnce(new Error('store'));
    expect(await purchases.fetchTrialEligibility(['p1'])).toEqual({});
    expect(sdk.default.checkTrialOrIntroductoryPriceEligibility).toHaveBeenCalledTimes(2);

    // Android は尋ねない
    setPlatform('android');
    expect(await purchases.fetchTrialEligibility(['p1'])).toEqual({});
    expect(sdk.default.checkTrialOrIntroductoryPriceEligibility).toHaveBeenCalledTimes(2);
  });
});
