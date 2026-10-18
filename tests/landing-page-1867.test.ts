// @vitest-environment node
/**
 * #1867 紹介ページ (/) の単体の番兵 (docs/design/marketing/01-landing-site.md §16.1 の U-1〜U-36)。
 *
 * 検査は、正典の部品の名前・トークンの名前・LANDING_COPY / LANDING_SCREENS / LANDING_ZOOMS の文言・区切りの id・ランドマークと役割・
 * アクセシブルな名前・data-* の印 (data-js・data-in・data-active・data-zoom-lens) だけを手がかりにする
 * (実装のクラス名や DOM の入れ子を手がかりにしない。設計書 R-14)。
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
  CHAPTER_IDS,
  CLAIM_IDS,
  COPYRIGHT_YEAR,
  DEMO_ANALYZING_MS,
  DEMO_ANALYZING_MS_REDUCED,
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
  NAV_KEYS,
  RING_MAX,
  SCENES_STRIP_LABEL,
  SCREENS_CAPTION,
  SECTION_IDS,
  SECTION_NAV_KEY,
  demoPraiseComment,
  demoScore,
  inPageSectionId,
  landingClaims,
  landingImagePaths,
  screenStripLabel,
} from '@/components/marketing/landing-copy';
import { LANDING_SCREENS, LANDING_ZOOMS, landingZoomBySrc } from '@/components/marketing/landing-screens';
import { countUpValue } from '@/components/marketing/count-up';
import { DEMO_INITIAL_STATE, demoReducer, selectedSampleId, type DemoState } from '@/components/marketing/demo-state';
import { storyActiveIndex } from '@/components/marketing/story-state';
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
// 物語 (StoryScroller) とヘッダー (SiteHeader) が useInViewIds に渡す id を記録する (U-30)。描画の結果はサーバーの描画と同じ (全部 false)
const inViewIdsCalls = vi.hoisted(() => [] as string[][]);
vi.mock('@/components/marketing/primitives/useInViewSteps', () => ({
  useInViewIds: (ids: ReadonlyArray<string>) => {
    inViewIdsCalls.push([...ids]);
    return ids.map(() => false);
  },
}));

const { LandingPage } = await import('@/components/marketing/LandingPage');
const { StorySection } = await import('@/components/marketing/sections/StorySection');
const { NutritionChapter } = await import('@/components/marketing/sections/NutritionChapter');
const { PhotoChapter } = await import('@/components/marketing/sections/PhotoChapter');

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

/** コメントを除く (行コメントと複数行コメント)。文字列の中の // は、このディレクトリのソースには無い (URL の :// は残す) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 値の中のすべての文字列 (claims を含む) */
function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => allStrings(item));
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap((item) => allStrings(item));
  return [];
}
const allCopyStrings = (): string[] => allStrings(LANDING_COPY);

/** 値の中の { src, alt } の組 (画像) */
function allImages(value: unknown): { src: string; alt: string }[] {
  if (Array.isArray(value)) return value.flatMap((item) => allImages(item));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const own = typeof record.src === 'string' && typeof record.alt === 'string' ? [{ src: record.src, alt: record.alt }] : [];
    return [...own, ...Object.values(record).flatMap((item) => allImages(item))];
  }
  return [];
}

const renderLanding = (): string => renderToStaticMarkup(createElement(LandingPage));

/** HTML の開始タグ (タグの名前・属性の文字列) */
function startTags(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>`, 'g'))].map((match) => match[1] ?? '');
}
const attribute = (attrs: string, name: string): string | undefined => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];

/** HTML の文字参照を戻す (aria-label などの比較用) */
function decodeEntities(text: string): string {
  // &amp; は最後に戻す (先に戻すと &amp;lt; が < まで二重に戻る。CodeQL js/double-escaping)
  return text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** 区切り (section) ごとの HTML (id → その section の中の HTML) */
function sectionsOf(html: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = html.split('<section ').slice(1);
  for (const part of parts) {
    const id = part.match(/^[^>]*\sid="([a-z]+)"|^id="([a-z]+)"/);
    const sectionId = id?.[1] ?? id?.[2];
    if (sectionId) sections.set(sectionId, part.slice(0, part.indexOf('</section>')));
  }
  return sections;
}

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

  it('U-3 claims の id は CLAIM_IDS の 46 個がちょうど 1 回ずつで、features の各カードの claimId と、要点・場面・料金の上限の claimIds は claims にある', () => {
    const CLAIM_COUNT = 46;
    const ids = landingClaims().map((claim) => claim.id);
    expect(CLAIM_IDS).toHaveLength(CLAIM_COUNT);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...CLAIM_IDS].sort());
    for (const card of LANDING_COPY.features.cards) {
      expect(ids, `カード ${card.id} の claimId`).toContain(card.claimId);
    }
    const referenced: { where: string; claimIds: readonly string[] }[] = [
      ...Object.values(LANDING_COPY.chapters).flatMap((chapter) => chapter.points.map((point) => ({ where: `章 ${chapter.id} の「${point.title}」`, claimIds: point.claimIds }))),
      ...LANDING_COPY.family.points.map((point) => ({ where: `家族の「${point.title}」`, claimIds: point.claimIds })),
      ...LANDING_COPY.org.points.map((point) => ({ where: `組織の「${point.title}」`, claimIds: point.claimIds })),
      ...LANDING_COPY.guide.points.map((point) => ({ where: `ガイドの「${point.title}」`, claimIds: point.claimIds })),
      ...LANDING_COPY.pricing.limits.map((limit) => ({ where: `料金の上限の「${limit.title}」`, claimIds: limit.claimIds })),
      ...LANDING_COPY.scenes.items.map((scene) => ({ where: `場面 ${scene.id}`, claimIds: scene.claimIds })),
    ];
    expect(referenced.length).toBeGreaterThan(0);
    for (const { where, claimIds } of referenced) {
      expect(claimIds.length, where).toBeGreaterThan(0);
      for (const claimId of claimIds) expect(ids, `${where} の ${claimId}`).toContain(claimId);
    }
  });

  it('U-4 landingImagePaths はすべて public/ に実在し、画面 (.png) は 540×1080 (拡大の画像は LANDING_ZOOMS の大きさ) で 300 KB 以下、写真 (.webp) は 120 KB 以下で、/marketing/screens/ のパスと alt は LANDING_SCREENS と LANDING_ZOOMS の和と両方向で一致する', () => {
    const PNG_SIGNATURE_BYTES = 8;
    const PNG_WIDTH_OFFSET = PNG_SIGNATURE_BYTES + 8;
    const PNG_HEIGHT_OFFSET = PNG_WIDTH_OFFSET + 4;
    const SCREEN_SIZE = { width: 540, height: 1080 };
    const SCREEN_MAX_BYTES = 300 * 1024;
    const PHOTO_MAX_BYTES = 120 * 1024;
    const EXPECTED_COUNTS = { total: 22, guide: 11, screens: 8, photos: 3 };
    const paths = landingImagePaths();
    expect(paths).toHaveLength(EXPECTED_COUNTS.total);
    expect(paths.filter((p) => p.startsWith('/guide/'))).toHaveLength(EXPECTED_COUNTS.guide);
    expect(paths.filter((p) => p.startsWith('/marketing/screens/'))).toHaveLength(EXPECTED_COUNTS.screens);
    expect(paths.filter((p) => p.startsWith('/marketing/photos/'))).toHaveLength(EXPECTED_COUNTS.photos);
    for (const imagePath of paths) {
      const full = path.join(ROOT, 'public', imagePath);
      expect(fs.existsSync(full), `${imagePath} が public/ に無い`).toBe(true);
      const bytes = fs.statSync(full).size;
      if (imagePath.endsWith('.png')) {
        const buffer = fs.readFileSync(full);
        const zoom = LANDING_ZOOMS.find((item) => item.src === imagePath);
        const expected = zoom ? { width: zoom.width, height: zoom.height } : SCREEN_SIZE;
        expect(buffer.readUInt32BE(PNG_WIDTH_OFFSET), `${imagePath} の幅`).toBe(expected.width);
        expect(buffer.readUInt32BE(PNG_HEIGHT_OFFSET), `${imagePath} の高さ`).toBe(expected.height);
        expect(bytes, `${imagePath} の重さ`).toBeLessThanOrEqual(SCREEN_MAX_BYTES);
      } else {
        expect(bytes, `${imagePath} の重さ`).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
      }
    }
    // /marketing/screens/ の画像 (src と alt) の集合 = LANDING_SCREENS と LANDING_ZOOMS の和の集合 (両方向)
    const key = (image: { src: string; alt: string }) => `${image.src}\t${image.alt}`;
    const inCopy = new Set(allImages(LANDING_COPY).filter((image) => image.src.startsWith('/marketing/screens/')).map(key));
    const canonical = new Set([...LANDING_SCREENS, ...LANDING_ZOOMS].map(key));
    expect([...inCopy].sort()).toEqual([...canonical].sort());
  });

  it('U-5 実際の画面の alt は guide-content.ts の同じ画像の imageAlt と同じ文', () => {
    const altByImage = new Map(GUIDES.flatMap((guide) => guide.steps.map((step) => [step.image as string, step.imageAlt] as const)));
    const screens = [
      ...LANDING_COPY.hero.screens,
      ...LANDING_COPY.story.steps.map((step) => step.image),
      ...LANDING_COPY.features.cards.flatMap((card) => (card.image ? [card.image] : [])),
      ...Object.values(LANDING_COPY.chapters).flatMap((chapter) => chapter.screens.map((screen) => screen.image)),
      ...LANDING_COPY.guide.screens.map((screen) => screen.image),
    ].filter((image) => image.src.startsWith('/guide/'));
    const MIN_GUIDE_IMAGES_CHECKED = 20;
    expect(screens.length).toBeGreaterThanOrEqual(MIN_GUIDE_IMAGES_CHECKED);
    for (const image of screens) {
      expect(altByImage.get(image.src), `${image.src} がガイドに無い`).toBeDefined();
      expect(image.alt, image.src).toBe(altByImage.get(image.src));
    }
  });

  it('U-6 バッジ 4 つの code は AWARDABLE_BADGE_CODES にあり、name は badges の migration の同じ code の行の name と同じで、first_bite・streak_3・streak_7 の description は「完了」を含み、tutorial_complete の description は「案内」を含む', () => {
    const migration = read('supabase/migrations/20251126124224_create_meal_planner_tables.sql');
    const names = new Map<string, string>();
    for (const match of migration.matchAll(/INSERT INTO public\.badges \([^)]*\) VALUES \('[^']*', '([^']*)', '([^']*)'/g)) {
      names.set(match[1], match[2]);
    }
    const items = LANDING_COPY.chapters.badges.items;
    const BADGE_COUNT = 4;
    expect(items).toHaveLength(BADGE_COUNT);
    for (const badge of items) {
      expect(AWARDABLE_BADGE_CODES as readonly string[], `${badge.code} は付与の処理がある一覧に無い`).toContain(badge.code);
      expect(names.get(badge.code), `${badge.code} の行が migration に無い`).toBeDefined();
      expect(badge.name, `${badge.code} の名前は DB の名前と同じ`).toBe(names.get(badge.code));
      const word = badge.code === 'tutorial_complete' ? '案内' : '完了';
      expect(badge.description, `${badge.code} の説明は付与の条件 (${word}) を言う`).toContain(word);
    }
    expect(items.map((badge) => badge.code)).toEqual(['first_bite', 'streak_3', 'streak_7', 'tutorial_complete']);
  });
});

// ─── U-7〜U-8: トークンとコントラスト ───

/** marketing.css の .lp の中の変数 (名前 → 値。最初に出てくる宣言) */
function lpVariables(): Map<string, string> {
  const css = stripComments(read('src/components/marketing/marketing.css'));
  const variables = new Map<string, string>();
  for (const match of css.matchAll(/(--lp-[a-z0-9-]+):\s*([^;]+);/g)) {
    if (!variables.has(match[1])) variables.set(match[1], match[2].trim());
  }
  return variables;
}

describe('#1867 紹介ページのトークン', () => {
  it('U-7 marketing.css の --lp-bg / --lp-bg-tint / --lp-surface / --lp-ink / --lp-accent / --lp-accent-soft / --lp-green / --lp-gold / --lp-blue は BRAND_COLORS の同じ色', () => {
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
      ['--lp-blue', BRAND_COLORS.blue],
    ];
    for (const [name, brand] of expected) {
      expect(variables.get(name)?.toLowerCase(), name).toBe(brand.toLowerCase());
    }
  });

  it('U-8 文字と下地の組み合わせ (§5.1 の表の不合格の行を除く 31 組) はすべて求める比を満たす', () => {
    const variables = lpVariables();
    type Rgb = [number, number, number];
    const toRgb = (hex: string): Rgb => {
      const clean = hex.replace('#', '');
      return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
    };
    const linear = (channel: number) => {
      const s = channel / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    const ratio = (a: Rgb, b: Rgb) => {
      const [la, lb] = [luminance(a), luminance(b)];
      const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
      return (lighter + 0.05) / (darker + 0.05);
    };
    const colour = (token: string): Rgb => {
      if (token.startsWith('#')) return toRgb(token);
      const value = variables.get(token);
      if (!value) throw new Error(`${token} が marketing.css に無い`);
      return toRgb(value);
    };
    // 黒 70 % の重ね (rgba(0, 0, 0, 0.7))。下の写真が最も明るい #FFFFFF のとき
    const OVERLAY_ALPHA = 0.7;
    const WHITE_CHANNEL = 255;
    const overlaid = Math.round(WHITE_CHANNEL * (1 - OVERLAY_ALPHA));
    const overlay: Rgb = [overlaid, overlaid, overlaid];
    const NORMAL = 4.5;
    const LARGE = 3;
    const pairs: [string, Rgb, Rgb, number][] = [
      ['ink on bg', colour('--lp-ink'), colour('--lp-bg'), NORMAL],
      ['ink on surface', colour('--lp-ink'), colour('--lp-surface'), NORMAL],
      ['ink on bg-tint', colour('--lp-ink'), colour('--lp-bg-tint'), NORMAL],
      ['ink on green-tint', colour('--lp-ink'), colour('--lp-green-tint'), NORMAL],
      ['ink on blue-tint', colour('--lp-ink'), colour('--lp-blue-tint'), NORMAL],
      ['ink-soft on bg', colour('--lp-ink-soft'), colour('--lp-bg'), NORMAL],
      ['ink-soft on surface', colour('--lp-ink-soft'), colour('--lp-surface'), NORMAL],
      ['ink-soft on bg-tint', colour('--lp-ink-soft'), colour('--lp-bg-tint'), NORMAL],
      ['ink-soft on green-tint', colour('--lp-ink-soft'), colour('--lp-green-tint'), NORMAL],
      ['ink-soft on blue-tint', colour('--lp-ink-soft'), colour('--lp-blue-tint'), NORMAL],
      ['accent-ink on surface', colour('--lp-accent-ink'), colour('--lp-surface'), NORMAL],
      ['accent-ink on bg', colour('--lp-accent-ink'), colour('--lp-bg'), NORMAL],
      ['accent-ink on bg-tint', colour('--lp-accent-ink'), colour('--lp-bg-tint'), NORMAL],
      ['accent-ink on green-tint', colour('--lp-accent-ink'), colour('--lp-green-tint'), NORMAL],
      ['accent-ink on blue-tint', colour('--lp-accent-ink'), colour('--lp-blue-tint'), NORMAL],
      ['blue-ink on blue-tint', colour('--lp-blue-ink'), colour('--lp-blue-tint'), NORMAL],
      ['blue-ink on surface', colour('--lp-blue-ink'), colour('--lp-surface'), NORMAL],
      ['blue-ink on bg', colour('--lp-blue-ink'), colour('--lp-bg'), NORMAL],
      ['white on ink', colour('#FFFFFF'), colour('--lp-ink'), NORMAL],
      ['white on blue-ink', colour('#FFFFFF'), colour('--lp-blue-ink'), NORMAL],
      ['white on green-ink', colour('#FFFFFF'), colour('--lp-green-ink'), NORMAL],
      ['green-ink on green-tint', colour('--lp-green-ink'), colour('--lp-green-tint'), NORMAL],
      ['green-ink on surface', colour('--lp-green-ink'), colour('--lp-surface'), NORMAL],
      ['green-ink on bg', colour('--lp-green-ink'), colour('--lp-bg'), NORMAL],
      ['on-dark on dark', colour('--lp-on-dark'), colour('--lp-dark'), NORMAL],
      ['on-dark-soft on dark', colour('--lp-on-dark-soft'), colour('--lp-dark'), NORMAL],
      ['on-dark-muted on dark', colour('--lp-on-dark-muted'), colour('--lp-dark'), NORMAL],
      ['dark on accent-soft', colour('--lp-dark'), colour('--lp-accent-soft'), NORMAL],
      ['white on 黒 70 % の重ね', colour('#FFFFFF'), overlay, NORMAL],
      ['h1 2 行目の終わり on bg (大きい文字)', colour('--lp-heading-accent-end'), colour('--lp-bg'), LARGE],
      ['h1 2 行目の終わり on bg-tint (大きい文字)', colour('--lp-heading-accent-end'), colour('--lp-bg-tint'), LARGE],
    ];
    const EXPECTED_PAIR_COUNT = 31;
    expect(pairs).toHaveLength(EXPECTED_PAIR_COUNT);
    for (const [label, foreground, background, required] of pairs) {
      expect(ratio(foreground, background), label).toBeGreaterThanOrEqual(required);
    }
  });
});

// ─── U-9〜U-10: 絵文字・import の範囲・島の本数 ───

describe('#1867 紹介ページのソースの決まり', () => {
  it('U-9 landing-copy.ts と landing-screens.ts のソースに絵文字 (Extended_Pictographic) が無い', () => {
    for (const file of ['src/components/marketing/landing-copy.ts', 'src/components/marketing/landing-screens.ts']) {
      expect(read(file), file).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it("U-10 src/components/marketing/ の import は許可した先だけで、'use client' を持つ .tsx のファイルは SiteHeader・DemoSection・Reveal・StoryScroller・ScoreRing・ReadingProgress の 6 本だけ", () => {
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
        const allowed = (allowedExact.has(from) || from.startsWith('.') || from.startsWith('@/components/marketing/')) && !from.includes('scripts/');
        if (!allowed) violations.push(`${file}: ${from}`);
      });
    }
    expect(violations).toEqual([]);

    const islands = marketingFiles(['.tsx']).filter((file) => /^\s*['"]use client['"]/.test(read(file)));
    expect(islands.map((file) => path.basename(file)).sort()).toEqual(
      ['DemoSection.tsx', 'ReadingProgress.tsx', 'Reveal.tsx', 'ScoreRing.tsx', 'SiteHeader.tsx', 'StoryScroller.tsx'].sort(),
    );
  });
});

// ─── U-11: デモの状態機械 ───

describe('#1867 デモの状態機械 (§13.3 の遷移表)', () => {
  const NOW = 100;
  const analyzing = (sampleId: 'salad-bowl' | 'salmon-plate' | 'pesto-pasta'): DemoState => ({ phase: 'analyzing', sampleId, startedAt: NOW });
  const result = (sampleId: 'salad-bowl' | 'salmon-plate' | 'pesto-pasta'): DemoState => ({ phase: 'result', sampleId });

  it('U-11 demoReducer は §13.3 のデモの遷移表の全行どおり', () => {
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
  it('U-12 構造化データは SiteStructuredData の 1 本だけ (src/components/marketing/ に <script・dangerouslySetInnerHTML・application/ld+json が無く、描画した HTML にも <script が無い)', () => {
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

  it('U-13 src/app/LandingPageView.tsx は無く、src/app/page.tsx は LandingPage・SiteStructuredData・LANDING_VIEWPORT_MAXIMUM_SCALE を import する', () => {
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

  it('U-14 LandingPage を描画した HTML に h1 が 1 つ・section が 18 (SECTION_IDS の順) あり、section はすべて tabindex="-1" を持ち、横にスクロールする帯の箱 (role="region" で tabindex="0") が 6 つで aria-label が §5.4 の 6 つの文と同じで、footer の中に 利用規約 と プライバシーポリシー のリンクがある', () => {
    const html = renderLanding();
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html.match(/<main[ >]/g)).toHaveLength(1);
    const sections = startTags(html, 'section');
    expect(sections.map((attrs) => attribute(attrs, 'id'))).toEqual([...SECTION_IDS]);
    for (const attrs of sections) expect(attribute(attrs, 'tabindex'), attribute(attrs, 'id')).toBe('-1');

    const regions = [...html.matchAll(/<[a-z]+\s[^>]*role="region"[^>]*>/g)].map((match) => match[0]);
    const STRIP_COUNT = 6;
    expect(regions).toHaveLength(STRIP_COUNT);
    for (const tag of regions) expect(attribute(tag, 'tabindex'), tag).toBe('0');
    const expectedLabels = [
      SCENES_STRIP_LABEL,
      screenStripLabel(LANDING_COPY.chapters.photo.eyebrow),
      screenStripLabel(LANDING_COPY.chapters.menu.eyebrow),
      screenStripLabel(LANDING_COPY.chapters.nutrition.eyebrow),
      screenStripLabel(LANDING_COPY.chapters.badges.eyebrow),
      screenStripLabel(LANDING_COPY.guide.eyebrow),
    ];
    expect(regions.map((tag) => decodeEntities(attribute(tag, 'aria-label') ?? '')).sort()).toEqual([...expectedLabels].sort());

    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
    expect(footer).toMatch(/<a href="\/terms"[^>]*>利用規約<\/a>/);
    expect(footer).toMatch(/<a href="\/privacy"[^>]*>プライバシーポリシー<\/a>/);
  });

  it('U-26 実際の画面を出す区切り (hero how features photo menu nutrition health badges chat family trust guide の 12) のそれぞれの中に SCREENS_CAPTION の文があり、LANDING_COPY の各 screensCaption は SCREENS_CAPTION と同じ', () => {
    const captions = [
      LANDING_COPY.hero.screensCaption,
      LANDING_COPY.story.screensCaption,
      LANDING_COPY.features.screensCaption,
      ...Object.values(LANDING_COPY.chapters).map((chapter) => chapter.screensCaption),
      LANDING_COPY.family.screensCaption,
      LANDING_COPY.trust.screensCaption,
      LANDING_COPY.guide.screensCaption,
    ];
    const SECTIONS_WITH_SCREENS = ['hero', 'how', 'features', 'photo', 'menu', 'nutrition', 'health', 'badges', 'chat', 'family', 'trust', 'guide'] as const;
    expect(captions).toHaveLength(SECTIONS_WITH_SCREENS.length);
    for (const caption of captions) expect(caption).toBe(SCREENS_CAPTION);
    const sections = sectionsOf(renderLanding());
    for (const id of SECTIONS_WITH_SCREENS) {
      expect(sections.get(id), `section#${id}`).toBeDefined();
      expect(sections.get(id), `section#${id} の画面の注記`).toContain(SCREENS_CAPTION);
    }
  });
});

// ─── U-15, U-19: メタ情報と viewport ───

/** §4.0 の書かない語 (U-15・U-20) */
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
  '確認してから実行',
  '実行するかは',
  'メンバー数だけ',
  'メンバーを分け',
  '部署に分け',
  'ランキング',
  '上位',
  '1位',
  '認識しやすく',
  '認識精度',
] as const;

describe('#1867 紹介ページの殻のメタ情報と viewport', () => {
  it("U-15 page.tsx の metadata は publicPageMetadata('/') と同じ値で、SITE_DESCRIPTION は v1.7 の文と同じ・50〜160 文字・書かない語を含まない", async () => {
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

  it('U-19 page.tsx の viewport は maximumScale 5 以上・userScalable true', async () => {
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
  it('U-16 footer の著作権の年は COPYRIGHT_YEAR で、new Date を使っていない', () => {
    expect(stripComments(read('src/components/marketing/landing-copy.ts'))).not.toContain('new Date');
    expect(stripComments(read('src/components/marketing/sections/SiteFooter.tsx'))).not.toContain('new Date');
    expect(LANDING_COPY.footer.copyrightYear).toBe(COPYRIGHT_YEAR);
    expect(renderLanding()).toContain(`© ${COPYRIGHT_YEAR} ほめゴハン`);
  });

  it('U-17 ログイン済みの人は / で紹介ページを見ない (resolveOnboardingRedirect)', () => {
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

  it('U-18 スクロールに連動する動きは無い: marketing.css と src/components/marketing/ に animation-timeline・scroll-timeline・view-timeline が無い', () => {
    const TIMELINE_WORD = /animation-timeline|scroll-timeline|view-timeline/;
    expect(stripComments(css)).not.toMatch(TIMELINE_WORD);
    for (const file of marketingFiles(['.ts', '.tsx'])) expect(stripComments(read(file)), file).not.toMatch(TIMELINE_WORD);
  });

  it('U-20 LANDING_COPY と LANDING_SCREENS と LANDING_ZOOMS のすべての文字列に §4.0 の書かない語 (ランキング・上位・1位・認識しやすく・認識精度・確認してから実行・実行するかは・メンバー数だけ・メンバーを分け・部署に分け を含む) が無く、marketing.css の動きの宣言は no-preference の中だけで、reduce の at-rule が無く、className に Tailwind の動きのクラスが無く、scroll-behavior の宣言が無い', () => {
    const strings = [...allCopyStrings(), ...allStrings(LANDING_SCREENS), ...allStrings(LANDING_ZOOMS)];
    expect(strings.length).toBeGreaterThan(0);
    const hits = strings.flatMap((text) => FORBIDDEN_WORDS.filter((word) => text.includes(word)).map((word) => `「${word}」: ${text.slice(0, 40)}`));
    expect(hits).toEqual([]);

    const declarations = cssDeclarations(css);
    const motion = declarations.filter((declaration) => MOTION_PROPERTY.test(declaration.property) && !declaration.ancestors.some((ancestor) => ancestor.startsWith('@keyframes')));
    expect(motion.length).toBeGreaterThan(0);
    const outside = motion.filter((declaration) => !declaration.ancestors.includes(NO_PREFERENCE_AT_RULE));
    expect(outside.map((declaration) => `${declaration.ancestors.join(' > ')} { ${declaration.property}: ${declaration.value} }`)).toEqual([]);
    expect(stripComments(css)).not.toContain('prefers-reduced-motion: reduce');
    expect(declarations.filter((declaration) => declaration.property === 'scroll-behavior')).toEqual([]);

    const tailwindMotion: string[] = [];
    for (const file of marketingFiles(['.tsx'])) {
      for (const token of classNameTokens(read(file))) if (TAILWIND_MOTION_CLASS.test(token)) tailwindMotion.push(`${file}: ${token}`);
    }
    expect(tailwindMotion).toEqual([]);
  });

  it('U-22 IntersectionObserver の判定は要素の高さに依らない: IntersectionObserver を作るのは useInViewOnce.ts と useInViewSteps.ts の 2 本だけで、どちらも threshold は 0', () => {
    const HOOKS = ['src/components/marketing/primitives/useInViewOnce.ts', 'src/components/marketing/primitives/useInViewSteps.ts'];
    const creators: string[] = [];
    for (const file of marketingFiles(['.ts', '.tsx'])) {
      const code = stripComments(read(file));
      if (/new IntersectionObserver/.test(code)) creators.push(file);
      if (!HOOKS.includes(file)) {
        expect(code, `${file} が IntersectionObserver / threshold に触れている`).not.toMatch(/IntersectionObserver|threshold/);
      }
    }
    expect(creators).toEqual(HOOKS);
    const ANY_INTERSECTION_THRESHOLD = '0';
    for (const file of HOOKS) {
      const hook = stripComments(read(file));
      const thresholdValues = [...hook.matchAll(/threshold:\s*([A-Za-z0-9_.]+)/g)].map((match) => match[1]);
      expect(thresholdValues, file).toHaveLength(1);
      const named = thresholdValues[0] === ANY_INTERSECTION_THRESHOLD ? ANY_INTERSECTION_THRESHOLD : hook.match(new RegExp(`const ${thresholdValues[0]}\\s*=\\s*([0-9.]+)`))?.[1];
      expect(named, file).toBe(ANY_INTERSECTION_THRESHOLD);
    }
  });

  it('U-23 自動で動き続けるものは高々 1 つ (infinite の宣言は 1 つ以下)', () => {
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

// ─── U-21, U-24, U-25, U-28: デモの見本・輪の値と主張の条件 ───

const NUTRITION_PIPELINE = read('supabase/functions/_shared/nutrition-pipeline.ts');

describe('#1867 デモの見本と輪の値はアプリと同じ', () => {
  it('U-21 デモの見本はアプリと同じ (87・91・85・ソースの式)', () => {
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

  it('動きを減らす設定のデモの待ち時間は 0 で (§6.1「JS の待ち時間は useReducedMotion() で 0 にする」)、通常の待ちより短い (押してから結果までの時間は e2e の E-7 が測る)', () => {
    expect(DEMO_ANALYZING_MS_REDUCED).toBe(0);
    expect(DEMO_ANALYZING_MS).toBeGreaterThan(DEMO_ANALYZING_MS_REDUCED);
  });

  it('U-24 「すべて無料」を含む LANDING_COPY の文字列 (3 つ) は、同じ文字列に「1 日にご利用いただける回数」を含む', () => {
    const withFree = allCopyStrings().filter((text) => text.includes('すべて無料'));
    const FREE_STRING_COUNT = 3;
    expect(withFree).toHaveLength(FREE_STRING_COUNT);
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

  it('U-28 スコアの輪の値は撮影の見本と同じ: chapters.nutrition.ring.value が GUIDE_MEAL_ANALYSIS.overallScore と同じで、demoScore({ kcal: totalCalories, proteinG: totalProtein, fiberG: nutrition.fiberG }) とも同じで、ring.note に 3 つの数値 (totalProtein・nutrition.fiberG・totalCalories) が入っている', () => {
    const analysis = GUIDE_MEAL_ANALYSIS;
    const ring = LANDING_COPY.chapters.nutrition.ring;
    expect(ring.value).toBe(analysis.overallScore);
    expect(ring.value).toBe(demoScore({ kcal: analysis.totalCalories, proteinG: analysis.totalProtein, fiberG: analysis.nutrition.fiberG }));
    expect(ring.note).toContain(`タンパク質 ${analysis.totalProtein} g`);
    expect(ring.note).toContain(`食物繊維 ${analysis.nutrition.fiberG} g`);
    expect(ring.note).toContain(`${analysis.totalCalories} kcal`);
  });
});

// ─── U-27, U-29〜U-36: ページの中のリンク・ガイド・物語・数字・輪・ナビ・拡大 ───

describe('#1867 紹介ページのページの中のリンクとナビ', () => {
  it('U-27 ページの中のリンクはすべて next/link: SiteHeader.tsx・HeroSection.tsx・FeaturesSection.tsx のソースに、href が # で始まる素の <a 要素が無く、Link (next/link か、next/link を描く CtaLink) を import している。LANDING_COPY の # で始まる href の先は SECTION_IDS にある', () => {
    const importsOf = (file: string): string[] => {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      const specifiers: string[] = [];
      source.forEachChild((node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
      });
      return specifiers;
    };
    expect(importsOf('src/components/marketing/primitives/CtaLink.tsx')).toContain('next/link');
    for (const name of ['SiteHeader', 'HeroSection', 'FeaturesSection']) {
      const file = `src/components/marketing/sections/${name}.tsx`;
      expect(stripComments(read(file)), file).not.toMatch(/<a\s[^>]*href=\{?["'`]#/);
      const imports = importsOf(file);
      expect(imports.includes('next/link') || imports.includes('../primitives/CtaLink'), `${file} が Link を import していない`).toBe(true);
    }
    const inPageHrefs = allStrings(LANDING_COPY).filter((text) => text.startsWith('#'));
    const EXPECTED_TARGETS = ['badges', 'chat', 'demo', 'family', 'faq', 'features', 'health', 'how', 'menu', 'nutrition', 'photo', 'pricing'];
    expect([...new Set(inPageHrefs.map((href) => href.slice(1)))].sort()).toEqual(EXPECTED_TARGETS);
    for (const href of inPageHrefs) expect(SECTION_IDS as readonly string[], href).toContain(href.slice(1));
  });

  it('U-33 SECTION_NAV_KEY は SECTION_IDS の全部を鍵に持ち、値は NAV_KEYS にあり、header.nav の key は NAV_KEYS と同じ順', () => {
    expect(Object.keys(SECTION_NAV_KEY).sort()).toEqual([...SECTION_IDS].sort());
    for (const id of SECTION_IDS) expect(NAV_KEYS as readonly string[], id).toContain(SECTION_NAV_KEY[id]);
    expect(LANDING_COPY.header.nav.map((item) => item.key)).toEqual([...NAV_KEYS]);
    for (const item of LANDING_COPY.header.nav) expect(item.href).toBe(`#${item.key}`);
  });

  it('U-34 機能のカードの href の先は章か家族の id で、同じ章を指すカードの claimId はその章の要点の claimIds に含まれる', () => {
    const pointsBySection = new Map<string, readonly string[]>([
      ...Object.values(LANDING_COPY.chapters).map((chapter) => [chapter.id, chapter.points.flatMap((point) => point.claimIds)] as const),
      ['family', LANDING_COPY.family.points.flatMap((point) => point.claimIds)] as const,
    ]);
    for (const card of LANDING_COPY.features.cards) {
      const target = inPageSectionId(card.href);
      expect(target, `カード ${card.id} の先`).not.toBeNull();
      expect([...CHAPTER_IDS, 'family'] as readonly string[], `カード ${card.id} の先 ${card.href}`).toContain(target);
      expect(pointsBySection.get(target ?? ''), `カード ${card.id} の ${card.claimId} が ${card.href} の要点に無い`).toContain(card.claimId);
    }
  });

  it('U-35 inPageSectionId は # と SECTION_IDS の id から id を返し、ほかは null で、LANDING_COPY の # で始まる href はすべて null でない', () => {
    expect(inPageSectionId('#pricing')).toBe('pricing');
    expect(inPageSectionId('#demo')).toBe('demo');
    expect(inPageSectionId('#main-content')).toBeNull();
    expect(inPageSectionId('#')).toBeNull();
    expect(inPageSectionId('/signup')).toBeNull();
    expect(inPageSectionId('pricing')).toBeNull();
    const hrefs = [
      ...LANDING_COPY.header.nav.map((item) => item.href),
      LANDING_COPY.hero.secondaryCta.href,
      ...LANDING_COPY.features.cards.map((card) => card.href),
    ];
    for (const href of hrefs) expect(inPageSectionId(href), href).not.toBeNull();
    for (const id of SECTION_IDS) expect(inPageSectionId(`#${id}`)).toBe(id);
  });
});

describe('#1867 紹介ページのガイド・物語・数字・輪・拡大', () => {
  it('U-29 ガイドの区切りの章の名前と手順の数は guide-content.ts の GUIDES と同じ (title から絵文字と空白を除いた文・steps.length)', () => {
    const fromGuide = GUIDES.map((guide) => ({ title: guide.title.replace(/\p{Extended_Pictographic}|️|\s/gu, ''), stepCount: guide.steps.length }));
    expect(LANDING_COPY.guide.chapters.map((chapter) => ({ title: chapter.title, stepCount: chapter.stepCount }))).toEqual(fromGuide);
  });

  it('U-30 storyActiveIndex は §13.3 の物語の遷移表の全行どおり: 1 つだけ交差 → その index・複数 → 最大の index・無し → current・current が範囲の外 → 0。StorySection の手順の li の id は how-step-1〜4 で、StoryScroller に渡す stepIds と同じ', () => {
    expect(storyActiveIndex([false, false, true, false], 0)).toBe(2);
    expect(storyActiveIndex([true, false, false, false], 3)).toBe(0);
    expect(storyActiveIndex([false, true, false, true], 0)).toBe(3);
    expect(storyActiveIndex([false, false, false, false], 2)).toBe(2);
    expect(storyActiveIndex([false, false, false, false], -1)).toBe(0);
    expect(storyActiveIndex([false, false, false, false], 4)).toBe(0);

    inViewIdsCalls.length = 0;
    const html = renderToStaticMarkup(createElement(StorySection));
    const EXPECTED_STEP_IDS = ['how-step-1', 'how-step-2', 'how-step-3', 'how-step-4'];
    const liIds = startTags(html, 'li').map((attrs) => attribute(attrs, 'id')).filter((id): id is string => id?.startsWith('how-step-') ?? false);
    expect(liIds).toEqual(EXPECTED_STEP_IDS);
    const storyCalls = inViewIdsCalls.filter((ids) => ids.some((id) => id.startsWith('how-step-')));
    expect(storyCalls.length).toBeGreaterThan(0);
    for (const ids of storyCalls) expect(ids).toEqual(EXPECTED_STEP_IDS);
    // 固定した端末の 4 枚の画像は手順の画面と同じファイル・同じ alt
    const imgAlts = startTags(html, 'img').map((attrs) => decodeEntities(attribute(attrs, 'alt') ?? ''));
    for (const step of LANDING_COPY.story.steps) {
      const STEP_IMAGE_COPIES = 2;
      expect(imgAlts.filter((alt) => alt === step.image.alt), step.image.src).toHaveLength(STEP_IMAGE_COPIES);
    }
  });

  it('U-31 countUpValue は 経過 0 で 0・経過 ≥ duration で target・duration 0 で target・target 0 以下で 0・経過に対して単調に非減少・常に整数で target 以下', () => {
    const TARGET = 89;
    const DURATION = 800;
    expect(countUpValue(TARGET, 0, DURATION)).toBe(0);
    expect(countUpValue(TARGET, DURATION, DURATION)).toBe(TARGET);
    expect(countUpValue(TARGET, DURATION * 2, DURATION)).toBe(TARGET);
    expect(countUpValue(TARGET, 0, 0)).toBe(TARGET);
    expect(countUpValue(TARGET, DURATION / 2, -1)).toBe(TARGET);
    expect(countUpValue(0, DURATION / 2, DURATION)).toBe(0);
    expect(countUpValue(-5, DURATION / 2, DURATION)).toBe(0);
    expect(countUpValue(TARGET, -10, DURATION)).toBe(0);
    const STEPS = 50;
    let previous = 0;
    for (let step = 0; step <= STEPS; step += 1) {
      const value = countUpValue(TARGET, (DURATION * step) / STEPS, DURATION);
      expect(Number.isInteger(value), `step ${step}`).toBe(true);
      expect(value, `step ${step}`).toBeGreaterThanOrEqual(previous);
      expect(value, `step ${step}`).toBeLessThanOrEqual(TARGET);
      previous = value;
    }
    expect(previous).toBe(TARGET);
    // 途中はまだ target に届かない (増えていく)
    expect(countUpValue(TARGET, DURATION / STEPS, DURATION)).toBeLessThan(TARGET);
  });

  it('U-32 ScoreRing を描画した HTML に、最後の値 (89) を持つ要素と、stroke-dashoffset が RING_MAX − value (11) の circle があり、数字の増え方の要素は aria-hidden', () => {
    const value = LANDING_COPY.chapters.nutrition.ring.value;
    const html = renderToStaticMarkup(createElement(NutritionChapter));
    const circles = startTags(html, 'circle');
    const offsets = circles.map((attrs) => attribute(attrs, 'stroke-dashoffset')).filter((offset): offset is string => offset !== undefined);
    expect(offsets).toEqual([String(RING_MAX - value)]);
    expect(circles.every((attrs) => attribute(attrs, 'pathLength') === String(RING_MAX) || attribute(attrs, 'pathlength') === String(RING_MAX))).toBe(true);
    // 見える数字 (aria-hidden) と、読み上げる最後の値 (aria-hidden でない) の 2 つ
    expect(html).toMatch(new RegExp(`<span aria-hidden="true">${value}</span>`));
    expect(html).toMatch(new RegExp(`<span(?![^>]*aria-hidden)[^>]*>${value}</span>`));
    // サーバーの描画では JS の印 (data-js・data-in) を付けない (§13.3 の server)
    expect(html).not.toContain('data-js');
    expect(html).not.toContain('data-in');
    // SVG は読み上げない
    expect(startTags(html, 'svg').every((attrs) => attribute(attrs, 'aria-hidden') === 'true')).toBe(true);
  });

  it('U-36 章の拡大は章 photo と章 menu の 2 つだけで、拡大の画像は LANDING_ZOOMS の画像で、切り出す元の画面がその章の画面にあり、章 photo の描画に拡大の画像と箱の印が 1 つずつある', () => {
    const withZoom = Object.values(LANDING_COPY.chapters).filter((chapter) => chapter.zoom !== null);
    expect(withZoom.map((chapter) => chapter.id)).toEqual(['photo', 'menu']);
    const expectedSrc: Record<string, string> = { photo: '/marketing/screens/zoom-photo.png', menu: '/marketing/screens/zoom-menu.png' };
    for (const chapter of withZoom) {
      const zoom = chapter.zoom;
      if (!zoom) continue;
      expect(zoom.image.src).toBe(expectedSrc[chapter.id]);
      const canonical = landingZoomBySrc(zoom.image.src);
      expect(canonical.alt).toBe(zoom.image.alt);
      expect(chapter.screens.map((screen) => screen.image.src), `${chapter.id} の拡大の元の画面`).toContain(`/guide/${canonical.source}.png`);
    }

    const photo = LANDING_COPY.chapters.photo;
    const zoom = photo.zoom;
    if (!zoom) throw new Error('章 photo の拡大が無い');
    const canonical = landingZoomBySrc(zoom.image.src);
    const html = renderToStaticMarkup(createElement(PhotoChapter));
    const zoomImages = startTags(html, 'img').filter((attrs) => decodeEntities(attribute(attrs, 'alt') ?? '') === zoom.image.alt);
    expect(zoomImages).toHaveLength(1);
    const lenses = [...html.matchAll(/<[a-z]+\s[^>]*data-zoom-lens[^>]*>/g)].map((match) => match[0]);
    expect(lenses).toHaveLength(1);
    const style = attribute(lenses[0], 'style') ?? '';
    expect(style.replace(/\s/g, '')).toContain(`aspect-ratio:${canonical.width}/${canonical.height}`);
    expect(html).toContain(zoom.label);
    expect(renderToStaticMarkup(createElement(NutritionChapter))).not.toContain('data-zoom-lens');
  });
});
