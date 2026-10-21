/**
 * #1155 / #1151 公開ページに「架空・未確認の会社情報と実績、未確定の価格」を載せないための守りのテスト
 *
 * ログイン不要で誰でも見られる公開ページ (トップ・サービス紹介・お知らせ・運営会社・特定商取引法・料金・FAQ) には、
 * 以前、実在しない代表者名・住所・電話番号、根拠のない利用者数や評価、架空のメディア掲載・資金調達・利用者の声、
 * まだ販売していない有料プランの価格が載っていた。2026-10-08 のオーナー判断で取り下げたので、書き戻されないように見張る。
 *
 *   1. ソース走査: 公開ページのソースに、載せてはいけない文字列が無いこと
 *   2. 描画確認   : ページを実際に描画した結果にも載せてはいけない文字列が無いこと
 *      (文字列を組み立てて出す書き方や、`<br />` で分割した書き方もすり抜けないようにする)
 *
 * 実在の事業者情報が確定したとき、または有料プランの販売を始めるとき (課金導線 #1151 の実装後) は、
 * このテストの該当項目 (特定商取引法の料金・支払の欄の文と、載せてよくなった文字列) を意図して更新する。
 * #1911: 未完成のものを「準備中」「販売開始前」「確定次第掲載します」と書かない。買えるプランが無いときの /pricing は無料の案内だけを出し、
 * 特定商取引法の表記には、有料の販売で要る項目 (販売価格・支払方法など) を項目ごと出さない (有料プランの販売 #1912 が足す)。
 * billing/01 §10.1 (#1701 段 C): /pricing は async の Server Component (page.tsx) になり、見える文は PricingPageView.tsx に移った。
 * 公開ページの走査・描画は PricingPageView を「買えるプランが 0 件」で描いたもので見る。
 * page.tsx そのものは @/lib/billing/public-plans と next/headers をモックして、0 件と買えるプランがある場合を見る。
 * 2026-10-14 (#1155): 事業者名・代表者が確定したので、特定商取引法ページと運営会社ページの該当項目を更新した (値は src/lib/business-info.ts)。
 * 2026-10-19 (#1911): 所在地・設立・資本金・メールアドレス・営業時間を株式会社MHD医健の公開の会社情報で埋めた (値は src/lib/business-info.ts)。
 * 電話番号は載せず「請求があれば遅滞なく開示します」と書き、請求の窓口 (メールアドレスとお問い合わせのフォーム) を添える。
 * billing/03 (#1912 段 C): 有料プランの販売を始めた。価格 (個人 Pro 580円 / 家族 Basic 980円 / 家族 Pro 1,480円) は公開してよい文字列になったので
 * FORBIDDEN から外し、/pricing は公開のプラン (listPublicPlans) の価格と内容を Price の有無に依らず出し、CTA は買える間隔だけに置く。
 * 特定商取引法の表記には販売の 9 行を出し、/faq の料金は 4 項目にした (テスト 44〜46・48・116)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUSINESS_ADDRESS,
  BUSINESS_CAPITAL,
  BUSINESS_EMAIL,
  BUSINESS_ESTABLISHED,
  BUSINESS_HOURS,
  BUSINESS_NAME,
  BUSINESS_REPRESENTATIVE,
  PHONE_DISCLOSED_ON_REQUEST,
} from '@/lib/business-info';
import type { PublicPlan } from '@/lib/billing/core';
import {
  FREE_PLAN_AI_LIMIT_NOTE,
  FREE_PLAN_FAQ_ANSWER,
  PAID_PLAN_SUMMARY,
  PAID_PLANS_FAQ_ANSWER,
  PLAN_CATALOG,
  PLAN_TRIAL_DAYS,
  planCatalogPriceText,
} from '@homegohan/shared';
import { GUIDES } from '@/app/guide/guide-content';
import { stripAllTags } from './helpers/strip-tags';

// /pricing の page.tsx (Server Component) が読む「公開のプラン」(listPublicPlans) と Cookie (is_native_app)。it ごとに値を変える
const pricingMocks = vi.hoisted(() => ({
  plans: [] as PublicPlan[],
  nativeAppCookie: undefined as string | undefined,
}));

vi.mock('@/lib/billing/public-plans', () => ({
  listPublicPlans: async () => pricingMocks.plans,
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

// トップは #1867 で Server Component の殻 (src/app/page.tsx。メタ情報・viewport・JSON-LD) と画面の本体 (src/components/marketing/LandingPage.tsx) に分けた。
// 文言を持つのは本体なので、本体を描いて読む。page.tsx は async (nonce を読む) なので createElement(Page) では描けず、本体 (同期の Server Component) を直に描く。
// 文言の正本は src/components/marketing/landing-copy.ts (下の PUBLIC_SOURCE_FILES でソースも走査する)
const { LandingPage } = await import('@/components/marketing/LandingPage');
const { default: AboutPage } = await import('@/app/about/page');
const { default: NewsPage } = await import('@/app/news/page');
const { default: CompanyPage } = await import('@/app/company/page');
const { default: LegalPage } = await import('@/app/legal/page');
const { default: PricingPage } = await import('@/app/pricing/page');
const { default: PricingPageView } = await import('@/app/pricing/PricingPageView');
const { default: FaqPage } = await import('@/app/faq/page');
// #1901: 利用規約・プライバシーポリシーの本文にも禁止の語の走査を掛ける (本文の正本は src/lib/legal の文面モジュール)
const { default: TermsPage } = await import('@/app/terms/page');
const { default: PrivacyPage } = await import('@/app/privacy/page');

const ROOT = path.resolve(__dirname, '..');

/** 公開ページ (ログイン不要で誰でも見られる) */
const PUBLIC_PAGES: { file: string; Page: ComponentType }[] = [
  { file: 'src/components/marketing/LandingPage.tsx', Page: LandingPage },
  { file: 'src/app/about/page.tsx', Page: AboutPage },
  { file: 'src/app/news/page.tsx', Page: NewsPage },
  { file: 'src/app/company/page.tsx', Page: CompanyPage },
  { file: 'src/app/legal/page.tsx', Page: LegalPage },
  { file: 'src/app/pricing/PricingPageView.tsx', Page: () => createElement(PricingPageView, { plans: [], isNativeApp: false }) },
  { file: 'src/app/faq/page.tsx', Page: FaqPage },
  { file: 'src/app/terms/page.tsx', Page: TermsPage },
  { file: 'src/app/privacy/page.tsx', Page: PrivacyPage },
];

/**
 * ソースを走査するファイル = 公開ページ全部 + 描画はしないファイル (#1867)。
 * - src/components/marketing/landing-copy.ts: 紹介ページの文言の正本 (部品のソースには文言が無いので、ここを走査する)
 * - src/lib/seo/public-pages.ts: 公開ページごとの description (SITE_DESCRIPTION を含む。検索結果に出る文)
 * - src/app/(auth)/layout.tsx: ログイン・新規登録の画面の layout は children が要るので描画の対象にしないが、
 *   根拠のない実績の表示が残っていた (10,000+ ユーザーが実践中) ので、ソースは公開ページと同じ FORBIDDEN で見る
 * - (#1867 公開の主張の見直し) 未ログインで開ける残りの公開の画面のソース: 使い方ガイド (/guide の本体と手順の文)・
 *   ログインと新規登録の画面・お問い合わせ。描画には Next.js の実行環境 (ルーター・認証の状態) が要るので、ソースだけを見る
 */
const PUBLIC_SOURCE_FILES: string[] = [
  ...PUBLIC_PAGES.map(({ file }) => file),
  'src/components/marketing/landing-copy.ts',
  // 紹介ページの新しい画面と拡大の画像の alt (#1867 v2.0。docs/design/marketing/01-landing-site.md §9.7)
  'src/components/marketing/landing-screens.ts',
  'src/lib/seo/public-pages.ts',
  'src/app/(auth)/layout.tsx',
  'src/app/(auth)/login/page.tsx',
  'src/app/(auth)/signup/page.tsx',
  'src/app/guide/page.tsx',
  'src/app/guide/guide-content.ts',
  'src/app/contact/page.tsx',
  // #1901: 利用規約・プライバシーポリシーの本文の正本 (ページは文を持たない)
  'src/lib/legal/terms-text.ts',
  'src/lib/legal/privacy-text.ts',
];

/** 公開ページに載せてはいけない文字列と、その理由 */
const FORBIDDEN: { text: string; reason: string }[] = [
  // ダミーの事業者情報
  { text: '03-1234-5678', reason: '実在しないダミーの電話番号' },
  { text: '山田 太郎', reason: 'ダミーの代表者名' },
  { text: '神宮前1-2-3', reason: 'ダミーの住所' },
  { text: 'ほめゴハンビル', reason: 'ダミーのビル名' },
  { text: 'homegohan.jp', reason: '届かないメールアドレス・存在しない URL (support@homegohan.jp / https://homegohan.jp)' },
  { text: '従業員数', reason: '確認できていない会社情報' },
  // 架空の沿革・資金調達
  { text: 'シリーズA', reason: '架空の資金調達' },
  { text: 'シードラウンド', reason: '架空の資金調達' },
  // 根拠のない利用者数・評価・実績
  { text: '10万人', reason: '根拠のない利用者数' },
  { text: '10,000+', reason: '根拠のない利用者数 (ログイン画面に残っていた表示)' },
  { text: 'ユーザーが実践中', reason: '根拠のない利用者数' },
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
  // 未確定の価格・約束 (billing/03 で決めた価格 (¥980・980円・9,800円 = 家族 Basic) は公開してよいので外した)
  { text: '¥1,980', reason: '未確定の価格' },
  { text: '1,980円', reason: '未確定の価格' },
  { text: '永久無料', reason: '将来にわたる無料の約束 (有料プランの内容が決まっていないため約束できない)' },
  // 事実と違う断定
  { text: '第三者がアクセスすることはできません', reason: '断定できない (最終的な文言はプライバシーポリシーの見直しで決める)' },
  { text: '第三者に共有・販売することは一切', reason: '断定できない (最終的な文言はプライバシーポリシーの見直しで決める)' },
  { text: '第三者に共有されることはありません', reason: '断定できない (最終的な文言はプライバシーポリシーの見直しで決める)' },
  // #1867 (紹介ページの設計 marketing/01 §24 の Q-11・Q-12 と、公開の画面の主張の見直し)
  // 写真の記録のコメントは定型の文 (supabase/functions/_shared/nutrition-pipeline.ts の buildTemplatePraiseAndTip) で、食事の中身を見て書く文ではない
  { text: '総合的に分析し', reason: '写真の記録のコメントは、料理の名前と食事の区分だけが変わる定型の文 (Q-11)' },
  { text: '良いところを見つけて褒めてくれます', reason: '写真の記録のコメントは、食事の中身を見て良いところを探す文ではない (Q-11)' },
  { text: 'AIコメント（褒める）', reason: '写真の記録のコメントは AI が書く文ではない (Q-11)' },
  { text: '彩りが素敵', reason: '写真の記録のコメントは、料理の見た目 (彩り) を見ない' },
  // 製品に無い機能・付き方
  { text: '週間レポート', reason: '週ごとのレポートの機能は無い (API も画面も無い)' },
  { text: 'レアバッジ', reason: 'バッジに「レア」という区分は無い (付くバッジは src/lib/badges/awardable.ts)' },
  { text: '目標達成でバッジ', reason: '目標の達成で付くバッジは無い (付くのは完了した食事の数・連続日数・期間ごとの集計)' },
  { text: '50種類以上', reason: '根拠のないバッジの種類の数' },
  { text: '%向上', reason: '根拠のない改善率' },
  { text: 'AIが気づきを教えてくれます', reason: '健康画面の「AI分析」(/health/insights) の中身を作る POST /api/health/insights を呼ぶ画面・アプリ・cron が無く、いつも空のまま' },
  // 測っていない所要時間・確かめていない認識の良し悪し
  { text: '30秒で', reason: '測っていない所要時間 (登録)' },
  { text: '数秒で', reason: '測っていない所要時間 (写真の解析)' },
  { text: '認識精度がアップ', reason: '確かめていない認識の良し悪し' },
  { text: '認識精度が上がります', reason: '確かめていない認識の良し悪し' },
  { text: '問題なく分析できます', reason: '確かめていない認識の良し悪し' },
  // 根拠の無い効果・最上級・約束
  { text: 'パフォーマンスを最大化', reason: '根拠のない効果の言い回し' },
  { text: '続けられるから、健康になれる', reason: '健康上の効果の約束' },
  { text: 'きっと実感', reason: '効果の約束' },
  { text: '最適な', reason: '根拠を出せない最上級' },
  { text: '24時間以内', reason: '返信の目安はお問い合わせの画面 (2〜3営業日) と食い違う' },
];

/**
 * AI を使う機能の 1 日の利用回数の上限 (#1149) を言う文の、/faq と /pricing で共通の部分 (#1867 Q-12)。
 * 無料プランの回数は、この文の後ろに FREE_PLAN_AI_LIMIT_NOTE (@homegohan/shared) が書く (billing/03 §8.9)
 */
const AI_DAILY_LIMIT_PHRASE = '1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。';

/** 以前、確定情報がまだ無い項目に出していた文言 (特定商取引法・運営会社)。#1911 で取り除いた */
const PENDING_NOTICE = '準備中（確定次第掲載します）';
/** 以前、有料プランが販売開始前であることを示していた文言 (特定商取引法・料金ページ・FAQ)。#1911 で取り除いた */
const PAID_PLAN_PENDING_NOTICE = '有料プランは準備中です（販売開始前）';
/** 未完成・予定を示す語。公開ページに出さない (#1911) */
const PENDING_WORDS = ['準備中', '販売開始前', '確定次第', '決まりましたら', '決まり次第', '近日'];
/**
 * 特定商取引法の表記で、有料の販売の項目 (billing/03 §10.2 の 9 行)。値は下の LEGAL_SALE_ROW_VALUES (設計書の逐語)。
 * 「準備中」とも、販売していないことの説明の文とも書かない (#1911)。
 */
const LEGAL_SALE_ROW_LABELS = [
  '販売価格',
  '商品代金以外の必要料金',
  '支払方法',
  '支払時期',
  'サービス提供時期',
  '返品・キャンセル',
  '解約について',
  '定期購入について',
  '無料体験について',
] as const;
/** 販売の 9 行の値 (billing/03 §10.2 の表の逐語。セルの文は改行 (\n) を whitespace-pre-wrap でそのまま描く) */
const LEGAL_SALE_ROW_VALUES: Readonly<Record<(typeof LEGAL_SALE_ROW_LABELS)[number], string>> = {
  販売価格: `${planCatalogPriceText()}\n無料プランは 0 円です。`,
  商品代金以外の必要料金: 'インターネット接続料金、通信料金等はお客様のご負担となります。',
  支払方法: 'Web: クレジットカード (決済の事業者 Stripe の決済画面で受け付けるカード)。\niOS / Android アプリ: App Store / Google Play のアプリ内課金。',
  支払時期:
    'Web: お申し込みの時に初回のお支払いをいただきます (無料体験のあるプランは、無料体験の終了時)。以後は毎月または毎年の更新日に自動でお支払いいただきます。\nアプリ内課金: 各ストアの定める時期にお支払いいただきます。',
  サービス提供時期: 'お支払いの手続き (無料体験のあるプランは、お申し込みの手続き) が完了した時点から、すぐにご利用いただけます。',
  '返品・キャンセル':
    'デジタルコンテンツの性質上、購入後の返品・返金は原則としてお受けしておりません。ただし、サービスに重大な瑕疵があった場合は、個別に対応いたします。\n\nApp Store / Google Play でお申し込みの場合の返金は、各ストアの規定によります。',
  解約について:
    'いつでも解約できます。Web でお申し込みの方は本サービスの画面から、App Store / Google Play でお申し込みの方は各ストアの定期購読の管理から解約してください。解約後も、お支払い済みの期間の終わりまでご利用いただけます。期間の途中の解約による日割りの返金はありません。',
  定期購入について: '有料プランは自動更新の定期購入です。解約しない限り、月額または年額の期間ごとに同じ金額が自動で請求されます。',
  無料体験について: `Web でお申し込みの場合、どの有料プランも ${PLAN_TRIAL_DAYS} 日間の無料体験つきです (同じプランにつき 1 回)。無料体験の終了時に自動で有料の期間に移り、販売価格が請求されます。無料体験の間に解約すると、料金は請求されません。App Store / Google Play でお申し込みの場合の無料体験は、各ストアの表示によります。`,
};
/** 未完成や予定を示す語 (billing/03 §14.1 のテスト 48。設計書の UNFINISHED_WORDS と同じ一覧) */
const UNFINISHED_WORDS = ['準備中', '販売開始前', '近日', '予定', 'まだ', '確定次第', 'これから'] as const;
/** 販売していないことを説明する文。販売を始めたので偽りになるこれらの文を書かない (#1911・billing/03 §10.2) */
const LEGAL_NOT_SELLING_TEXTS = [
  '有料の商品・サービスの販売はありません',
  'お支払いが必要な商品・サービスはありません',
  '登録の後、すぐにご利用いただけます',
  '設定から、いつでも退会できます',
] as const;
/** 電話番号の欄の文 (番号は載せず、請求があれば遅滞なく開示する。請求の窓口 = 事業者のメールアドレスとお問い合わせのフォーム) */
const PHONE_CELL_TEXT = `${PHONE_DISCLOSED_ON_REQUEST}。ご請求は、${BUSINESS_EMAIL} またはお問い合わせフォームからお願いします。`;

/** 表の 1 行 (<th>ラベル</th><td>値</td>) の値の HTML。行が無ければ null */
function tableCellHtml(html: string, label: string): string | null {
  const row = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`).exec(html);
  return row ? row[1] : null;
}

const readSource = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** 描画して、タグを外した本文を返す。`support@<br />homegohan.jp` のような分割も一続きの文字列として検査できる */
function renderText(Page: ComponentType): string {
  return stripAllTags(renderToStaticMarkup(createElement(Page)));
}

/** HTML の文字の実体参照を戻す (renderToStaticMarkup が書く 5 つ。&amp; は最後に戻す) */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

function renderHtml(Page: ComponentType): string {
  return renderToStaticMarkup(createElement(Page));
}

function findForbidden(content: string) {
  return FORBIDDEN.filter(({ text }) => content.includes(text)).map(({ text, reason }) => `「${text}」(${reason})`);
}

describe('#1155 公開ページのソースに、架空・未確認の会社情報と実績、未確定の価格が無い', () => {
  it.each(PUBLIC_SOURCE_FILES)('%s', (file) => {
    expect(findForbidden(readSource(file))).toEqual([]);
  });

  it('依頼で名指しされた文字列 (電話番号・代表者名・住所・利用者数・評価・分析件数・資金調達・メディア名・価格・成果) をすべて検査している', () => {
    const required = [
      '03-1234-5678',
      '山田 太郎',
      '神宮前1-2-3',
      '10万人',
      '10,000+',
      'ユーザーが実践中',
      'App Store評価',
      '1,234,567',
      'シリーズA',
      'Forbes',
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
  const html = renderHtml(LegalPage);
  const text = renderText(LegalPage);

  it('販売事業者・代表者・所在地・メールアドレス・営業時間は src/lib/business-info.ts の値を表示し、「準備中」は残さない (#1155 #1911)', () => {
    const expected: Record<string, string> = {
      販売事業者: BUSINESS_NAME,
      代表者: BUSINESS_REPRESENTATIVE,
      所在地: BUSINESS_ADDRESS,
      メールアドレス: BUSINESS_EMAIL,
      営業時間: BUSINESS_HOURS,
    };
    for (const [label, value] of Object.entries(expected)) {
      const cell = tableCellHtml(html, label);
      expect(cell, `「${label}」の行が無い`).not.toBeNull();
      expect(stripAllTags(cell!).trim(), `「${label}」の値`).toBe(value);
    }
    // 公開の会社情報の値そのもの (定数を書き換えて別の値にしたら気付けるように、逐語でも見る)
    expect(text).toContain('〒105-0013 東京都港区浜松町２丁目2番15号 浜松町ダイヤビル2F');
    expect(text).toContain('info@mhd-iken.com');
    expect(text).toContain('平日 9:00-17:00 (年末年始を除く)');
    expect(text).not.toContain(PENDING_NOTICE);
  });

  it('電話番号は載せず「請求があれば遅滞なく開示します」と書き、請求の窓口 (メールアドレスとお問い合わせのフォーム) を添える (#1911)', () => {
    const cell = tableCellHtml(html, '電話番号');
    expect(cell, '「電話番号」の行が無い').not.toBeNull();
    expect(stripAllTags(cell!).trim()).toBe(PHONE_CELL_TEXT);
    expect(cell).toContain('href="/contact"');
    expect(stripAllTags(cell!)).not.toMatch(/\d{2,4}-\d{2,4}-\d{3,4}/);
  });

  it('legal page keeps the #1911 business rows and adds the 9 sale rows (販売価格 from planCatalogPriceText, 支払方法, 支払時期, サービス提供時期, 返品・キャンセル, 解約について, 定期購入について, 無料体験について, 商品代金以外の必要料金) without LEGAL_NOT_SELLING_TEXTS and PENDING_WORDS', () => {
    const labels = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => stripAllTags(m[1]).trim());
    // #1911 の事業者の行と、お問い合わせ・動作環境の行は残す (表の行の並び: 事業者の 7 行 → 販売の 9 行 → 動作環境)
    expect(labels).toEqual([
      '販売事業者',
      '代表者',
      '所在地',
      '電話番号',
      'メールアドレス',
      '営業時間',
      'お問い合わせ',
      ...LEGAL_SALE_ROW_LABELS,
      '動作環境',
    ]);
    // 販売の 9 行の値は設計書の文のとおり (販売価格は planCatalogPriceText の 3 行 = PLAN_CATALOG の価格。DB との一致は tests/billing-plan-catalog.test.ts)
    for (const label of LEGAL_SALE_ROW_LABELS) {
      const cell = tableCellHtml(html, label);
      expect(cell, `「${label}」の行が無い`).not.toBeNull();
      expect(decodeEntities(stripAllTags(cell!)), `「${label}」の値`).toBe(LEGAL_SALE_ROW_VALUES[label]);
    }
    expect(text).toContain('個人 Pro: 月額 580円 / 年額 5,800円 (税込)');
    for (const sentence of LEGAL_NOT_SELLING_TEXTS) expect(text, `「${sentence}」が残っている`).not.toContain(sentence);
    expect(text).not.toContain(PAID_PLAN_PENDING_NOTICE);
    for (const word of PENDING_WORDS) expect(text, `「${word}」が残っている`).not.toContain(word);
  });

  it('お問い合わせは /contact のフォームへ案内する', () => {
    expect(tableCellHtml(html, 'お問い合わせ')).toContain('href="/contact"');
    expect(text).toContain('お問い合わせフォーム');
    // ソースにも取り除いた文言が残っていないこと (描画に頼らず、書き戻されたときに気付けるようにする)
    expect(source).not.toContain(PAID_PLAN_PENDING_NOTICE);
  });

  it('事業者の情報は src/lib/business-info.ts の定数から出す (ページに直接書かない)', () => {
    const constants: Record<string, string> = {
      BUSINESS_NAME,
      BUSINESS_REPRESENTATIVE,
      BUSINESS_ADDRESS,
      BUSINESS_EMAIL,
      BUSINESS_HOURS,
    };
    for (const [name, value] of Object.entries(constants)) {
      expect(source, `${name} を使っていない`).toContain(name);
      expect(source, `${name} の値を直接書いている`).not.toContain(value);
    }
    expect(source).not.toContain(PHONE_DISCLOSED_ON_REQUEST);
  });
});

describe('#1155 運営会社ページ (/company)', () => {
  const source = readSource('src/app/company/page.tsx');
  const html = renderHtml(CompanyPage);
  const text = renderText(CompanyPage);
  const cell = (label: string) => {
    const value = tableCellHtml(html, label);
    expect(value, `「${label}」の行が無い`).not.toBeNull();
    return stripAllTags(value!).trim();
  };

  it('チーム紹介・沿革は載せず、会社名・設立・資本金・代表者・所在地・メールアドレス・営業時間は src/lib/business-info.ts の値を表示する (#1911: 「準備中」と書かない)', () => {
    expect(text).not.toContain('沿革');
    expect(text).not.toContain('チーム');
    expect(cell('会社名')).toBe(BUSINESS_NAME);
    expect(cell('設立')).toBe(BUSINESS_ESTABLISHED);
    expect(cell('資本金')).toBe(BUSINESS_CAPITAL);
    expect(cell('代表者')).toBe(BUSINESS_REPRESENTATIVE);
    expect(cell('所在地')).toBe(BUSINESS_ADDRESS);
    expect(cell('メールアドレス')).toBe(BUSINESS_EMAIL);
    expect(cell('営業時間')).toBe(BUSINESS_HOURS);
    // 公開の会社情報の値そのもの (定数を書き換えて別の値にしたら気付けるように、逐語でも見る)
    expect(text).toContain('2025年1月31日');
    expect(text).toContain('2,000,000円');
    expect(text).toContain('〒105-0013 東京都港区浜松町２丁目2番15号 浜松町ダイヤビル2F');
    expect(text).not.toContain(PENDING_NOTICE);
    for (const word of PENDING_WORDS) expect(text, `「${word}」が残っている`).not.toContain(word);
  });

  it('電話番号は特定商取引法の表記と同じく、載せずに「請求があれば遅滞なく開示します」と請求の窓口を書く (#1911)', () => {
    expect(cell('電話番号')).toBe(PHONE_CELL_TEXT);
    expect(tableCellHtml(html, '電話番号')).toContain('href="/contact"');
  });

  it('値は src/lib/business-info.ts の定数から出す (ページに直接書かない)', () => {
    const constants: Record<string, string> = {
      BUSINESS_NAME,
      BUSINESS_ESTABLISHED,
      BUSINESS_CAPITAL,
      BUSINESS_REPRESENTATIVE,
      BUSINESS_ADDRESS,
      BUSINESS_EMAIL,
      BUSINESS_HOURS,
    };
    for (const [name, value] of Object.entries(constants)) {
      expect(source, `${name} を使っていない`).toContain(name);
      expect(source, `${name} の値を直接書いている`).not.toContain(value);
    }
  });

  it('お問い合わせは /contact のフォームと事業者のメールアドレスへ案内する', () => {
    expect(html).toContain('href="/contact"');
    expect(text).toContain(`メール (${BUSINESS_EMAIL})`);
  });
});

/** 公開のプランが 0 件 (読み取りの失敗) のときの料金ページ */
const PricingPageWithoutPlans = () => createElement(PricingPageView, { plans: [], isNativeApp: false });

describe('#1151 料金ページ (/pricing)', () => {
  const text = renderText(PricingPageWithoutPlans);
  const source = readSource('src/app/pricing/PricingPageView.tsx');

  it('公開のプランが 0 件 (読み取りの失敗) のときはフリーのカードだけで、「現在は無料」「有料プラン」・未完成を示す語を出さず、プレミアム・ファミリー・月払い・年払いも出さない。billingPeriod を使わない (billing/03 §10.1)', () => {
    expect(text).toContain('フリー');
    expect(text).not.toContain('現在は無料');
    expect(text).not.toContain('有料プラン');
    for (const word of PENDING_WORDS) expect(text, `「${word}」が残っている`).not.toContain(word);
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
function plan(overrides: Partial<PublicPlan> & Pick<PublicPlan, 'plan_key' | 'display_name' | 'plan_type'>): PublicPlan {
  return {
    status: 'public',
    monthly_price_jpy: null,
    yearly_price_jpy: null,
    trial_days: 0,
    stripe_price_id: null,
    stripe_yearly_price_id: null,
    max_members: null,
    ...overrides,
  };
}

/** PLAN_CATALOG の 3 プランを、Stripe の Price を入れる前 (stripe_price_id が無い) の公開のプランの行にしたもの (DB の値の写し) */
const CATALOG_PLANS_WITHOUT_PRICE: PublicPlan[] = PLAN_CATALOG.map((entry) =>
  plan({
    plan_key: entry.plan_key,
    display_name: entry.display_name,
    plan_type: entry.max_members === null ? 'personal' : 'family',
    monthly_price_jpy: entry.monthly_price_jpy,
    yearly_price_jpy: entry.yearly_price_jpy,
    trial_days: entry.trial_days,
    max_members: entry.max_members,
  }),
);

/** 有料のカードの下の注記 (billing/03 §10.1 の逐語) */
const PAID_PLAN_PAYMENT_NOTE =
  'お支払いはクレジットカード (Stripe) のほか、iOS / Android アプリでは App Store / Google Play のアプリ内課金でもお申し込みいただけます。アプリ内課金の価格は各ストアの表示が正となります。';

/** page.tsx (async の Server Component) を描いて HTML を返す */
async function renderPricingPageHtml(): Promise<string> {
  return renderToStaticMarkup(await PricingPage());
}

const stripTags = (html: string) => stripAllTags(html);

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

  it('pricing page shows only the free card (no FAQ section and no 現在は無料でご利用いただけます。) when there are no rows or the only row has amount 0', async () => {
    for (const plans of [
      [],
      [plan({ plan_key: 'test_zero', display_name: 'テストZ', plan_type: 'personal', monthly_price_jpy: 0, stripe_price_id: 'price_zero', stripe_yearly_price_id: null })],
    ]) {
      pricingMocks.plans = plans;
      const html = await renderPricingPageHtml();
      const text = stripTags(html);
      expect(text).not.toContain('現在は無料でご利用いただけます。');
      expect(text).not.toContain('よくある質問');
      expect(text).not.toContain('料金はかかりますか？');
      expect(text).not.toContain('有料プランはありますか？');
      expect(text).not.toContain(PAID_PLAN_PAYMENT_NOTE);
      for (const word of PENDING_WORDS) expect(text, `「${word}」が残っている`).not.toContain(word);
      expect(text).not.toContain('月額で始める');
      expect(text).not.toContain('年額で始める');
      expect(text).not.toContain('テストZ');
      expect(html).not.toContain('/account/billing/checkout');
      // フリーのカードと「無料で始める」はどちらの場合も描く
      expect(text).toContain('フリー');
      expect(text).toContain('無料で始める');
    }
  });

  it('pricing page shows CTA only for purchasable intervals and hides paid cards and the payment note in native app mode', async () => {
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
    // B: 年額の Price が無いので、年額の金額は出すが CTA は月額だけ (billing/03 §10.1: 金額は金額のある間隔ごとに常に出し、CTA は買える間隔だけ)
    expect(text).toContain('テストB');
    expect(text).toContain('¥2,345');
    expect(text).toContain('¥23,450');
    expect(html).toContain('/account/billing/checkout?plan_key=test_family_b&amp;interval=month');
    expect(html).not.toContain('plan_key=test_family_b&amp;interval=year');
    // 単位と CTA の文
    expect(text).toContain('/ 月（税込）');
    expect(text).toContain('/ 年（税込）');
    expect(text.split('月額で始める')).toHaveLength(3);
    expect(text.split('年額で始める')).toHaveLength(2);
    // 販売開始前の案内 (段落・準備中のカード・FAQ) は描かない
    expect(text).not.toContain(PAID_PLAN_PENDING_NOTICE);
    expect(text).not.toContain('販売開始前');
    expect(text).not.toContain('有料プランはありますか？');
    // お支払いの方法の注記 (有料のカードの下に 1 段落)
    expect(text.split(PAID_PLAN_PAYMENT_NOTE)).toHaveLength(2);
    // フリーのカードと末尾の「無料で始める」は描く
    expect(text).toContain('フリー');
    expect(text).toContain('無料で始める');

    // アプリの WebView では有料プランのカードと CTA を描かない (フリーの説明だけ)
    pricingMocks.nativeAppCookie = '1';
    const nativeHtml = await renderPricingPageHtml();
    const nativeText = stripTags(nativeHtml);
    for (const word of ['テストA', 'テストB', '¥1,234', '¥2,345', '月額で始める', '年額で始める', PAID_PLAN_PAYMENT_NOTE]) {
      expect(nativeText, `アプリの中に「${word}」が出ている`).not.toContain(word);
    }
    expect(nativeHtml).not.toContain('/account/billing/checkout');
    expect(nativeText).toContain('フリー');
  });

  it('pricing page shows one card per public plan with both interval amounts, trial and PLAN_CATALOG features and no CTA when no Price is registered, and only the free card when the read fails (no 現在は無料 and no FAQ section)', async () => {
    pricingMocks.plans = CATALOG_PLANS_WITHOUT_PRICE;
    const html = await renderPricingPageHtml();
    const text = stripTags(html);

    for (const entry of PLAN_CATALOG) {
      // 見出し・月額と年額の金額・無料体験・PLAN_CATALOG の features の箇条書き
      expect(text, entry.plan_key).toContain(entry.display_name);
      expect(text, entry.plan_key).toContain(`¥${entry.monthly_price_jpy.toLocaleString('ja-JP')}`);
      expect(text, entry.plan_key).toContain(`¥${entry.yearly_price_jpy.toLocaleString('ja-JP')}`);
      for (const feature of entry.features) expect(text, `${entry.plan_key}: ${feature}`).toContain(feature);
    }
    expect(text.split(`${PLAN_TRIAL_DAYS}日間無料`)).toHaveLength(PLAN_CATALOG.length + 1);
    expect(text).toContain('¥580');
    expect(text).toContain('¥5,800');
    // Price が無いので CTA は無い (代わりの文も置かない。Q-5)
    expect(text).not.toContain('月額で始める');
    expect(text).not.toContain('年額で始める');
    expect(html).not.toContain('/account/billing/checkout');
    // 注記は有料のカードを描くときに出す。「現在は無料」・FAQ の節は無い
    expect(text.split(PAID_PLAN_PAYMENT_NOTE)).toHaveLength(2);
    expect(text).not.toContain('現在は無料');
    expect(text).not.toContain('よくある質問');
    for (const word of PENDING_WORDS) expect(text, `「${word}」が出ている`).not.toContain(word);
    // フリーのカードは無料プランの機能と回数の文を出す
    expect(text).toContain(FREE_PLAN_AI_LIMIT_NOTE);

    // 読み取りの失敗 (listPublicPlans は空を返す) ではフリーのカードだけ
    pricingMocks.plans = [];
    const failedText = stripTags(await renderPricingPageHtml());
    expect(failedText).toContain('フリー');
    expect(failedText).toContain(FREE_PLAN_AI_LIMIT_NOTE);
    for (const entry of PLAN_CATALOG) expect(failedText, entry.plan_key).not.toContain(entry.display_name);
    expect(failedText).not.toContain(PAID_PLAN_PAYMENT_NOTE);
    expect(failedText).not.toContain('現在は無料');
    expect(failedText).not.toContain('よくある質問');
  });
});

describe('#1155 FAQ (/faq とトップページの FAQ)', () => {
  const faq = readSource('src/app/faq/page.tsx');
  const landing = readSource('src/components/marketing/landing-copy.ts');

  it('/faq の料金は「料金はかかりますか？」(FREE_PLAN_FAQ_ANSWER。AI_DAILY_LIMIT_PHRASE を含む)・「有料プランはありますか？」(PAID_PLANS_FAQ_ANSWER)・「返金はできますか？」・「有料プランを解約するには？」の 4 項目で、ページにプレミアム限定・Visa・解約後も次回更新日まで・年払いを書かない', () => {
    const paymentQuestions = faq
      .split('\n')
      .filter((line) => line.includes("category: 'payment'"))
      .map((line) => /q:\s*'([^']*)'/.exec(line)?.[1]);
    expect(paymentQuestions).toEqual(['料金はかかりますか？', '有料プランはありますか？', '返金はできますか？', '有料プランを解約するには？']);
    expect(faqAnswer(faq, '料金はかかりますか？')).toBe(FREE_PLAN_FAQ_ANSWER);
    expect(faqAnswer(faq, '料金はかかりますか？')).toContain(AI_DAILY_LIMIT_PHRASE);
    expect(faqAnswer(faq, '有料プランはありますか？')).toBe(PAID_PLANS_FAQ_ANSWER);
    expect(faqAnswer(faq, '返金はできますか？')).toContain('App Store / Google Play でお申し込みの場合の返金は、各ストアの規定によります。');
    expect(faqAnswer(faq, '有料プランを解約するには？')).toContain('「プランとお支払い」');
    expect(faqAnswer(faq, '有料プランを解約するには？')).toContain('各ストアの定期購読の管理から解約してください。');
    // 時を限る言い方 (「現在、」) を質問から外した
    expect(faq).not.toContain('現在、料金はかかりますか？');
    for (const word of ['プレミアムプラン', '年払い', 'Visa', '解約後も次回更新日まで']) {
      expect(faq, `/faq に「${word}」が残っている`).not.toContain(word);
    }
    // 描画 (最初に開くのは「基本的な使い方」の分類なので、料金の答えはソースで見る。描画でも禁止の語が出ないこと)
    const rendered = renderText(FaqPage);
    expect(rendered).toContain('よくある質問');
    for (const word of ['プレミアムプラン', '年払い', 'Visa', '解約後も次回更新日まで']) {
      expect(rendered, `/faq の描画に「${word}」が出ている`).not.toContain(word);
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

/** /faq のソースから、質問 q の答え a を読む (1 項目は 1 行に { category, q, a } で書く) */
function faqAnswer(source: string, q: string): string {
  const line = source.split('\n').find((l) => l.includes(`q: '${q}'`));
  expect(line, `/faq に「${q}」が無い`).toBeDefined();
  const match = /a:\s*'([^']*)'/.exec(line!);
  expect(match, `/faq の「${q}」の答えが読めない`).not.toBeNull();
  return match![1];
}

describe('#1867 (Q-11) 写真の記録のコメントを、実際に出るもの (定型の記録コメントと栄養メモ) で説明する', () => {
  const faq = readSource('src/app/faq/page.tsx');
  const recordScreen = readSource('src/app/(main)/meals/new/page.tsx');
  const pipeline = readSource('supabase/functions/_shared/nutrition-pipeline.ts');

  it('/faq「AIのコメントはどうやって生成されますか？」は、記録コメントが決まった形の文で、栄養メモがあることを言う', () => {
    const answer = faqAnswer(faq, 'AIのコメントはどうやって生成されますか？');
    expect(answer).toContain('「記録コメント」');
    expect(answer).toContain('「栄養メモ」');
    expect(answer).toContain('決まった形のひと言');
    expect(answer).toContain('食事の記録の画面では、写真で記録すると');
  });

  it('使い方ガイドの手順「コメントをもらう」は、記録コメントと栄養メモで説明する', () => {
    const step = GUIDES.flatMap((guide) => guide.steps).find((s) => s.title === 'コメントをもらう');
    expect(step, '使い方ガイドに手順「コメントをもらう」が無い').toBeDefined();
    expect(step!.desc).toContain('「記録コメント」');
    expect(step!.desc).toContain('「栄養メモ」');
  });

  it('説明が名指しする見出しは、食事の記録の画面に実在し、文はアプリの定型の文から作る', () => {
    expect(recordScreen).toContain('>記録コメント<');
    expect(recordScreen).toContain('栄養メモ:');
    expect(pipeline).toContain('function buildTemplatePraiseAndTip(');
  });
});

describe('#1867 (Q-12) 無料の説明に、AI を使う機能の 1 日の利用回数の上限を書く', () => {
  const faq = readSource('src/app/faq/page.tsx');
  const pricingSource = readSource('src/app/pricing/PricingPageView.tsx');
  const limitSource = readSource('supabase/functions/_shared/ai-daily-limit.ts');

  it('上限は実在し、上限に達したときの文も「明日 0 時から」と言う (翌日 0 時からの根拠)', () => {
    expect(limitSource).toContain('明日 0 時から使えます。');
  });

  it('/faq「料金はかかりますか？」の答えに上限を書く', () => {
    expect(faqAnswer(faq, '料金はかかりますか？')).toContain(AI_DAILY_LIMIT_PHRASE);
  });

  it('/pricing は、フリーのカード (アプリの中でも出す) に上限を書く (FAQ の節は billing/03 §10.1 で無くなった)', () => {
    const text = renderText(PricingPageWithoutPlans);
    expect(text.split(AI_DAILY_LIMIT_PHRASE)).toHaveLength(2);
    const nativeText = renderText(() => createElement(PricingPageView, { plans: [], isNativeApp: true }));
    expect(nativeText).toContain(AI_DAILY_LIMIT_PHRASE);
  });

  it('/pricing の「現在ご利用いただける機能」の注記は、上限が入った今の事実を言う (上限が無いかのような古い書き方を残さない)', () => {
    expect(pricingSource).not.toContain('回数や期間の上限・広告の有無など、実際には無いものは書かない');
    expect(pricingSource).toContain('FREE_PLAN_AI_LIMIT_NOTE');
  });
});

describe('billing/03 §10.1〜§10.5 公開の面に未完成や予定を示す語を書かない (テスト 48)', () => {
  it('no public page source or render (pricing / legal / faq / landing-copy) contains any of UNFINISHED_WORDS', () => {
    const sources = ['src/app/pricing/PricingPageView.tsx', 'src/app/legal/page.tsx', 'src/app/faq/page.tsx', 'src/components/marketing/landing-copy.ts'];
    for (const file of sources) {
      const source = readSource(file);
      for (const word of UNFINISHED_WORDS) expect(source, `${file} に「${word}」がある`).not.toContain(word);
    }
    const renders: { name: string; Page: ComponentType }[] = [
      { name: '/pricing (0 件)', Page: PricingPageWithoutPlans },
      { name: '/pricing (公開のプラン 3 つ・Price なし)', Page: () => createElement(PricingPageView, { plans: CATALOG_PLANS_WITHOUT_PRICE, isNativeApp: false }) },
      { name: '/legal', Page: LegalPage },
      { name: '/faq', Page: FaqPage },
    ];
    for (const { name, Page } of renders) {
      const text = renderText(Page);
      // 描画が空で素通りしないこと
      expect(text.length, name).toBeGreaterThan(0);
      for (const word of UNFINISHED_WORDS) expect(text, `${name} に「${word}」が出ている`).not.toContain(word);
    }
  });
});

describe('#1867 お知らせ (/news) に、実際には無かったお知らせを載せない', () => {
  it('お知らせが無いときは、その旨の文だけを出し、架空の日付のお知らせは出さない', () => {
    const text = renderText(NewsPage);
    expect(text).toContain('現在、お知らせはありません。');
    for (const word of ['2024-12', '2025-01', '健康記録機能をリリースしました', 'バッジ機能を追加しました', '年末年始']) {
      expect(text, `「${word}」が残っている`).not.toContain(word);
    }
  });
});

describe('#1867 健康の記録の説明は、空のままの「AI分析」ではなく、実在する写真からの読み取りで言う', () => {
  it('/about の「健康の記録」は、体重計と健康診断の結果票の写真からの記録を言い、「AI分析」の気づきは言わない', () => {
    const text = renderText(AboutPage);
    expect(text).toContain('体重は体重計の写真から、健康診断の結果は結果票の写真から読み取って記録することもできます。');
    expect(text).not.toContain('AI分析');
    expect(text).not.toContain('気づき');
  });

  it('使い方ガイドの手順「トレンドを確認」は、グラフで見られることだけを言い、「AI分析」の気づきは言わない', () => {
    const step = GUIDES.flatMap((guide) => guide.steps).find((s) => s.title === 'トレンドを確認');
    expect(step, '使い方ガイドに手順「トレンドを確認」が無い').toBeDefined();
    expect(step!.desc).not.toContain('AI分析');
    expect(step!.desc).not.toContain('気づき');
  });

  it('/about が言う写真からの読み取りは、画面から呼ばれている (体重計: 食事の記録の画面の写真の種類「体重計」・健康診断: 結果の登録の画面)', () => {
    expect(readSource('src/app/(main)/meals/new/page.tsx')).toContain('/api/ai/analyze-weight-scale');
    expect(readSource('src/app/(main)/health/checkups/new/page.tsx')).toContain('/api/ai/analyze-health-checkup');
  });

  it('健康画面の「AI分析」の画面は、一覧を読む (GET) と既読にするだけで、中身を作る POST /api/health/insights を呼ばない (呼ぶようになったら /about と /guide の説明を見直す)', () => {
    for (const file of ['src/app/(main)/health/insights/page.tsx', 'src/app/(main)/health/page.tsx']) {
      // 中身を作る POST は付け足しの無い '/api/health/insights' を宛先にする。一覧 (?limit=) と既読 (/${id}/read) は付け足しがある
      expect(readSource(file), `${file} が /api/health/insights をそのまま呼んでいる`).not.toMatch(/['"`]\/api\/health\/insights['"`]/);
    }
    expect(readSource('src/app/(main)/health/insights/page.tsx')).toContain('/api/health/insights?limit=');
  });
});

/** /about の「家族で使える」の説明 (#1912 P7。紹介ページの「家族で使う」の lead・FAQ と同じ条件 = 家族プランを契約した代表者が招待する) */
const ABOUT_FAMILY_DESCRIPTION =
  '家族プラン（家族 Basic・家族 Pro）をご契約の代表者が家族を招待して、献立を一緒に見たり、記録を共有したりできます。';
/** 有料の機能を言う語 (家族・究極モード・料理画像)。これを含む文には、有料のプランの条件を書く (#1912 P7) */
const PAID_FEATURE_WORDS = ['家族を招待', '家族グループ', '究極モード', '料理画像'] as const;
/** 有料の機能を言う文に要る、条件の語 (どちらか) */
const PAID_CONDITION_WORDS = ['家族プラン', '有料プラン'] as const;
/** 有料の機能を言うのに、条件 (家族プラン・有料プラン) の無い文。文は「。」と改行で区切る */
function unconditionedPaidSentences(text: string): string[] {
  return text
    .split(/[。\n]/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        PAID_FEATURE_WORDS.some((word) => sentence.includes(word)) && !PAID_CONDITION_WORDS.some((word) => sentence.includes(word)),
    );
}
/**
 * 文の条件を見る公開ページ (描画したもの)。利用規約・プライバシーポリシーは条文の前後で条件を書く (利用規約の家族の条文は、
 * 前の文で家族プランの契約を言い、次の文が「家族グループを作成したユーザーが代表者になります。」) ので、文ごとの検査の対象にしない
 */
const PAID_CONDITION_PAGES: { name: string; Page: ComponentType }[] = [
  { name: '紹介ページ', Page: LandingPage },
  { name: '/about', Page: AboutPage },
  { name: '/faq', Page: FaqPage },
  { name: '/pricing (0 件)', Page: () => createElement(PricingPageView, { plans: [], isNativeApp: false }) },
  { name: '/legal', Page: LegalPage },
  { name: '/company', Page: CompanyPage },
  { name: '/news', Page: NewsPage },
];

describe('#1912 P7 公開ページは、有料の機能 (家族・究極モード・料理画像・AI の回数) を条件なしで書かない', () => {
  it('/about の「家族で使える」は、家族プランを契約した代表者が家族を招待することを書く', () => {
    const text = renderText(AboutPage);
    expect(text).toContain(`家族で使える${ABOUT_FAMILY_DESCRIPTION}`);
    // 条件の無い旧の文 (見出しの直後に「家族を招待して」で始まる) に戻さない
    expect(text).not.toContain('家族で使える家族を招待して');
  });

  it('/about の機能の一覧の下に、AI を使う機能の 1 日の回数の上限と、有料プランで増えるものを書く (/faq・紹介ページと同じ定数)', () => {
    const html = renderHtml(AboutPage);
    const note = /<p[^>]*data-testid="about-plan-note"[^>]*>([\s\S]*?)<\/p>/.exec(html);
    expect(note, '/about に上限の注記が無い').not.toBeNull();
    expect(stripAllTags(note![1])).toBe(`${FREE_PLAN_AI_LIMIT_NOTE}${PAID_PLAN_SUMMARY}`);
    const text = renderText(AboutPage);
    expect(text.split(FREE_PLAN_AI_LIMIT_NOTE)).toHaveLength(2);
    expect(text.split(PAID_PLAN_SUMMARY)).toHaveLength(2);
    expect(readSource('src/app/about/page.tsx'), '/about が文を直接書いている').not.toContain(PAID_PLAN_SUMMARY);
  });

  it.each(PAID_CONDITION_PAGES.map(({ name, Page }) => [name, Page] as const))(
    '%s: 家族・究極モード・料理画像を言う文には、家族プランか有料プランの条件がある',
    (_name, Page) => {
      // タグを改行に置き換えて、見出しと本文を別の文として読む (見出しの語が隣の文の条件に紛れないように)
      const text = decodeEntities(stripAllTags(renderHtml(Page), '\n'));
      // 描画が空で素通りしないこと
      expect(text.trim().length).toBeGreaterThan(0);
      expect(unconditionedPaidSentences(text)).toEqual([]);
    },
  );

  it('文の検査が実際に条件の無い文を見つける (検査が空回りしない)', () => {
    expect(
      unconditionedPaidSentences('家族を招待して、献立を一緒に見たり、記録を共有したりできます。家族プランで家族を招待できます。\n究極モード\n有料プランでは、究極モードが使えます。'),
    ).toEqual(['家族を招待して、献立を一緒に見たり、記録を共有したりできます', '究極モード']);
  });
});
