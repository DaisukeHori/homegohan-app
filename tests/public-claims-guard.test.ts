/**
 * #1155 / #1151 公開ページに「架空・未確認の会社情報と実績、未確定の価格」を載せないための守りのテスト
 *
 * ログイン不要で誰でも見られる公開ページ (トップ・サービス紹介・お知らせ・運営会社・特定商取引法・料金・FAQ) には、
 * 以前、実在しない代表者名・住所・電話番号、根拠のない利用者数や評価、架空のメディア掲載・資金調達・利用者の声、
 * まだ販売していない有料プランの価格が載っていた。2026-10-08 のオーナー判断で取り下げたので、書き戻されないように見張る。
 *
 *   1. ソース走査: 公開ページのソースに、載せてはいけない文字列が無いこと
 *   2. 描画確認   : ページを実際に描画した結果にも載せてはいけない文字列が無く、「準備中」の案内が出ていること
 *      (文字列を組み立てて出す書き方や、`<br />` で分割した書き方もすり抜けないようにする)
 *
 * 実在の事業者情報が確定したとき、または有料プランの販売を始めるとき (課金導線 #1151 の実装後) は、
 * このテストの該当項目 (「準備中」の確認と、載せてよくなった文字列) を意図して更新する。
 * billing/01 §10.1 (#1701 段 C): /pricing は async の Server Component (page.tsx) になり、見える文は PricingPageView.tsx に移った。
 * 公開ページの走査・描画は PricingPageView を「買えるプランが 0 件」で描いたもの (いまと同じ「準備中」) で見る。
 * page.tsx そのものは @/lib/billing/public-plans と next/headers をモックして、0 件 (準備中) と買えるプランがある場合を見る。
 * 2026-10-14 (#1155): 事業者名・代表者が確定し、所在地・電話番号は「請求があった場合に遅滞なく開示します」とする扱いになったので、
 * 特定商取引法ページと運営会社ページの該当項目を更新した (値は src/lib/business-info.ts)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUSINESS_NAME, BUSINESS_REPRESENTATIVE, DISCLOSED_ON_REQUEST } from '@/lib/business-info';
import { getSupportEmail } from '@/lib/site-config';
import type { PurchasablePlan } from '@/lib/billing/core';

// /pricing の page.tsx (Server Component) が読む「買えるプラン」と Cookie (is_native_app)。it ごとに値を変える
const pricingMocks = vi.hoisted(() => ({
  plans: [] as PurchasablePlan[],
  nativeAppCookie: undefined as string | undefined,
}));

vi.mock('@/lib/billing/public-plans', () => ({
  listPurchasablePlans: async () => pricingMocks.plans,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'is_native_app' && pricingMocks.nativeAppCookie !== undefined ? { name, value: pricingMocks.nativeAppCookie } : undefined,
  }),
}));

// next/link と next/image は描画に Next.js の実行環境を要らないよう、素の a / img に置き換える
vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

vi.mock('next/image', async () => {
  const react = await import('react');
  return {
    default: ({ src, alt, className }: { src: string; alt: string; className?: string }) =>
      react.createElement('img', { src, alt, className }),
  };
});

// トップは #1867 で Server Component の殻 (src/app/page.tsx。メタ情報と JSON-LD) と画面の本体 (LandingPageView.tsx) に分けた。
// 文言を持つのは本体なので、本体を描いて読む
const { default: LandingPage } = await import('@/app/LandingPageView');
const { default: AboutPage } = await import('@/app/about/page');
const { default: NewsPage } = await import('@/app/news/page');
const { default: CompanyPage } = await import('@/app/company/page');
const { default: LegalPage } = await import('@/app/legal/page');
const { default: PricingPage } = await import('@/app/pricing/page');
const { default: PricingPageView } = await import('@/app/pricing/PricingPageView');
const { default: FaqPage } = await import('@/app/faq/page');

const ROOT = path.resolve(__dirname, '..');

/** 公開ページ (ログイン不要で誰でも見られる) */
const PUBLIC_PAGES: { file: string; Page: ComponentType }[] = [
  { file: 'src/app/LandingPageView.tsx', Page: LandingPage },
  { file: 'src/app/about/page.tsx', Page: AboutPage },
  { file: 'src/app/news/page.tsx', Page: NewsPage },
  { file: 'src/app/company/page.tsx', Page: CompanyPage },
  { file: 'src/app/legal/page.tsx', Page: LegalPage },
  { file: 'src/app/pricing/PricingPageView.tsx', Page: () => createElement(PricingPageView, { plans: [], isNativeApp: false }) },
  { file: 'src/app/faq/page.tsx', Page: FaqPage },
];

/** 公開ページに載せてはいけない文字列と、その理由 */
const FORBIDDEN: { text: string; reason: string }[] = [
  // ダミーの事業者情報
  { text: '03-1234-5678', reason: '実在しないダミーの電話番号' },
  { text: '山田 太郎', reason: 'ダミーの代表者名' },
  { text: '神宮前1-2-3', reason: 'ダミーの住所' },
  { text: 'ほめゴハンビル', reason: 'ダミーのビル名' },
  { text: 'homegohan.jp', reason: '届かないメールアドレス・存在しない URL (support@homegohan.jp / https://homegohan.jp)' },
  { text: '資本金', reason: '確認できていない会社情報' },
  { text: '従業員数', reason: '確認できていない会社情報' },
  // 架空の沿革・資金調達
  { text: 'シリーズA', reason: '架空の資金調達' },
  { text: 'シードラウンド', reason: '架空の資金調達' },
  // 根拠のない利用者数・評価・実績
  { text: '10万人', reason: '根拠のない利用者数' },
  { text: 'App Store評価', reason: '根拠のない評価' },
  { text: '1,234,567', reason: '根拠のない分析件数' },
  { text: '98.7', reason: '根拠のない継続率' },
  { text: '継続率', reason: '根拠のない実績' },
  { text: '食の分析実績', reason: '根拠のない実績' },
  { text: '最長連続記録', reason: '根拠のない実績' },
  { text: '90%以上の精度', reason: '検証していない認識精度' },
  // 架空のメディア掲載
  { text: 'Forbes', reason: '架空のメディア掲載' },
  { text: '日経新聞', reason: '架空のメディア掲載' },
  { text: '東洋経済', reason: '架空のメディア掲載' },
  { text: 'TechCrunch', reason: '架空のメディア掲載' },
  { text: 'NewsPicks', reason: '架空のメディア掲載' },
  { text: 'メディア掲載', reason: '架空のメディア掲載' },
  // 架空の利用者の声・成果
  { text: 'リアルな声', reason: '架空の利用者の声' },
  { text: '変化のストーリー', reason: '架空の利用者の体験談' },
  { text: '血圧-15mmHg', reason: '架空の利用者の健康上の成果' },
  { text: '-4.2kg', reason: '架空の利用者の健康上の成果' },
  { text: '自炊率0%→70%', reason: '架空の利用者の成果' },
  { text: '野菜摂取量2倍', reason: '架空の利用者の成果' },
  { text: '体調スコア+30%', reason: '架空の利用者の成果' },
  // 未確定の価格・約束
  { text: '¥980', reason: '未確定の価格' },
  { text: '¥1,980', reason: '未確定の価格' },
  { text: '980円', reason: '未確定の価格' },
  { text: '1,980円', reason: '未確定の価格' },
  { text: '9,800円', reason: '未確定の価格' },
  { text: '永久無料', reason: '将来にわたる無料の約束 (有料プランの内容が決まっていないため約束できない)' },
  // 事実と違う断定
  { text: '第三者がアクセスすることはできません', reason: '断定できない (最終的な文言はプライバシーポリシーの見直しで決める)' },
  { text: '第三者に共有・販売することは一切', reason: '断定できない (最終的な文言はプライバシーポリシーの見直しで決める)' },
  { text: '第三者に共有されることはありません', reason: '断定できない (最終的な文言はプライバシーポリシーの見直しで決める)' },
];

/** 確定情報がまだ無い項目に出す文言 (特定商取引法・運営会社) */
const PENDING_NOTICE = '準備中（確定次第掲載します）';
/** 有料プランは販売開始前であることを示す文言 (特定商取引法・料金ページ) */
const PAID_PLAN_PENDING_NOTICE = '有料プランは準備中です（販売開始前）';

const readSource = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** 描画して、タグを外した本文を返す。`support@<br />homegohan.jp` のような分割も一続きの文字列として検査できる */
function renderText(Page: ComponentType): string {
  return renderToStaticMarkup(createElement(Page)).replace(/<[^>]*>/g, '');
}

function renderHtml(Page: ComponentType): string {
  return renderToStaticMarkup(createElement(Page));
}

function findForbidden(content: string) {
  return FORBIDDEN.filter(({ text }) => content.includes(text)).map(({ text, reason }) => `「${text}」(${reason})`);
}

describe('#1155 公開ページのソースに、架空・未確認の会社情報と実績、未確定の価格が無い', () => {
  it.each(PUBLIC_PAGES.map(({ file }) => file))('%s', (file) => {
    expect(findForbidden(readSource(file))).toEqual([]);
  });

  it('依頼で名指しされた文字列 (電話番号・代表者名・住所・利用者数・評価・分析件数・資金調達・メディア名・価格・成果) をすべて検査している', () => {
    const required = [
      '03-1234-5678',
      '山田 太郎',
      '神宮前1-2-3',
      '10万人',
      'App Store評価',
      '1,234,567',
      'シリーズA',
      'Forbes',
      '¥980',
      '¥1,980',
      '血圧-15mmHg',
    ];
    const checked = FORBIDDEN.map(({ text }) => text);
    for (const text of required) {
      expect(checked, `検査対象に「${text}」が無い`).toContain(text);
    }
  });
});

describe('#1155 公開ページを描画した結果にも、架空・未確認の会社情報と実績、未確定の価格が無い', () => {
  it.each(PUBLIC_PAGES.map(({ file, Page }) => [file, Page] as const))('%s', (_file, Page) => {
    expect(findForbidden(renderText(Page))).toEqual([]);
  });
});

describe('#1155 特定商取引法ページ (/legal)', () => {
  const source = readSource('src/app/legal/page.tsx');
  const text = renderText(LegalPage);

  it('販売事業者・代表者・所在地・電話番号・メールアドレスは確定した値 (所在地・電話番号は請求時に開示) を表示し、「準備中」は残さない', () => {
    const expected: Record<string, string> = {
      販売事業者: BUSINESS_NAME,
      代表者: BUSINESS_REPRESENTATIVE,
      所在地: DISCLOSED_ON_REQUEST,
      電話番号: DISCLOSED_ON_REQUEST,
      メールアドレス: getSupportEmail(),
    };
    for (const [label, value] of Object.entries(expected)) {
      // 表の 1 行 = <th>ラベル</th><td>値</td>
      const row = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`).exec(renderHtml(LegalPage));
      expect(row, `「${label}」の行が無い`).not.toBeNull();
      expect(row![1].replace(/<[^>]*>/g, '').trim(), `「${label}」の値`).toBe(value);
    }
    expect(text).not.toContain(PENDING_NOTICE);
  });

  it('販売価格・支払方法・支払時期・サービス提供時期・解約は「有料プランは準備中です（販売開始前）」と表示する', () => {
    for (const label of ['販売価格', '支払方法', '支払時期', 'サービス提供時期', '解約について']) {
      const row = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`).exec(renderHtml(LegalPage));
      expect(row, `「${label}」の行が無い`).not.toBeNull();
      expect(row![1].replace(/<[^>]*>/g, '').trim(), `「${label}」の値`).toBe(PAID_PLAN_PENDING_NOTICE);
    }
  });

  it('お問い合わせは /contact のフォームへ案内する', () => {
    expect(renderHtml(LegalPage)).toContain('href="/contact"');
    expect(text).toContain('お問い合わせフォーム');
    // ソースにも文言が残っていること (描画に頼らず、書き換えられたときに気付けるようにする)
    expect(source).toContain(PAID_PLAN_PENDING_NOTICE);
  });

  it('事業者名・代表者は src/lib/business-info.ts の定数から出す (ページに直接書かない)', () => {
    expect(source).toContain('BUSINESS_NAME');
    expect(source).toContain('BUSINESS_REPRESENTATIVE');
    expect(source).not.toContain(BUSINESS_NAME);
    expect(source).not.toContain(BUSINESS_REPRESENTATIVE);
  });
});

describe('#1155 運営会社ページ (/company)', () => {
  const html = renderHtml(CompanyPage);
  const text = renderText(CompanyPage);

  it('チーム紹介・沿革は載せず、会社名・代表者は確定した値、所在地は「準備中」と表示する', () => {
    expect(text).not.toContain('沿革');
    expect(text).not.toContain('チーム');
    const cell = (label: string) => {
      const row = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`).exec(html);
      expect(row, `「${label}」の行が無い`).not.toBeNull();
      return row![1].replace(/<[^>]*>/g, '').trim();
    };
    expect(cell('会社名')).toBe(BUSINESS_NAME);
    expect(cell('代表者')).toBe(BUSINESS_REPRESENTATIVE);
    expect(cell('所在地')).toBe(PENDING_NOTICE);
  });

  it('お問い合わせは /contact のフォームへ案内する', () => {
    expect(html).toContain('href="/contact"');
  });
});

/** 買えるプランが 0 件のときの料金ページ (いまと同じ「準備中」) */
const PricingPageWithoutPlans = () => createElement(PricingPageView, { plans: [], isNativeApp: false });

describe('#1151 料金ページ (/pricing)', () => {
  const text = renderText(PricingPageWithoutPlans);
  const source = readSource('src/app/pricing/PricingPageView.tsx');

  it('有料プランは「準備中」とだけ表示し、価格・機能・年払いの切り替えは出さない', () => {
    expect(text).toContain(PAID_PLAN_PENDING_NOTICE);
    expect(text).toContain('準備中');
    for (const word of ['プレミアム', 'ファミリー', '月払い', '年払い', '人気No.1', '広告表示']) {
      expect(text, `「${word}」が残っている`).not.toContain(word);
    }
    expect(source).not.toContain('billingPeriod');
  });

  it('フリープランには、実際には無い制限 (1日3食まで・週1回・30日分・広告) を書かない', () => {
    for (const word of ['1日3食', '週1回', '30日分', '広告']) {
      expect(text, `「${word}」が残っている`).not.toContain(word);
    }
  });

  it('有料プランのカードには「始める」ボタン (登録への導線) を置かない', () => {
    expect(text).not.toContain('プレミアムを始める');
    expect(text).not.toContain('ファミリーを始める');
  });
});

/** テスト 51 のモックのプラン。金額は FORBIDDEN に無い値 */
function plan(overrides: Partial<PurchasablePlan> & Pick<PurchasablePlan, 'plan_key' | 'display_name' | 'plan_type'>): PurchasablePlan {
  return {
    status: 'public',
    monthly_price_jpy: null,
    yearly_price_jpy: null,
    trial_days: 0,
    stripe_price_id: null,
    stripe_yearly_price_id: null,
    ...overrides,
  };
}

/** page.tsx (async の Server Component) を描いて HTML を返す */
async function renderPricingPageHtml(): Promise<string> {
  return renderToStaticMarkup(await PricingPage());
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '');

describe('billing/01 §10.1 料金ページ (/pricing) のデータ駆動', () => {
  const planA = plan({
    plan_key: 'test_personal_a',
    display_name: 'テストA',
    plan_type: 'personal',
    monthly_price_jpy: 1234,
    yearly_price_jpy: 12340,
    trial_days: 7,
    stripe_price_id: 'price_a_month',
    stripe_yearly_price_id: 'price_a_year',
  });
  const planB = plan({
    plan_key: 'test_family_b',
    display_name: 'テストB',
    plan_type: 'family',
    monthly_price_jpy: 2345,
    yearly_price_jpy: 23450,
    stripe_price_id: 'price_b_month',
    stripe_yearly_price_id: null,
  });

  afterEach(() => {
    pricingMocks.plans = [];
    pricingMocks.nativeAppCookie = undefined;
  });

  it('pricing page shows 準備中 when there is no purchasable plan: no rows, or the only row has no interval for which isPurchasable is true', async () => {
    for (const plans of [
      [],
      [plan({ plan_key: 'test_zero', display_name: 'テストZ', plan_type: 'personal', monthly_price_jpy: 0, stripe_price_id: 'price_zero', stripe_yearly_price_id: null })],
    ]) {
      pricingMocks.plans = plans;
      const html = await renderPricingPageHtml();
      const text = stripTags(html);
      expect(text).toContain(PAID_PLAN_PENDING_NOTICE);
      expect(text).toContain('現在、料金はかかりますか？');
      expect(text).toContain('有料プランはありますか？');
      expect(text).not.toContain('月額で始める');
      expect(text).not.toContain('年額で始める');
      expect(text).not.toContain('テストZ');
      expect(html).not.toContain('/account/billing/checkout');
      // フリーのカードと「無料で始める」はどちらの場合も描く
      expect(text).toContain('フリー');
      expect(text).toContain('無料で始める');
    }
  });

  it('pricing page shows one card per purchasable plan with an amount and a CTA only for the intervals where isPurchasable is true (both Prices: 月額で始める → interval=month and 年額で始める → interval=year; no stripe_yearly_price_id: only the monthly amount and 月額で始める, no yearly amount and no interval=year link), without the 準備中 notice and the pre-sale FAQ, and hides the cards and CTA in native app mode', async () => {
    pricingMocks.plans = [planA, planB];
    const html = await renderPricingPageHtml();
    const text = stripTags(html);

    // A: 月額と年額の両方
    expect(text).toContain('テストA');
    expect(text).toContain('7日間無料');
    expect(text).toContain('¥1,234');
    expect(text).toContain('¥12,340');
    expect(html).toContain('/account/billing/checkout?plan_key=test_personal_a&amp;interval=month');
    expect(html).toContain('/account/billing/checkout?plan_key=test_personal_a&amp;interval=year');
    // B: 年額の Price が無いので月額だけ
    expect(text).toContain('テストB');
    expect(text).toContain('¥2,345');
    expect(html).toContain('/account/billing/checkout?plan_key=test_family_b&amp;interval=month');
    expect(text).not.toContain('¥23,450');
    expect(html).not.toContain('plan_key=test_family_b&amp;interval=year');
    // 単位と CTA の文
    expect(text).toContain('/ 月（税込）');
    expect(text).toContain('/ 年（税込）');
    expect(text.split('月額で始める')).toHaveLength(3);
    expect(text.split('年額で始める')).toHaveLength(2);
    // 販売開始前の案内 (段落・準備中のカード・FAQ) は描かない
    expect(text).not.toContain(PAID_PLAN_PENDING_NOTICE);
    expect(text).not.toContain('販売開始前');
    expect(text).not.toContain('現在は無料でご利用いただけます。');
    expect(text).not.toContain('現在、料金はかかりますか？');
    expect(text).not.toContain('有料プランはありますか？');
    // フリーのカードと末尾の「無料で始める」は描く
    expect(text).toContain('フリー');
    expect(text).toContain('無料で始める');

    // アプリの WebView では有料プランのカードと CTA を描かない (フリーの説明だけ)
    pricingMocks.nativeAppCookie = '1';
    const nativeHtml = await renderPricingPageHtml();
    const nativeText = stripTags(nativeHtml);
    for (const word of ['テストA', 'テストB', '¥1,234', '¥2,345', '月額で始める', '年額で始める']) {
      expect(nativeText, `アプリの中に「${word}」が出ている`).not.toContain(word);
    }
    expect(nativeHtml).not.toContain('/account/billing/checkout');
    expect(nativeText).toContain('フリー');
  });
});

describe('#1155 FAQ (/faq とトップページの FAQ)', () => {
  const faq = readSource('src/app/faq/page.tsx');
  const landing = readSource('src/app/LandingPageView.tsx');

  it('プランごとの上限・料金・プレミアム限定の説明を載せない', () => {
    for (const word of ['無料プランでは', 'プレミアムプラン', '月額', '年払い', 'Visa', '解約後も次回更新日まで']) {
      expect(faq, `/faq に「${word}」が残っている`).not.toContain(word);
    }
  });

  it('データのエクスポートは、プレミアム限定ではなく JSON で誰でも使える説明にしている', () => {
    expect(faq).toContain('JSON形式');
  });

  it('データの保存・第三者への提供は断定せず、プライバシーポリシーへ案内する', () => {
    const lines = faq.split('\n');
    for (const q of ['写真データはどこに保存されますか？', 'データは第三者に共有されますか？']) {
      const line = lines.find((l) => l.includes(`q: '${q}'`));
      expect(line, `/faq に「${q}」が無い`).toBeDefined();
      expect(line, `/faq の「${q}」がプライバシーポリシーへ案内していない`).toContain('プライバシーポリシー');
    }
    const landingLine = landing.split('\n').find((l) => l.includes('q: "データは安全ですか？"'));
    expect(landingLine, 'トップページの FAQ に「データは安全ですか？」が無い').toBeDefined();
    expect(landingLine).toContain('プライバシーポリシー');
  });

  it('AI の認識精度を数字で約束しない', () => {
    expect(faq).not.toMatch(/\d+%以上の精度/);
    expect(landing).not.toMatch(/\d+%以上の精度/);
  });
});
