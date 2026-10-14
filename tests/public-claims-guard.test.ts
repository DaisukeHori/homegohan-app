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
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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

const { default: LandingPage } = await import('@/app/page');
const { default: AboutPage } = await import('@/app/about/page');
const { default: NewsPage } = await import('@/app/news/page');
const { default: CompanyPage } = await import('@/app/company/page');
const { default: LegalPage } = await import('@/app/legal/page');
const { default: PricingPage } = await import('@/app/pricing/page');
const { default: FaqPage } = await import('@/app/faq/page');

const ROOT = path.resolve(__dirname, '..');

/** 公開ページ (ログイン不要で誰でも見られる) */
const PUBLIC_PAGES: { file: string; Page: ComponentType }[] = [
  { file: 'src/app/page.tsx', Page: LandingPage },
  { file: 'src/app/about/page.tsx', Page: AboutPage },
  { file: 'src/app/news/page.tsx', Page: NewsPage },
  { file: 'src/app/company/page.tsx', Page: CompanyPage },
  { file: 'src/app/legal/page.tsx', Page: LegalPage },
  { file: 'src/app/pricing/page.tsx', Page: PricingPage },
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

  it('代表者・所在地・電話番号・メールアドレスは「準備中」と表示する', () => {
    for (const label of ['代表者', '所在地', '電話番号', 'メールアドレス']) {
      // 表の 1 行 = <th>ラベル</th><td>値</td>
      const row = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`).exec(renderHtml(LegalPage));
      expect(row, `「${label}」の行が無い`).not.toBeNull();
      expect(row![1].replace(/<[^>]*>/g, '').trim(), `「${label}」の値`).toBe(PENDING_NOTICE);
    }
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
    expect(source).toContain(PENDING_NOTICE);
    expect(source).toContain(PAID_PLAN_PENDING_NOTICE);
  });

  it('販売事業者名の行はそのまま残している (事業者名の扱いは別途決める)', () => {
    expect(text).toContain('株式会社ほめゴハン');
  });
});

describe('#1155 運営会社ページ (/company)', () => {
  const html = renderHtml(CompanyPage);
  const text = renderText(CompanyPage);

  it('チーム紹介・沿革は載せず、代表者・所在地は「準備中」と表示する', () => {
    expect(text).not.toContain('沿革');
    expect(text).not.toContain('チーム');
    expect(text).toContain(PENDING_NOTICE);
  });

  it('お問い合わせは /contact のフォームへ案内する', () => {
    expect(html).toContain('href="/contact"');
  });
});

describe('#1151 料金ページ (/pricing)', () => {
  const text = renderText(PricingPage);
  const source = readSource('src/app/pricing/page.tsx');

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

describe('#1155 FAQ (/faq とトップページの FAQ)', () => {
  const faq = readSource('src/app/faq/page.tsx');
  const landing = readSource('src/app/page.tsx');

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
