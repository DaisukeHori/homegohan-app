/**
 * #1155 / #1366 法務ページ (特定商取引法に基づく表記・プライバシーポリシー・利用規約・運営会社) の事業者情報と、
 * プライバシーポリシーに書く AI の送信先
 *
 * 以前は、
 *   - 事業者名がページごとに食い違っていた (プライバシーポリシー =「Homegohan Inc.」、規約・特商法・運営会社 =「株式会社ほめゴハン」)
 *   - 特定商取引法の表記に、架空の代表者名・電話番号・所在地、のちに「準備中」の仮置きが残っていた
 *   - プライバシーポリシーの第三者提供に、AI の送信先として OpenAI と Google しか書かれていなかった
 *     (実際の送信先は、同意画面の一覧 AI_CONSENT_PROVIDERS の 5 社)
 * ので、次を確かめる。
 *   1. コード (テスト・コメントを除く) に旧い事業者名が残っていない
 *   2. 4 つのページが出す事業者名は src/lib/business-info.ts の BUSINESS_NAME の 1 種類だけ
 *   3. 特定商取引法の表記の各項目に、空欄・仮置き・ダミーの値が無い。所在地・メールアドレス・営業時間は business-info.ts の値
 *      (株式会社MHD医健の公開の会社情報。#1911)、電話番号は載せずに「請求があれば遅滞なく開示します」と書く
 *   4. プライバシーポリシーの AI の送信先の一覧が、同意を取る事業者の一覧 (= 実際の送信先。
 *      tests/ai-consent-provider-inventory.test.ts が突き合わせている) と一致する
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AI_CONSENT_PROVIDERS, AI_CONSENT_PROVIDER_INFO } from '@/lib/ai/consent-config';
import {
  BUSINESS_ADDRESS,
  BUSINESS_EMAIL,
  BUSINESS_HOURS,
  BUSINESS_NAME,
  BUSINESS_REPRESENTATIVE,
  PHONE_DISCLOSED_ON_REQUEST,
} from '@/lib/business-info';

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

const { default: LegalPage } = await import('@/app/legal/page');
const { default: PrivacyPage } = await import('@/app/privacy/page');
const { default: TermsPage } = await import('@/app/terms/page');
const { default: CompanyPage } = await import('@/app/company/page');

const ROOT = path.resolve(__dirname, '..');

/** 以前使っていた事業者名 (どれも正式名称ではない) */
const OLD_BUSINESS_NAMES = ['Homegohan Inc', 'Homegohan, Inc', '株式会社ほめゴハン', 'ほめゴハン株式会社'];

/** 旧名を探すディレクトリ (画面・メール・サーバー・モバイル・共有パッケージ) */
const SCAN_DIRS = ['src', 'lib', 'shared', 'packages', 'supabase/functions', 'apps/mobile/app', 'apps/mobile/src'];
/** テストのデータ (利用者の組織名の例として「株式会社ほめゴハン」を使っている) は対象外 */
const SKIP = /(__tests__|__mocks__|\.test\.|\.spec\.|node_modules|\/dist\/)/;

function listCodeFiles(dir: string): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const relPath = path.join(dir, entry.name);
    if (SKIP.test(relPath)) continue;
    if (entry.isDirectory()) out.push(...listCodeFiles(relPath));
    else if (/\.(ts|tsx|mjs|js|json|html)$/.test(entry.name)) out.push(relPath);
  }
  return out;
}

/** コメントを外す (コメントで旧名を例に挙げるのは構わない。画面やメールに出る文字列だけを見る) */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function renderHtml(Page: ComponentType): string {
  return renderToStaticMarkup(createElement(Page));
}

/** タグを空白に置き換えた本文 (表のセルどうしがつながって 1 つの名前に見えないように) */
function renderText(Page: ComponentType): string {
  return renderHtml(Page).replace(/<[^>]*>/g, ' ');
}

const LEGAL_PAGES: { url: string; Page: ComponentType }[] = [
  { url: '/legal', Page: LegalPage },
  { url: '/privacy', Page: PrivacyPage },
  { url: '/terms', Page: TermsPage },
  { url: '/company', Page: CompanyPage },
];

describe('#1155 事業者名は 1 種類だけ', () => {
  it('コード (テスト・コメントを除く) に旧い事業者名が残っていない', () => {
    const files = SCAN_DIRS.flatMap(listCodeFiles);
    // 走査の対象が空になって素通りしないこと (法務ページそのものが対象に入っている)
    expect(files).toContain(path.join('src', 'app', 'legal', 'page.tsx'));
    expect(files).toContain(path.join('src', 'app', 'privacy', 'page.tsx'));
    const found: string[] = [];
    for (const file of files) {
      const text = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      for (const name of OLD_BUSINESS_NAMES) if (text.includes(name)) found.push(`${file}: ${name}`);
    }
    expect(found).toEqual([]);
  });

  it.each(LEGAL_PAGES)('$url に出る事業者名は BUSINESS_NAME だけ', ({ Page }) => {
    const text = renderText(Page);
    expect(text).toContain(BUSINESS_NAME);
    // 「株式会社〇〇」「〇〇 Inc.」の形で出る名前をすべて拾い、正式名称以外が無いことを確かめる
    const companies = [...text.matchAll(/株式会社[^\s（(）)、。,，「」』『<]+/g)].map((m) => m[0]);
    expect(new Set(companies)).toEqual(new Set([BUSINESS_NAME]));
    expect(text).not.toMatch(/\b[A-Za-z]+,? Inc\b/);
  });
});

describe('#1155 特定商取引法に基づく表記 (/legal) に、空欄・仮置き・ダミーの値が無い', () => {
  const html = renderHtml(LegalPage);
  const rows = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => ({
    label: m[1].replace(/<[^>]*>/g, '').trim(),
    value: m[2].replace(/<[^>]*>/g, '').trim(),
  }));

  it('表が読み取れている (販売事業者・代表者・所在地・電話番号・メールアドレス・営業時間の行がある)', () => {
    const labels = rows.map((r) => r.label);
    for (const label of ['販売事業者', '代表者', '所在地', '電話番号', 'メールアドレス', '営業時間']) expect(labels).toContain(label);
  });

  it('代表者・所在地・メールアドレス・営業時間は business-info.ts の値、電話番号は「請求があれば遅滞なく開示します」と請求の窓口 (#1911)', () => {
    const value = (label: string) => rows.find((r) => r.label === label)?.value;
    expect(value('販売事業者')).toBe(BUSINESS_NAME);
    expect(value('代表者')).toBe(BUSINESS_REPRESENTATIVE);
    expect(value('所在地')).toBe(BUSINESS_ADDRESS);
    expect(value('メールアドレス')).toBe(BUSINESS_EMAIL);
    expect(value('メールアドレス')).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(value('営業時間')).toBe(BUSINESS_HOURS);
    expect(value('電話番号')).toBe(`${PHONE_DISCLOSED_ON_REQUEST}。ご請求は、${BUSINESS_EMAIL} またはお問い合わせフォームからお願いします。`);
  });

  it('運営会社 (/company) と特定商取引法の表記 (/legal) で、所在地・代表者・メールアドレス・営業時間・電話番号の欄が同じ値 (#1911)', () => {
    const companyHtml = renderHtml(CompanyPage);
    const companyRows = [...companyHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => ({
      label: m[1].replace(/<[^>]*>/g, '').trim(),
      value: m[2].replace(/<[^>]*>/g, '').trim(),
    }));
    const legalValue = (label: string) => rows.find((r) => r.label === label)?.value;
    const companyValue = (label: string) => companyRows.find((r) => r.label === label)?.value;
    for (const label of ['代表者', '所在地', 'メールアドレス', '営業時間', '電話番号']) {
      expect(companyValue(label), `/company の「${label}」`).toBeDefined();
      expect(companyValue(label), `「${label}」が /company と /legal で食い違う`).toBe(legalValue(label));
    }
  });

  it.each(['確定次第掲載', 'XXX', 'xxx', '○○', '〇〇', 'ダミー', 'TODO', '03-1234-5678', '山田 太郎', 'ほめゴハンビル'])(
    'どの項目にも「%s」が無い',
    (marker) => {
      for (const { label, value } of rows) expect(value, `「${label}」の値`).not.toContain(marker);
    },
  );

  it('空欄の項目が無い', () => {
    for (const { label, value } of rows) expect(value.length, `「${label}」が空`).toBeGreaterThan(0);
  });
});

describe('#1366 プライバシーポリシーの AI の送信先の一覧', () => {
  const html = renderHtml(PrivacyPage);
  const list = /<ul[^>]*data-testid="privacy-ai-providers"[^>]*>([\s\S]*?)<\/ul>/.exec(html);
  const items = list ? [...list[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]*>/g, '')) : [];

  it('同意を取る事業者 (AI_CONSENT_PROVIDERS) と同じ数・同じ順に並ぶ', () => {
    expect(list, '送信先の一覧が無い').not.toBeNull();
    expect(items).toHaveLength(AI_CONSENT_PROVIDERS.length);
    AI_CONSENT_PROVIDERS.forEach((id, i) => {
      const info = AI_CONSENT_PROVIDER_INFO[id];
      expect(items[i]).toContain(info.name);
      expect(items[i]).toContain(info.country);
      expect(items[i]).toContain(info.usage);
    });
  });

  it('Issue で名指しされた Perplexity・xAI・AIMLAPI (AI/ML API) が載っている', () => {
    for (const id of ['perplexity', 'xai', 'aimlapi'] as const) {
      expect(AI_CONSENT_PROVIDERS).toContain(id);
      expect(items.some((item) => item.includes(AI_CONSENT_PROVIDER_INFO[id].name))).toBe(true);
    }
  });

  it('事業者名をページに直接書かず、同意画面と同じ一覧から出している (片方だけ直して食い違わないように)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/app/privacy/page.tsx'), 'utf8');
    expect(source).toContain('AI_CONSENT_PROVIDERS');
    expect(source).toContain('AI_CONSENT_PROVIDER_INFO');
    expect(stripComments(source)).not.toMatch(/OpenAI 社|Google 社|Perplexity|xAI|AI\/ML API/);
  });
});
