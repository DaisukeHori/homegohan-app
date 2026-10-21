/**
 * iap-catalog.test.ts
 * apps/mobile/src/lib/iap-catalog.ts (カタログと offerings の突き合わせ・無料体験の文・自動更新の文・カタログの読み取り。billing/03 §8.10)
 * のテスト (テスト 51・110)。純粋な関数なので RN もストアも使わない。
 */

import {
  matchCatalogWithPackages,
  parseIapCatalogPlans,
  renewalText,
  storeTrialOf,
  type CatalogPlanLike,
  type IntroPriceLike,
  type PackageLike,
} from '../../src/lib/iap-catalog';

const UNFINISHED_WORDS = ['準備中', '販売開始前', '近日', '予定', 'まだ', '確定次第', 'これから'] as const;

function pkg(productId: string, priceString: string, introPrice: IntroPriceLike | null = null): PackageLike {
  return { identifier: `pkg_${productId}`, product: { identifier: productId, priceString, introPrice } };
}

const FREE_WEEK: IntroPriceLike = { price: 0, periodUnit: 'WEEK', periodNumberOfUnits: 1, cycles: 1 };
const FREE_7_DAYS: IntroPriceLike = { price: 0, periodUnit: 'DAY', periodNumberOfUnits: 7, cycles: 1 };

const PLANS: CatalogPlanLike[] = [
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
  {
    plan_key: 'family_pro',
    display_name: '家族 Pro',
    max_members: 8,
    products: [{ billing_interval: 'month', product_id: 'family_pro_month' }],
  },
];

describe('iap-catalog.ts (billing/03 §8.10)', () => {
  it('matchCatalogWithPackages keeps only products present in both the catalog and the offerings and attaches storeTrialOf to each option, and renewalText states the trial only when given and always states the renewal', () => {
    const packages = [
      pkg('pro_month', '¥580', FREE_WEEK),
      pkg('pro_year', '¥5,800'),
      pkg('family_basic_month', '¥980'),
      // カタログに無い商品 (出さない)
      pkg('unknown_month', '¥100'),
    ];
    const cards = matchCatalogWithPackages('app_store', PLANS, packages, { pro_month: 'eligible' });

    // family_pro はストアに無いので出さない。unknown_month はカタログに無いので出さない
    expect(cards).toEqual([
      {
        plan_key: 'pro',
        display_name: '個人 Pro',
        max_members: null,
        options: [
          { billing_interval: 'month', product_id: 'pro_month', priceString: '¥580', packageIdentifier: 'pkg_pro_month', trial: { lengthText: '7 日間' } },
          { billing_interval: 'year', product_id: 'pro_year', priceString: '¥5,800', packageIdentifier: 'pkg_pro_year', trial: null },
        ],
      },
      {
        plan_key: 'family_basic',
        display_name: '家族 Basic',
        max_members: 4,
        options: [
          { billing_interval: 'month', product_id: 'family_basic_month', priceString: '¥980', packageIdentifier: 'pkg_family_basic_month', trial: null },
        ],
      },
    ]);

    // どちらか一方にしか無ければ空
    expect(matchCatalogWithPackages('app_store', PLANS, [], {})).toEqual([]);
    expect(matchCatalogWithPackages('app_store', [], packages, {})).toEqual([]);

    // 自動更新の文: 体験があるときだけ体験の長さ、更新の説明は常に
    const withTrial = renewalText('month', '¥580', { lengthText: '7 日間' });
    expect(withTrial).toBe('7 日間の無料体験のあと、1 か月ごとに ¥580 が自動で更新されます。解約しない限り更新が続きます。');
    const monthly = renewalText('month', '¥580', null);
    expect(monthly).toBe('1 か月ごとに ¥580 が自動で更新されます。解約しない限り更新が続きます。');
    expect(monthly).not.toContain('無料体験');
    const yearly = renewalText('year', '¥5,800', null);
    expect(yearly).toBe('1 年ごとに ¥5,800 が自動で更新されます。解約しない限り更新が続きます。');
    for (const text of [withTrial, monthly, yearly]) {
      for (const word of UNFINISHED_WORDS) expect(text).not.toContain(word);
    }
  });

  it('storeTrialOf returns 7 日間 for an eligible App Store free trial of 1 WEEK and a Google Play free trial of 7 DAY, and null for ineligible / unknown / missing App Store eligibility, a paid intro price, no intro price, or an unknown period unit', () => {
    // App Store: eligible のときだけ
    expect(storeTrialOf('app_store', pkg('p', '¥580', FREE_WEEK), { p: 'eligible' })).toEqual({ lengthText: '7 日間' });
    expect(storeTrialOf('app_store', pkg('p', '¥580', FREE_WEEK), { p: 'ineligible' })).toBeNull();
    expect(storeTrialOf('app_store', pkg('p', '¥580', FREE_WEEK), { p: 'unknown' })).toBeNull();
    expect(storeTrialOf('app_store', pkg('p', '¥580', FREE_WEEK), { p: 'no_offer' })).toBeNull();
    expect(storeTrialOf('app_store', pkg('p', '¥580', FREE_WEEK), {})).toBeNull();

    // Google Play: 判定の答えは使わない (Google が対象の利用者にだけ offer を返す)
    expect(storeTrialOf('play_store', pkg('p', '¥580', FREE_7_DAYS), {})).toEqual({ lengthText: '7 日間' });
    expect(storeTrialOf('play_store', pkg('p', '¥580', FREE_7_DAYS), { p: 'ineligible' })).toEqual({ lengthText: '7 日間' });

    // 割引の導入価格 (0 円でない)・導入価格なし・知らない単位
    expect(storeTrialOf('play_store', pkg('p', '¥580', { ...FREE_7_DAYS, price: 100 }), {})).toBeNull();
    expect(storeTrialOf('play_store', pkg('p', '¥580', null), {})).toBeNull();
    expect(storeTrialOf('play_store', pkg('p', '¥580', { ...FREE_7_DAYS, periodUnit: 'FORTNIGHT' }), {})).toBeNull();
    expect(storeTrialOf('play_store', pkg('p', '¥580', { ...FREE_7_DAYS, periodNumberOfUnits: 0 }), {})).toBeNull();

    // 月・年の単位と、繰り返しの回数
    expect(storeTrialOf('play_store', pkg('p', '¥580', { price: 0, periodUnit: 'MONTH', periodNumberOfUnits: 1, cycles: 1 }), {})).toEqual({
      lengthText: '1 か月',
    });
    expect(storeTrialOf('play_store', pkg('p', '¥580', { price: 0, periodUnit: 'YEAR', periodNumberOfUnits: 1, cycles: 1 }), {})).toEqual({
      lengthText: '1 年',
    });
    expect(storeTrialOf('play_store', pkg('p', '¥580', { price: 0, periodUnit: 'WEEK', periodNumberOfUnits: 1, cycles: 2 }), {})).toEqual({
      lengthText: '14 日間',
    });
    expect(storeTrialOf('play_store', pkg('p', '¥580', { price: 0, periodUnit: 'DAY', periodNumberOfUnits: 3, cycles: 0 }), {})).toEqual({
      lengthText: '3 日間',
    });
  });

  it('parseIapCatalogPlans は store が違う・形が違う全体を空にし、形が違う項目だけを捨てる', () => {
    const data = {
      store: 'app_store',
      plans: [
        { plan_key: 'pro', display_name: '個人 Pro', max_members: null, products: [{ billing_interval: 'month', product_id: 'pro_month' }] },
        // 商品の形が違う項目は捨て、残りが無いプランは出さない
        { plan_key: 'family_basic', display_name: '家族 Basic', max_members: 4, products: [{ billing_interval: 'week', product_id: 'x' }, { billing_interval: 'month', product_id: '' }] },
        // max_members が整数でない
        { plan_key: 'family_pro', display_name: '家族 Pro', max_members: 1.5, products: [{ billing_interval: 'month', product_id: 'fp' }] },
        { plan_key: 1, display_name: 'x', max_members: null, products: [] },
        null,
      ],
    };
    expect(parseIapCatalogPlans(data, 'app_store')).toEqual([
      { plan_key: 'pro', display_name: '個人 Pro', max_members: null, products: [{ billing_interval: 'month', product_id: 'pro_month' }] },
    ]);
    expect(parseIapCatalogPlans(data, 'play_store')).toEqual([]);
    expect(parseIapCatalogPlans(null, 'app_store')).toEqual([]);
    expect(parseIapCatalogPlans([], 'app_store')).toEqual([]);
    expect(parseIapCatalogPlans({ store: 'app_store', plans: 'x' }, 'app_store')).toEqual([]);
  });
});
