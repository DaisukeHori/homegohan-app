/**
 * purchases.test.ts
 * apps/mobile/src/lib/purchases.ts (RevenueCat の薄い包み。billing/03 §8.10) のテスト (テスト 52)。
 *
 *  - identifyPurchases: 最初の 1 回だけ configure (appUserID = 利用者の id)。同じ利用者なら何もしない。別の利用者なら logIn で切り替える
 *  - resetPurchasesOnSignOut: 匿名でなければ logOut。configure の前は何もしない。失敗しても投げない。次の identify は logIn で切り替える
 *  - 公開 SDK キーが無いビルド (空・空白だけを含む) は、何もしない (isPurchasesAvailable が false)
 *  - fetchTrialEligibility: iOS だけ SDK に尋ね、4 値を画面の判定に写す。Android・失敗・configure の前は空
 *  - ensurePurchasesIdentity (#1912): 結び付けて SDK の app_user_id が利用者と一致するときだけ通る。logIn の失敗・不一致・キー無しは投げる
 *  - identify と reset は呼ばれた順に 1 つずつ流れる (#1912。SIGNED_OUT の reset の logOut が次の利用者の logIn と前後しない)
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
  describe('#1912 P3: 利用者の結び付けの確かめと順序', () => {
    it('ensurePurchasesIdentity は SDK の app_user_id が利用者と一致するときだけ通り、logIn の失敗では configuredAppUserId を変えずに投げる', async () => {
      const { purchases, sdk } = load();
      const Purchases = sdk.default;

      // 最初の利用者: configure して、SDK の id が一致すれば通る
      Purchases.getAppUserID.mockResolvedValueOnce('user-a');
      await expect(purchases.ensurePurchasesIdentity('user-a')).resolves.toBeUndefined();
      expect(Purchases.configure).toHaveBeenCalledWith({ apiKey: APPLE_KEY, appUserID: 'user-a' });

      // SDK の id が一致しない (匿名など): 投げる
      Purchases.getAppUserID.mockResolvedValueOnce('$RCAnonymousID:x');
      await expect(purchases.ensurePurchasesIdentity('user-a')).rejects.toBeInstanceOf(purchases.PurchasesIdentityMismatchError);

      // 別の利用者の logIn が通信で落ちた: 投げ、SDK の id は尋ねない。前の利用者のまま進めない
      Purchases.logIn.mockRejectedValueOnce(new Error('network'));
      const getAppUserIdCalls = Purchases.getAppUserID.mock.calls.length;
      await expect(purchases.ensurePurchasesIdentity('user-b')).rejects.toThrow('network');
      expect(Purchases.getAppUserID.mock.calls.length).toBe(getAppUserIdCalls);
      // identify も同じく投げる (画面はカードを読まない)
      Purchases.logIn.mockRejectedValueOnce(new Error('network'));
      await expect(purchases.identifyPurchases('user-b')).rejects.toThrow('network');

      // 次の確かめは logIn をやり直す (configuredAppUserId は user-a のまま = 'user-b' と違うので logIn する)
      Purchases.getAppUserID.mockResolvedValueOnce('user-b');
      await expect(purchases.ensurePurchasesIdentity('user-b')).resolves.toBeUndefined();
      expect(Purchases.logIn).toHaveBeenCalledTimes(3);
      expect(Purchases.logIn).toHaveBeenLastCalledWith('user-b');

      // キーが無いビルド: 結び付けられないので投げる (購入・復元をしない)
      delete process.env[APPLE_KEY_NAME];
      const noKey = load();
      await expect(noKey.purchases.ensurePurchasesIdentity('user-a')).rejects.toBeInstanceOf(noKey.purchases.PurchasesIdentityMismatchError);
      expect(noKey.sdk.default.getAppUserID).not.toHaveBeenCalled();
    });

    it('reset の途中に呼ばれた identify は、reset (logOut) が済むまで logIn しない', async () => {
      const { purchases, sdk } = load();
      const Purchases = sdk.default;
      await purchases.identifyPurchases('user-a');

      let finishIsAnonymous: (value: boolean) => void = () => {};
      Purchases.isAnonymous.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishIsAnonymous = resolve;
          }),
      );
      const resetDone = purchases.resetPurchasesOnSignOut();
      const identifyDone = purchases.identifyPurchases('user-b');
      // reset の通信が終わるまで、次の利用者の logIn は始まらない
      await Promise.resolve();
      await Promise.resolve();
      expect(Purchases.logIn).not.toHaveBeenCalled();

      finishIsAnonymous(false);
      await resetDone;
      await identifyDone;
      expect(Purchases.logOut).toHaveBeenCalledTimes(1);
      expect(Purchases.logIn).toHaveBeenCalledTimes(1);
      expect(Purchases.logIn).toHaveBeenCalledWith('user-b');
      expect(Purchases.logOut.mock.invocationCallOrder[0]).toBeLessThan(Purchases.logIn.mock.invocationCallOrder[0]);

      // reset が済んだあとの確かめは user-b で通る (reset の finally が user-b を null に戻していない)
      Purchases.getAppUserID.mockResolvedValueOnce('user-b');
      await expect(purchases.ensurePurchasesIdentity('user-b')).resolves.toBeUndefined();
      expect(Purchases.logIn).toHaveBeenCalledTimes(1);

      // reset を 2 回続けて呼んでも (signOut.ts のあとに届く SIGNED_OUT など)、logOut は 1 回だけ増える (2 回目は何もしない)
      await purchases.resetPurchasesOnSignOut();
      await purchases.resetPurchasesOnSignOut();
      expect(Purchases.logOut).toHaveBeenCalledTimes(2);
    });

    it('前の identify の失敗は、列の次の op に持ち越さない', async () => {
      const { purchases, sdk } = load();
      const Purchases = sdk.default;
      await purchases.identifyPurchases('user-a');
      Purchases.logIn.mockRejectedValueOnce(new Error('network'));
      const failed = purchases.identifyPurchases('user-b');
      const next = purchases.identifyPurchases('user-c');
      await expect(failed).rejects.toThrow('network');
      await expect(next).resolves.toBeUndefined();
      expect(Purchases.logIn).toHaveBeenLastCalledWith('user-c');
    });
  });
});
