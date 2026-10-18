// @vitest-environment node
/**
 * #1867 紹介ページ (/) の単体の番兵 (docs/design/marketing/01-landing-site.md §16.1 の U-1〜U-26)。
 *
 * 検査は、正典の部品の名前・トークンの名前・LANDING_COPY の文言・セクションの id・ランドマークと役割だけを手がかりにする
 * (実装のクラス名や DOM の入れ子を手がかりにしない。設計書 R-15)。
 * 公開の主張 (FORBIDDEN) の走査は tests/public-claims-guard.test.ts、殻のメタ情報と JSON-LD は tests/seo-public-pages-1867.test.tsx が受け持つ。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { GUIDES } from '@/app/guide/guide-content';
import {
  CLAIM_IDS,
  COPYRIGHT_YEAR,
  DEMO_MEAL_TYPE_LABELS,
  DEMO_PHOTO_NAME_MAX_CHARS,
  DEMO_PRAISE_DISH_SEPARATOR,
  DEMO_PRAISE_DISH_SUFFIX,
  DEMO_PRAISE_END,
  DEMO_PRAISE_MAX_DISHES,
  DEMO_PRAISE_MEAL_PHRASE,
  DEMO_PRAISE_RECORD_PHRASE,
  DEMO_SCORE_BASE,
  DEMO_SCORE_FIBER_CAP,
  DEMO_SCORE_FIBER_FACTOR,
  DEMO_SCORE_KCAL_IN_RANGE,
  DEMO_SCORE_KCAL_OUT_OF_RANGE,
  DEMO_SCORE_KCAL_RANGE_MAX,
  DEMO_SCORE_KCAL_RANGE_MIN,
  DEMO_SCORE_MAX,
  DEMO_SCORE_MIN,
  DEMO_SCORE_PROTEIN_CAP,
  DEMO_SCORE_PROTEIN_DIVISOR,
  EVIDENCE_PATH_PATTERN,
  LANDING_COPY,
  LANDING_VIEWPORT_MAXIMUM_SCALE,
  LandingCopySchema,
  SCREENS_CAPTION,
  demoPraiseComment,
  demoScore,
  landingClaims,
  landingImagePaths,
} from '@/components/marketing/landing-copy';
import { DEMO_INITIAL_STATE, demoReducer, selectedSampleId, type DemoState } from '@/components/marketing/demo-state';
import { AWARDABLE_BADGE_CODES } from '@/lib/badges/awardable';
import { BRAND_COLORS } from '@/lib/brand-image';
import { publicPageMetadata, SITE_DESCRIPTION } from '@/lib/seo/public-pages';
import { resolveOnboardingRedirect } from '@/lib/onboarding-routing';
import { GUIDE_MEAL_ANALYSIS } from '../scripts/guide-screenshots/meal-analysis-mock';

// next/link と next/image は描画に Next.js の実行環境を要らないよう、素の a / img に置き換える (tests/public-claims-guard.test.ts と同じ)
vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, className: rest.className as string | undefined }, children),
  };
});
vi.mock('next/image', async () => {
  const react = await import('react');
  return {
    default: ({ src, alt, className }: { src: string; alt: string; className?: string }) => react.createElement('img', { src, alt, className }),
  };
});
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));

const { LandingPage } = await import('@/components/marketing/LandingPage');

const ROOT = process.cwd();
const MARKETING_DIR = path.join(ROOT, 'src/components/marketing');

const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** src/components/marketing/ の下の .ts / .tsx / .css (リポジトリの直下からのパス) */
function marketingFiles(extensions: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) found.push(path.relative(ROOT, full));
    }
  };
  walk(MARKETING_DIR);
  return found.sort();
}

/** コメントを除く (行コメントと複数行コメント)。文字列の中の // は、このディレクトリのソースには無い */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** LANDING_COPY のすべての文字列 (claims を含む) */
function allCopyStrings(value: unknown = LANDING_COPY): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => allCopyStrings(item));
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap((item) => allCopyStrings(item));
  return [];
}

const renderLanding = (): string => renderToStaticMarkup(createElement(LandingPage));

// ─── U-1〜U-6: 文言・主張・画像・バッジ ───

describe('#1867 紹介ページの文言と主張の表', () => {
  it('U-1 LANDING_COPY は LandingCopySchema を通る (文言の長さ・画像のパスの形・リンクの形・主張の根拠のパスの形・件数)', () => {
    expect(() => LandingCopySchema.parse(LANDING_COPY)).not.toThrow();
  });

  it('U-2 claims の evidence のパスはすべてリポジトリに実在する (ディレクトリは末尾 /、ファイルはそのまま)', () => {
    const missing: string[] = [];
    for (const claim of landingClaims()) {
      for (const evidence of claim.evidence) {
        expect(evidence, `${claim.id}: 根拠のパスの形`).toMatch(EVIDENCE_PATH_PATTERN);
        const full = path.join(ROOT, evidence);
        const exists = fs.existsSync(full);
        const isDirectoryPath = evidence.endsWith('/');
        if (!exists || (isDirectoryPath && !fs.statSync(full).isDirectory()) || (!isDirectoryPath && !fs.statSync(full).isFile())) {
          missing.push(`${claim.id}: ${evidence}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('U-3 claims の id は CLAIM_IDS の 17 個がちょうど 1 回ずつで、features の各カードの claimId は claims にある', () => {
    const ids = landingClaims().map((claim) => claim.id);
    expect(CLAIM_IDS).toHaveLength(17);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...CLAIM_IDS].sort());
    for (const card of LANDING_COPY.features.cards) {
      expect(ids, `カード ${card.id} の claimId`).toContain(card.claimId);
    }
  });

  it('U-4 landingImagePaths はすべて public/ に実在し、ガイドの画像 (.png) は 540×1080、写真 (.webp) は 120 KB 以下', () => {
    const PNG_SIGNATURE_BYTES = 8;
    const PNG_WIDTH_OFFSET = PNG_SIGNATURE_BYTES + 8;
    const PNG_HEIGHT_OFFSET = PNG_WIDTH_OFFSET + 4;
    const PHOTO_MAX_BYTES = 120 * 1024;
    const paths = landingImagePaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const imagePath of paths) {
      const full = path.join(ROOT, 'public', imagePath);
      expect(fs.existsSync(full), `${imagePath} が public/ に無い`).toBe(true);
      if (imagePath.endsWith('.png')) {
        const buffer = fs.readFileSync(full);
        expect(buffer.readUInt32BE(PNG_WIDTH_OFFSET), `${imagePath} の幅`).toBe(540);
        expect(buffer.readUInt32BE(PNG_HEIGHT_OFFSET), `${imagePath} の高さ`).toBe(1080);
      } else {
        expect(fs.statSync(full).size, `${imagePath} の重さ`).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
      }
    }
  });

  it('U-5 実際の画面の alt は guide-content.ts の同じ画像の imageAlt と同じ文', () => {
    const altByImage = new Map(GUIDES.flatMap((guide) => guide.steps.map((step) => [step.image as string, step.imageAlt] as const)));
    const screens = [
      ...LANDING_COPY.hero.screens,
      ...LANDING_COPY.how.steps.map((step) => step.image),
      ...LANDING_COPY.features.cards.flatMap((card) => (card.image ? [card.image] : [])),
    ].filter((image) => image.src.startsWith('/guide/'));
    expect(screens.length).toBeGreaterThan(0);
    for (const image of screens) {
      expect(altByImage.get(image.src), `${image.src} がガイドに無い`).toBeDefined();
      expect(image.alt, image.src).toBe(altByImage.get(image.src));
    }
  });

  it('U-6 バッジ 4 つの code は AWARDABLE_BADGE_CODES にあり、name は badges の migration の同じ code の行の name と同じで、description は同じ行の description と同じでない', () => {
    const migration = read('supabase/migrations/20251126124224_create_meal_planner_tables.sql');
    const rows = new Map<string, { name: string; description: string }>();
    for (const match of migration.matchAll(/INSERT INTO public\.badges \([^)]*\) VALUES \('[^']*', '([^']*)', '([^']*)', '([^']*)'/g)) {
      rows.set(match[1], { name: match[2], description: match[3] });
    }
    expect(LANDING_COPY.badges.items).toHaveLength(4);
    for (const badge of LANDING_COPY.badges.items) {
      expect(AWARDABLE_BADGE_CODES as readonly string[], `${badge.code} は付与の処理がある一覧に無い`).toContain(badge.code);
      const row = rows.get(badge.code);
      expect(row, `${badge.code} の行が migration に無い`).toBeDefined();
      expect(badge.name, `${badge.code} の名前は DB の名前と同じ`).toBe(row?.name);
      expect(badge.description, `${badge.code} の説明は DB の文を写さない (付与の条件を言う紹介ページの文)`).not.toBe(row?.description);
    }
  });
});

// ─── U-7〜U-8: トークンとコントラスト ───

/** marketing.css の .lp の中の変数 (名前 → 値) */
function lpVariables(): Map<string, string> {
  const css = stripComments(read('src/components/marketing/marketing.css'));
  const variables = new Map<string, string>();
  for (const match of css.matchAll(/(--lp-[a-z0-9-]+):\s*([^;]+);/g)) variables.set(match[1], match[2].trim());
  return variables;
}

describe('#1867 紹介ページのトークン', () => {
  it('U-7 marketing.css の --lp-bg / --lp-bg-tint / --lp-surface / --lp-ink / --lp-accent / --lp-accent-soft / --lp-green / --lp-gold は BRAND_COLORS の同じ色', () => {
    const variables = lpVariables();
    const expected: [string, string][] = [
      ['--lp-bg', BRAND_COLORS.background],
      ['--lp-bg-tint', BRAND_COLORS.backgroundGradientEnd],
      ['--lp-surface', BRAND_COLORS.white],
      ['--lp-ink', BRAND_COLORS.text],
      ['--lp-accent', BRAND_COLORS.accent],
      ['--lp-accent-soft', BRAND_COLORS.accentGradientEnd],
      ['--lp-green', BRAND_COLORS.green],
      ['--lp-gold', BRAND_COLORS.sparkle],
    ];
    for (const [name, brand] of expected) {
      expect(variables.get(name)?.toLowerCase(), name).toBe(brand.toLowerCase());
    }
  });

  it('U-8 文字と下地の組み合わせ (§5.1 の表の不合格の行を除く 21 組) はすべて求める比を満たす', () => {
    const variables = lpVariables();
    const toRgb = (hex: string): [number, number, number] => {
      const clean = hex.replace('#', '');
      return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
    };
    const linear = (channel: number) => {
      const s = channel / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    const ratio = (a: [number, number, number], b: [number, number, number]) => {
      const [la, lb] = [luminance(a), luminance(b)];
      const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
      return (lighter + 0.05) / (darker + 0.05);
    };
    const colour = (token: string): [number, number, number] => {
      if (token.startsWith('#')) return toRgb(token);
      const value = variables.get(token);
      if (!value) throw new Error(`${token} が marketing.css に無い`);
      return toRgb(value);
    };
    // 黒 70 % の重ね (rgba(0, 0, 0, 0.7))。下の写真が最も明るい #FFFFFF のとき
    const OVERLAY_ALPHA = 0.7;
    const WHITE_CHANNEL = 255;
    const overlaid = Math.round(WHITE_CHANNEL * (1 - OVERLAY_ALPHA));
    const overlay: [number, number, number] = [overlaid, overlaid, overlaid];
    const NORMAL = 4.5;
    const LARGE = 3;
    const pairs: [string, [number, number, number], [number, number, number], number][] = [
      ['ink on bg', colour('--lp-ink'), colour('--lp-bg'), NORMAL],
      ['ink on surface', colour('--lp-ink'), colour('--lp-surface'), NORMAL],
      ['ink on bg-tint', colour('--lp-ink'), colour('--lp-bg-tint'), NORMAL],
      ['ink-soft on bg', colour('--lp-ink-soft'), colour('--lp-bg'), NORMAL],
      ['ink-soft on surface', colour('--lp-ink-soft'), colour('--lp-surface'), NORMAL],
      ['ink-soft on bg-tint', colour('--lp-ink-soft'), colour('--lp-bg-tint'), NORMAL],
      ['accent-ink on surface', colour('--lp-accent-ink'), colour('--lp-surface'), NORMAL],
      ['accent-ink on bg', colour('--lp-accent-ink'), colour('--lp-bg'), NORMAL],
      ['accent-ink on bg-tint', colour('--lp-accent-ink'), colour('--lp-bg-tint'), NORMAL],
      ['white on ink', colour('#FFFFFF'), colour('--lp-ink'), NORMAL],
      ['green-ink on green-tint', colour('--lp-green-ink'), colour('--lp-green-tint'), NORMAL],
      ['ink on green-tint', colour('--lp-ink'), colour('--lp-green-tint'), NORMAL],
      ['on-dark on dark', colour('--lp-on-dark'), colour('--lp-dark'), NORMAL],
      ['on-dark-soft on dark', colour('--lp-on-dark-soft'), colour('--lp-dark'), NORMAL],
      ['on-dark-muted on dark', colour('--lp-on-dark-muted'), colour('--lp-dark'), NORMAL],
      ['dark on accent-soft', colour('--lp-dark'), colour('--lp-accent-soft'), NORMAL],
      ['white on 黒 70 % の重ね', colour('#FFFFFF'), overlay, NORMAL],
      ['h1 2 行目の始まり on bg (大きい文字)', colour('--lp-accent-ink'), colour('--lp-bg'), LARGE],
      ['h1 2 行目の終わり on bg (大きい文字)', colour('--lp-heading-accent-end'), colour('--lp-bg'), LARGE],
      ['h1 2 行目の始まり on bg-tint (大きい文字)', colour('--lp-accent-ink'), colour('--lp-bg-tint'), LARGE],
      ['h1 2 行目の終わり on bg-tint (大きい文字)', colour('--lp-heading-accent-end'), colour('--lp-bg-tint'), LARGE],
    ];
    const EXPECTED_PAIR_COUNT = 21;
    expect(pairs).toHaveLength(EXPECTED_PAIR_COUNT);
    for (const [label, foreground, background, required] of pairs) {
      expect(ratio(foreground, background), label).toBeGreaterThanOrEqual(required);
    }
  });
});

// ─── U-9〜U-10: 絵文字・import の範囲 ───

describe('#1867 紹介ページのソースの決まり', () => {
  it('U-9 landing-copy.ts のソースに絵文字 (Unicode の Extended_Pictographic) が無い', () => {
    expect(read('src/components/marketing/landing-copy.ts')).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('U-10 src/components/marketing/ の import は許可した先だけ (Supabase・@/lib/env・next/headers などを読まない)', () => {
    const allowedExact = new Set([
      'react',
      'next/link',
      'next/image',
      'lucide-react',
      'framer-motion',
      'zod',
      '@/lib/site-config',
      '@/app/guide/guide-content',
      '@/components/handson-tour/useReducedMotion',
      './marketing.css',
    ]);
    const violations: string[] = [];
    for (const file of marketingFiles(['.ts', '.tsx'])) {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      source.forEachChild((node) => {
        const isImport = ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined);
        if (!isImport) return;
        const specifier = (node as ts.ImportDeclaration | ts.ExportDeclaration).moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) return;
        const from = specifier.text;
        const allowed = allowedExact.has(from) || from.startsWith('.') || from.startsWith('@/components/marketing/');
        if (!allowed) violations.push(`${file}: ${from}`);
      });
    }
    expect(violations).toEqual([]);
  });
});

// ─── U-11: デモの状態機械 ───

describe('#1867 デモの状態機械 (§13.3 の遷移表)', () => {
  const NOW = 100;
  const analyzing = (sampleId: 'salad-bowl' | 'salmon-plate' | 'pesto-pasta'): DemoState => ({ phase: 'analyzing', sampleId, startedAt: NOW });
  const result = (sampleId: 'salad-bowl' | 'salmon-plate' | 'pesto-pasta'): DemoState => ({ phase: 'result', sampleId });

  it('U-11 demoReducer は §13.3 のデモの遷移表の全行どおり (「変化なし」は同じ参照を返す) で、selectedSampleId は idle で null・analyzing と result で sampleId', () => {
    // idle + select(id) → analyzing(id)
    expect(demoReducer(DEMO_INITIAL_STATE, { type: 'select', sampleId: 'salad-bowl', now: NOW })).toEqual(analyzing('salad-bowl'));
    // idle + finish(any) → idle (変化なし。同じ参照)
    expect(demoReducer(DEMO_INITIAL_STATE, { type: 'finish', sampleId: 'salad-bowl' })).toBe(DEMO_INITIAL_STATE);
    // analyzing(id) + select(any) → 変化なし
    const busy = analyzing('salad-bowl');
    expect(demoReducer(busy, { type: 'select', sampleId: 'pesto-pasta', now: NOW + 1 })).toBe(busy);
    expect(demoReducer(busy, { type: 'select', sampleId: 'salad-bowl', now: NOW + 1 })).toBe(busy);
    // analyzing(id) + finish(同じ id) → result(id)
    expect(demoReducer(busy, { type: 'finish', sampleId: 'salad-bowl' })).toEqual(result('salad-bowl'));
    // analyzing(id) + finish(違う id) → 変化なし (古いタイマー)
    expect(demoReducer(busy, { type: 'finish', sampleId: 'salmon-plate' })).toBe(busy);
    // result(id) + select(id2) → analyzing(id2) (id2 は id と同じでもよい)
    const done = result('salad-bowl');
    expect(demoReducer(done, { type: 'select', sampleId: 'salmon-plate', now: NOW + 2 })).toEqual({ phase: 'analyzing', sampleId: 'salmon-plate', startedAt: NOW + 2 });
    expect(demoReducer(done, { type: 'select', sampleId: 'salad-bowl', now: NOW + 3 })).toEqual({ phase: 'analyzing', sampleId: 'salad-bowl', startedAt: NOW + 3 });
    // result(id) + finish(any) → 変化なし (同じ参照)
    expect(demoReducer(done, { type: 'finish', sampleId: 'salad-bowl' })).toBe(done);
    expect(demoReducer(done, { type: 'finish', sampleId: 'pesto-pasta' })).toBe(done);
    // any + reset → idle (idle・analyzing・result の 3 つから)
    for (const from of [DEMO_INITIAL_STATE, busy, done]) {
      expect(demoReducer(from, { type: 'reset' })).toEqual(DEMO_INITIAL_STATE);
    }
    // selectedSampleId
    expect(selectedSampleId(DEMO_INITIAL_STATE)).toBeNull();
    expect(selectedSampleId(busy)).toBe('salad-bowl');
    expect(selectedSampleId(done)).toBe('salad-bowl');
  });
});

// ─── U-12〜U-14, U-26: ページの骨格 ───

describe('#1867 紹介ページの骨格', () => {
  it('U-12 構造化データは SiteStructuredData の 1 本だけ: src/components/marketing/ のソースに application/ld+json・dangerouslySetInnerHTML・<script が無く、LandingPage を描画した HTML にも <script が無い', () => {
    for (const file of marketingFiles(['.ts', '.tsx', '.css'])) {
      const source = read(file);
      expect(source, `${file} に application/ld+json`).not.toContain('application/ld+json');
      expect(source, `${file} に dangerouslySetInnerHTML`).not.toContain('dangerouslySetInnerHTML');
      expect(source, `${file} に <script`).not.toContain('<script');
      expect(source, `${file} に next/script`).not.toContain('next/script');
      expect(source, `${file} に innerHTML`).not.toContain('innerHTML');
    }
    expect(renderLanding()).not.toContain('<script');
  });

  it('U-13 src/app/LandingPageView.tsx は無く、src/app/page.tsx は LandingPage・SiteStructuredData・LANDING_VIEWPORT_MAXIMUM_SCALE を import し、./LandingPageView を import しない', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/app/LandingPageView.tsx'))).toBe(false);
    const source = ts.createSourceFile('page.tsx', read('src/app/page.tsx'), ts.ScriptTarget.Latest, true);
    const imported = new Map<string, string[]>();
    source.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
      const names: string[] = [];
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.push(element.name.text);
      if (node.importClause?.name) names.push(node.importClause.name.text);
      imported.set(node.moduleSpecifier.text, names);
    });
    expect(imported.get('@/components/marketing/LandingPage')).toContain('LandingPage');
    expect(imported.get('@/components/marketing/landing-copy')).toContain('LANDING_VIEWPORT_MAXIMUM_SCALE');
    expect(imported.get('@/components/seo/SiteStructuredData')).toContain('SiteStructuredData');
    expect([...imported.keys()].filter((from) => from.includes('LandingPageView'))).toEqual([]);
  });

  it('U-14 LandingPage を描画した HTML に h1 が 1 つ・section が 8 つ (hero how demo features badges trust faq cta) の id の順にあり、footer の中に 利用規約 と プライバシーポリシー のリンク (href /terms・/privacy) がある', () => {
    const html = renderLanding();
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    const sectionIds = [...html.matchAll(/<section id="([a-z]+)"/g)].map((match) => match[1]);
    expect(sectionIds).toEqual(['hero', 'how', 'demo', 'features', 'badges', 'trust', 'faq', 'cta']);
    expect(html.match(/<main[ >]/g)).toHaveLength(1);
    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
    expect(footer).toMatch(/<a href="\/terms"[^>]*>利用規約<\/a>/);
    expect(footer).toMatch(/<a href="\/privacy"[^>]*>プライバシーポリシー<\/a>/);
  });

  it('U-26 実際の画面を出すセクション (hero・how・features) のそれぞれの中に SCREENS_CAPTION の文があり、LANDING_COPY の screensCaption は SCREENS_CAPTION と同じ', () => {
    expect(LANDING_COPY.hero.screensCaption).toBe(SCREENS_CAPTION);
    expect(LANDING_COPY.how.screensCaption).toBe(SCREENS_CAPTION);
    expect(LANDING_COPY.features.screensCaption).toBe(SCREENS_CAPTION);
    const html = renderLanding();
    const sections = html.split('<section id="').slice(1);
    for (const id of ['hero', 'how', 'features']) {
      const section = sections.find((chunk) => chunk.startsWith(`${id}"`));
      expect(section, `section#${id}`).toBeDefined();
      expect(section, `section#${id} の画面の注記`).toContain(SCREENS_CAPTION);
    }
  });
});

// ─── U-15, U-19: メタ情報と viewport ───

const FORBIDDEN_WORDS = [
  'たびに',
  '毎回',
  '何度でも',
  '無制限',
  '使い放題',
  'いちばん',
  '一番',
  '最高',
  '最新',
  '完全',
  '必ず',
  '絶対',
  'No.1',
  '日本一',
  '世界一',
  '痩せ',
  '効果',
  '治る',
  '予防',
  '続きます',
  'ダメ出しはしません',
] as const;

describe('#1867 紹介ページの殻のメタ情報と viewport', () => {
  it('U-15 page.tsx の metadata は publicPageMetadata(/) と同じ値で、SITE_DESCRIPTION は §9.4 の文と同じ・50〜160 文字・「次世代」と §4.0 の書かない語を含まない', async () => {
    const { metadata } = await import('@/app/page');
    expect(metadata).toEqual(publicPageMetadata('/'));
    expect(SITE_DESCRIPTION).toBe(
      '写真を撮るだけで、AI が料理を認識して栄養を推定し、その記録をほめてくれる食事記録アプリ。1週間の献立の提案、買い物リスト、体重や健康診断の記録まで。いまは無料で使えます。',
    );
    const DESCRIPTION_MIN_CHARS = 50;
    const DESCRIPTION_MAX_CHARS = 160;
    expect([...SITE_DESCRIPTION].length).toBeGreaterThanOrEqual(DESCRIPTION_MIN_CHARS);
    expect([...SITE_DESCRIPTION].length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
    expect(SITE_DESCRIPTION).not.toContain('次世代');
    for (const word of FORBIDDEN_WORDS) expect(SITE_DESCRIPTION, word).not.toContain(word);
  });

  it('U-19 page.tsx の viewport は maximumScale が LANDING_VIEWPORT_MAXIMUM_SCALE (5 以上) で userScalable が true (ルートの layout の viewport は変えていない)', async () => {
    const { viewport } = await import('@/app/page');
    const MINIMUM_ALLOWED_MAXIMUM_SCALE = 5;
    expect(LANDING_VIEWPORT_MAXIMUM_SCALE).toBeGreaterThanOrEqual(MINIMUM_ALLOWED_MAXIMUM_SCALE);
    expect(viewport).toEqual({ maximumScale: LANDING_VIEWPORT_MAXIMUM_SCALE, userScalable: true });
    const layout = read('src/app/layout.tsx');
    expect(layout).toMatch(/maximumScale:\s*1,/);
    expect(layout).toMatch(/userScalable:\s*false/);
  });
});

describe('#1867 紹介ページの日付・ログイン済みの振り分け', () => {
  it('U-16 footer の著作権の年は COPYRIGHT_YEAR で、Date を使って年を作っていない (landing-copy.ts と SiteFooter.tsx に new Date が無い)', () => {
    expect(stripComments(read('src/components/marketing/landing-copy.ts'))).not.toContain('new Date');
    expect(stripComments(read('src/components/marketing/sections/SiteFooter.tsx'))).not.toContain('new Date');
    expect(LANDING_COPY.footer.copyrightYear).toBe(COPYRIGHT_YEAR);
    expect(renderLanding()).toContain(`© ${COPYRIGHT_YEAR} ほめゴハン`);
  });

  it('U-17 ログイン済みの人は / で紹介ページを見ない: resolveOnboardingRedirect の pathname / は、完了 → /home・途中 → /onboarding/resume・まだ → /onboarding/welcome・運営ロール → /admin を返し、null を返す組み合わせが無い', () => {
    const STARTED_AT = '2026-10-01T00:00:00.000Z';
    const COMPLETED_AT = '2026-10-02T00:00:00.000Z';
    expect(resolveOnboardingRedirect({ pathname: '/', onboardingStartedAt: STARTED_AT, onboardingCompletedAt: COMPLETED_AT })).toBe('/home');
    expect(resolveOnboardingRedirect({ pathname: '/', onboardingStartedAt: STARTED_AT, onboardingCompletedAt: null })).toBe('/onboarding/resume');
    expect(resolveOnboardingRedirect({ pathname: '/', onboardingStartedAt: null, onboardingCompletedAt: null })).toBe('/onboarding/welcome');
    for (const role of ['admin', 'super_admin']) {
      expect(resolveOnboardingRedirect({ pathname: '/', roles: [role] })).toBe('/admin');
    }
    for (const roles of [undefined, null, [], ['user'], ['admin'], ['super_admin']]) {
      for (const onboardingStartedAt of [undefined, null, STARTED_AT]) {
        for (const onboardingCompletedAt of [undefined, null, COMPLETED_AT]) {
          expect(resolveOnboardingRedirect({ pathname: '/', roles, onboardingStartedAt, onboardingCompletedAt })).not.toBeNull();
        }
      }
    }
  });
});

// ─── U-18, U-20, U-22, U-23: 動き ───

type CssNode = { kind: 'decl'; property: string; value: string; ancestors: string[] };

/** コメントを除いた CSS の宣言を、囲んでいる規則の前置き (セレクターと at-rule の行) の並びつきで取り出す。postcss は直接の依存に無いので、{ } ; をたどる */
function cssDeclarations(css: string): CssNode[] {
  const source = stripComments(css);
  const declarations: CssNode[] = [];
  const stack: string[] = [];
  let buffer = '';
  const flushDeclaration = () => {
    const text = buffer.trim();
    buffer = '';
    if (!text) return;
    const colon = text.indexOf(':');
    if (colon === -1) return;
    declarations.push({ kind: 'decl', property: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim(), ancestors: [...stack] });
  };
  for (const char of source) {
    if (char === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (char === '}') {
      flushDeclaration();
      stack.pop();
    } else if (char === ';') {
      flushDeclaration();
    } else {
      buffer += char;
    }
  }
  return declarations;
}

const NO_PREFERENCE_AT_RULE = '@media (prefers-reduced-motion: no-preference)';
const MOTION_PROPERTY = /^(?:animation|animation-[a-z-]+|transition|transition-[a-z-]+)$/;
/** Tailwind の動きのクラス (接頭辞つき・任意の値を含む) */
const TAILWIND_MOTION_CLASS = /^(?:[a-z0-9-]+:|\[[^\]]*\]:)*(?:animate|transition|duration|delay|ease)(?:-|$)/;

/** className の値 (文字列・波括弧の式) の中の文字列リテラルを、空白で割ったもの */
function classNameTokens(source: string): string[] {
  const tokens: string[] = [];
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{((?:[^{}]|\{[^{}]*\})*)\})/g)) {
    const expression = match[1] ?? match[2] ?? '';
    const literals = match[1] !== undefined ? [match[1]] : [...expression.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((literal) => literal[1] ?? literal[2] ?? literal[3] ?? '');
    for (const literal of literals) tokens.push(...literal.split(/\s+/).filter(Boolean));
  }
  return tokens;
}

describe('#1867 紹介ページの動き', () => {
  const css = read('src/components/marketing/marketing.css');

  it('U-18 スクロールに連動する動きは無い: marketing.css に animation-timeline・scroll-timeline・view-timeline の宣言が無く、src/components/marketing/ の .ts / .tsx にもその語が無い', () => {
    const TIMELINE_WORD = /animation-timeline|scroll-timeline|view-timeline/;
    expect(stripComments(css)).not.toMatch(TIMELINE_WORD);
    for (const file of marketingFiles(['.ts', '.tsx'])) expect(stripComments(read(file)), file).not.toMatch(TIMELINE_WORD);
  });

  it('U-20 LANDING_COPY のすべての文字列に §4.0 の書かない語が無く、動きの宣言は no-preference の中だけで、reduce の at-rule が無く、className に Tailwind の動きのクラスが無い', () => {
    const strings = allCopyStrings();
    expect(strings.length).toBeGreaterThan(0);
    const hits = strings.flatMap((text) => FORBIDDEN_WORDS.filter((word) => text.includes(word)).map((word) => `「${word}」: ${text.slice(0, 40)}`));
    expect(hits).toEqual([]);

    const motion = cssDeclarations(css).filter((declaration) => MOTION_PROPERTY.test(declaration.property) && !declaration.ancestors.some((ancestor) => ancestor.startsWith('@keyframes')));
    expect(motion.length).toBeGreaterThan(0);
    const outside = motion.filter((declaration) => !declaration.ancestors.includes(NO_PREFERENCE_AT_RULE));
    expect(outside.map((declaration) => `${declaration.ancestors.join(' > ')} { ${declaration.property}: ${declaration.value} }`)).toEqual([]);
    expect(stripComments(css)).not.toContain('prefers-reduced-motion: reduce');

    const tailwindMotion: string[] = [];
    for (const file of marketingFiles(['.tsx'])) {
      for (const token of classNameTokens(read(file))) if (TAILWIND_MOTION_CLASS.test(token)) tailwindMotion.push(`${file}: ${token}`);
    }
    expect(tailwindMotion).toEqual([]);
  });

  it('U-22 IntersectionObserver の判定は要素の高さに依らない: IntersectionObserver を作るのは useInViewOnce.ts だけで、その threshold は 0 (割合でない)', () => {
    const creators: string[] = [];
    for (const file of marketingFiles(['.ts', '.tsx'])) {
      const code = stripComments(read(file));
      if (/new IntersectionObserver/.test(code)) creators.push(file);
      if (!file.endsWith('useInViewOnce.ts')) {
        expect(code, `${file} が IntersectionObserver / threshold に触れている`).not.toMatch(/IntersectionObserver|threshold/);
      }
    }
    expect(creators).toEqual(['src/components/marketing/primitives/useInViewOnce.ts']);
    const hook = stripComments(read('src/components/marketing/primitives/useInViewOnce.ts'));
    const thresholdValues = [...hook.matchAll(/threshold:\s*([A-Za-z0-9_.]+)/g)].map((match) => match[1]);
    expect(thresholdValues).toHaveLength(1);
    const ANY_INTERSECTION_THRESHOLD = '0';
    const named = thresholdValues[0] === ANY_INTERSECTION_THRESHOLD ? ANY_INTERSECTION_THRESHOLD : hook.match(new RegExp(`const ${thresholdValues[0]}\\s*=\\s*([0-9.]+)`))?.[1];
    expect(named).toBe(ANY_INTERSECTION_THRESHOLD);
    expect(hook).toContain('REVEAL_ROOT_MARGIN');
  });

  it('U-23 自動で動き続けるものは高々 1 つ: marketing.css の宣言 (@keyframes の中を除く) のうち、animation か animation-iteration-count の値に infinite を含むものは 1 つ以下', () => {
    const infinite = cssDeclarations(css).filter(
      (declaration) =>
        (declaration.property === 'animation' || declaration.property === 'animation-iteration-count') &&
        declaration.value.includes('infinite') &&
        !declaration.ancestors.some((ancestor) => ancestor.startsWith('@keyframes')),
    );
    const MOST_INFINITE_ANIMATIONS = 1;
    expect(infinite.length).toBeLessThanOrEqual(MOST_INFINITE_ANIMATIONS);
  });
});

// ─── U-21, U-24, U-25: デモの見本と主張の条件 ───

const NUTRITION_PIPELINE = read('supabase/functions/_shared/nutrition-pipeline.ts');

describe('#1867 デモの見本はアプリと同じ', () => {
  it('U-21 各見本の demoPraiseComment と demoScore が §4.5 の表の文と値 (87・91・85) と同じで、どのスコアも範囲内で、nutrition-pipeline.ts のソースに §4.5 の「ソースの文字列」がすべてある', () => {
    const expected: Record<string, { score: number; comment: string }> = {
      'salad-bowl': { score: 87, comment: 'サラダボウルの記録がしっかりできていて素晴らしいです。昼食を丁寧に残せていて、とても良い流れです。' },
      'salmon-plate': { score: 91, comment: '焼きサーモン、いんげんとミニトマトの記録がしっかりできていて素晴らしいです。夕食を丁寧に残せていて、とても良い流れです。' },
      'pesto-pasta': { score: 85, comment: 'バジルソースのパスタの記録がしっかりできていて素晴らしいです。昼食を丁寧に残せていて、とても良い流れです。' },
    };
    expect(LANDING_COPY.demo.samples.map((sample) => sample.id)).toEqual(Object.keys(expected));
    for (const sample of LANDING_COPY.demo.samples) {
      expect(demoScore(sample.nutrition), `${sample.id} のスコア`).toBe(expected[sample.id].score);
      expect(demoPraiseComment(sample), `${sample.id} の記録コメント`).toBe(expected[sample.id].comment);
      expect(demoScore(sample.nutrition)).toBeGreaterThanOrEqual(DEMO_SCORE_MIN);
      expect(demoScore(sample.nutrition)).toBeLessThanOrEqual(DEMO_SCORE_MAX);
      expect([...sample.name].length, `${sample.id} の名前の字数`).toBeLessThanOrEqual(DEMO_PHOTO_NAME_MAX_CHARS);
    }

    const sourceStrings = [
      `.slice(0, ${DEMO_PRAISE_MAX_DISHES})`,
      `.join('${DEMO_PRAISE_DISH_SEPARATOR}')`,
      `\${topDishes}${DEMO_PRAISE_DISH_SUFFIX}`,
      `${DEMO_PRAISE_RECORD_PHRASE}\${mealTypeJa}${DEMO_PRAISE_MEAL_PHRASE}`,
      ...DEMO_MEAL_TYPE_LABELS.map((label) => `'${label}'`),
      `Math.min(${DEMO_SCORE_PROTEIN_CAP}, totalNutrition.protein_g / ${DEMO_SCORE_PROTEIN_DIVISOR})`,
      `Math.min(${DEMO_SCORE_FIBER_CAP}, totalNutrition.fiber_g * ${DEMO_SCORE_FIBER_FACTOR})`,
      `totalNutrition.calories_kcal >= ${DEMO_SCORE_KCAL_RANGE_MIN} && totalNutrition.calories_kcal <= ${DEMO_SCORE_KCAL_RANGE_MAX} ? ${DEMO_SCORE_KCAL_IN_RANGE} : ${DEMO_SCORE_KCAL_OUT_OF_RANGE}`,
      `Math.max(${DEMO_SCORE_MIN}, Math.min(${DEMO_SCORE_MAX}, Math.round(${DEMO_SCORE_BASE} + proteinScore + fiberScore + caloriesScore)))`,
    ];
    for (const text of sourceStrings) {
      expect(NUTRITION_PIPELINE, `nutrition-pipeline.ts に「${text}」が無い (アプリの式か定型の文が変わった。デモを同じ PR で直す)`).toContain(text);
    }
  });

  it('U-24 「すべて無料」を含む LANDING_COPY の文字列は、同じ文字列に「1 日にご利用いただける回数」を含む', () => {
    const withFree = allCopyStrings().filter((text) => text.includes('すべて無料'));
    expect(withFree.length).toBeGreaterThanOrEqual(1);
    for (const text of withFree) expect(text, text.slice(0, 40)).toContain('1 日にご利用いただける回数');
  });

  it('U-25 撮影の見本の値はアプリが作れる値で、食事の写真の解析の画面 2 枚は撮り直してある', () => {
    const analysis = GUIDE_MEAL_ANALYSIS;
    expect(analysis.overallScore).toBe(
      demoScore({ kcal: analysis.totalCalories, proteinG: analysis.totalProtein, fiberG: analysis.nutrition.fiberG }),
    );

    // 記録コメント: 料理の名前の先頭 2 つと食事の区分で組み立てたアプリの定型の文。末尾の 1 文字はソースの「とても良い流れです」の直後の文字
    const endMatch = NUTRITION_PIPELINE.match(new RegExp(`${DEMO_PRAISE_MEAL_PHRASE}(.)`, 'u'));
    expect(endMatch, 'nutrition-pipeline.ts に「とても良い流れです」の文が無い').not.toBeNull();
    const appEnd = endMatch?.[1] ?? '';
    expect(appEnd).not.toBe(DEMO_PRAISE_END);
    const dishes = analysis.dishes.slice(0, DEMO_PRAISE_MAX_DISHES).map((dish) => dish.name).join(DEMO_PRAISE_DISH_SEPARATOR);
    const candidates = DEMO_MEAL_TYPE_LABELS.map(
      (label) => `${dishes}${DEMO_PRAISE_DISH_SUFFIX}${DEMO_PRAISE_RECORD_PHRASE}${label}${DEMO_PRAISE_MEAL_PHRASE}${appEnd}`,
    );
    expect(candidates).toContain(analysis.praiseComment);

    // 栄養メモ: ソースの定型の 3 つの文 (既定・タンパク質・食物繊維) のうち、分かれ目で選ばれる 1 つ
    const tips = [...NUTRITION_PIPELINE.matchAll(/nutritionTip = '([^']+)'/g)].map((match) => match[1]);
    expect(tips).toHaveLength(3);
    const PROTEIN_THRESHOLD = 25;
    const FIBER_THRESHOLD = 6;
    expect(NUTRITION_PIPELINE).toContain(`totalNutrition.protein_g >= ${PROTEIN_THRESHOLD}`);
    expect(NUTRITION_PIPELINE).toContain(`totalNutrition.fiber_g >= ${FIBER_THRESHOLD}`);
    const [defaultTip, proteinTip, fiberTip] = tips;
    const selected = analysis.totalProtein >= PROTEIN_THRESHOLD ? proteinTip : analysis.nutrition.fiberG >= FIBER_THRESHOLD ? fiberTip : defaultTip;
    expect(analysis.nutritionTip).toBe(selected);

    // 撮り直す前の画像 (origin/main e5ce8e65) の SHA-256 ではない
    const BEFORE_SHA256: Record<string, string> = {
      'comment.png': '1a23feb83e4a881b05d7b8c3b77e9537f72ca6015f46386b656de5c3a6a33dce',
      'analyze.png': '9b64b20a4cbeb53471f4395626a83639b1483bae5650e06fad2a6e7384ff5264',
    };
    for (const [file, before] of Object.entries(BEFORE_SHA256)) {
      const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'public/guide', file))).digest('hex');
      expect(digest, `${file} は撮り直す前の画像のまま`).not.toBe(before);
    }
  });
});
