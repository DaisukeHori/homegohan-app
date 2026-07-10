// #1058: 横断デザインシステム・共通基盤の整理 (重複コンポーネント統合 / デッドコード削除 / グローバル a11y)
//
// このリポジトリには @testing-library/react 等の DOM レンダリングテスト基盤が無く、
// vitest 側にも .tsx (JSX) 用の変換プラグインが未導入(tsconfig jsx=preserve をそのまま
// Vite の esbuild へ渡すため .tsx の import が軒並み失敗する。別 Issue 相当のテスト基盤課題で
// 本 Issue のスコープ外)なため、既存の *-contracts.test.ts 群と同様に
// readFileSync によるソース内容の静的検証で回帰を担保する。
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("#1058 デッドコード削除", () => {
  it("src/lib/schema.ts が削除されている (@/lib/schema の import 参照が0件だったため)", () => {
    expect(existsSync(path.join(root, "src/lib/schema.ts"))).toBe(false);
  });

  it("src/components/planning/** が削除されている (src から参照ゼロだったため)", () => {
    expect(existsSync(path.join(root, "src/components/planning"))).toBe(false);
  });

  it("リポジトリ全体に @/lib/schema からの import が残っていない", () => {
    const result = execSync(
      `grep -rn 'from "@/lib/schema"' --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=.next --exclude=design-system-1058.test.ts . || true`,
      { cwd: root, encoding: "utf8" },
    );
    expect(result.trim()).toBe("");
  });

  it("リポジトリ全体に components/planning への参照が残っていない", () => {
    const result = execSync(
      `grep -rln 'components/planning' --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=.next --exclude=design-system-1058.test.ts . || true`,
      { cwd: root, encoding: "utf8" },
    );
    expect(result.trim()).toBe("");
  });
});

describe("#1058 重複コンポーネント統合 (LoadingSpinner / PageHeader)", () => {
  it("src/components/common/LoadingSpinner.tsx が削除され ui/shared 版に一本化されている", () => {
    expect(existsSync(path.join(root, "src/components/common/LoadingSpinner.tsx"))).toBe(false);
    expect(existsSync(path.join(root, "src/components/ui/shared/LoadingSpinner.tsx"))).toBe(true);
  });

  it("src/components/common/PageHeader.tsx が削除され ui/shared 版に一本化されている", () => {
    expect(existsSync(path.join(root, "src/components/common/PageHeader.tsx"))).toBe(false);
    expect(existsSync(path.join(root, "src/components/ui/shared/PageHeader.tsx"))).toBe(true);
  });

  it("統合後の LoadingSpinner はハードコードされた hex ではなくデザイントークン (border-accent) を使う", () => {
    const source = read("src/components/ui/shared/LoadingSpinner.tsx");
    expect(source).toContain("border-accent");
    expect(source).not.toContain("#FF8A65");
  });

  it("統合後の PageHeader は旧 common 版の backUrl 機能を保持する (BackButton へ委譲)", () => {
    const source = read("src/components/ui/shared/PageHeader.tsx");
    expect(source).toMatch(/backUrl/);
    expect(source).toMatch(/BackButton\s+href=\{backUrl\}/);
  });

  it("統合後の BackButton は href 指定時に Link で遷移できる (common/PageHeader との重複を解消)", () => {
    const source = read("src/components/ui/shared/BackButton.tsx");
    expect(source).toMatch(/href\?:\s*string/);
    expect(source).toMatch(/from ["']next\/link["']/);
  });
});

describe("#1058 グローバル a11y 基盤", () => {
  it("<html lang=\"ja\"> が layout.tsx に存在する", () => {
    const source = read("src/app/layout.tsx");
    expect(source).toMatch(/<html\s+lang="ja"/);
  });

  it("layout.tsx にスキップリンクが存在する", () => {
    const source = read("src/app/layout.tsx");
    expect(source).toContain('href="#main-content"');
    expect(source).toContain('id="main-content"');
    expect(source).toContain("skip-link");
  });

  it("globals.css にグローバルな :focus-visible スタイルが存在する", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/:focus-visible\s*\{/);
  });

  it("globals.css が prefers-reduced-motion を尊重する", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("globals.css にスキップリンク用スタイルが存在する", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\.skip-link\s*\{/);
  });

  it("デザイントークンに font/contrast/hit-area の下限値が定義されている (#1050/#1051/#1052 が参照する想定)", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/--a11y-min-font-size:\s*14px/);
    expect(css).toMatch(/--a11y-min-contrast-normal:\s*4\.5/);
    expect(css).toMatch(/--a11y-min-tap-size:\s*44px/);
  });
});

describe("#1058 focus-visible / skip-link コントラスト修正 (WCAG 1.4.11 / AA)", () => {
  // WCAG 相対輝度 / コントラスト比の算出 (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance)
  const srgbToLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const relativeLuminance = ([r, g, b]: [number, number, number]) =>
    0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  const contrastRatio = (c1: [number, number, number], c2: [number, number, number]) => {
    const l1 = relativeLuminance(c1);
    const l2 = relativeLuminance(c2);
    const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (lighter + 0.05) / (darker + 0.05);
  };
  const hexToRgb = (hex: string): [number, number, number] => [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];

  const css = read("src/app/globals.css");

  const extractHex = (varName: string) => {
    const m = css.match(new RegExp(`--${varName}:\\s*#([0-9A-Fa-f]{6})`));
    if (!m) throw new Error(`--${varName} not found in globals.css`);
    return hexToRgb(m[1]);
  };
  const foreground = extractHex("foreground");
  const background = extractHex("background");
  const accent = extractHex("accent");
  const white: [number, number, number] = [255, 255, 255];
  // super-admin / operator/membership レイアウトの管理画面サイドバー背景 (bg-slate-900, Tailwind既定値)
  const slate900: [number, number, number] = [0x0f, 0x17, 0x2a];

  it(":focus-visible の outline が低コントラストな --accent ではなく --foreground を使う", () => {
    const block = css.match(/:focus-visible\s*\{[^}]*\}/)?.[0] ?? "";
    expect(block).toMatch(/outline:\s*2px solid var\(--foreground\)/);
    expect(block).not.toMatch(/var\(--accent\)/);
  });

  it(".skip-link の背景が低コントラストな --accent ではなく --foreground を使う", () => {
    const block = css.match(/\.skip-link\s*\{[^}]*\}/)?.[0] ?? "";
    expect(block).toMatch(/background:\s*var\(--foreground\)/);
    expect(block).not.toMatch(/var\(--accent\)/);
  });

  it("旧配色 (--accent on white) は WCAG 非テキストコントラスト 3:1 未達だったことを回帰確認する", () => {
    expect(contrastRatio(accent, white)).toBeLessThan(3);
  });

  it("--foreground は白背景に対し WCAG 1.4.11 (非テキスト 3:1) を満たす (focus-visible outline)", () => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(3);
  });

  it("--foreground は --accent 背景 (ボタン等) に対しても WCAG 1.4.11 (非テキスト 3:1) を満たす (focus-visible outline)", () => {
    expect(contrastRatio(foreground, accent)).toBeGreaterThanOrEqual(3);
  });

  it("白文字 on --foreground は WCAG AA 通常テキスト 4.5:1 を満たす (skip-link, 14px bold は large text 基準未満のため normal 基準で判定)", () => {
    expect(contrastRatio(white, foreground)).toBeGreaterThanOrEqual(4.5);
  });

  it("--foreground 単色は bg-slate-900 (#0f172a, 管理画面サイドバー) では WCAG 1.4.11 (非テキスト3:1) 未達であることを回帰確認する (2トーン化が必要な理由)", () => {
    expect(contrastRatio(foreground, slate900)).toBeLessThan(3);
  });

  it(":focus-visible に box-shadow の白リングが定義されている (bg-slate-900 サイドバーでの不可視化対策)", () => {
    const block = css.match(/:focus-visible\s*\{[^}]*\}/)?.[0] ?? "";
    expect(block).toMatch(/box-shadow:\s*0 0 0 6px #FFFFFF/i);
  });

  it("box-shadow の白リングは bg-slate-900 (#0f172a, 管理画面サイドバー) に対して WCAG 1.4.11 (非テキスト3:1) を満たす", () => {
    expect(contrastRatio(white, slate900)).toBeGreaterThanOrEqual(3);
  });

  it("2トーン構成により 白背景・アクセント背景・ダーク背景(#0f172a) の3面すべてで focus-visible インジケーターが 3:1 以上を確保する", () => {
    // 明るい背景 (白・アクセント) は内側の --foreground リングが担保
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(foreground, accent)).toBeGreaterThanOrEqual(3);
    // 暗い背景 (#0f172a) は外側の白リングが担保
    expect(contrastRatio(white, slate900)).toBeGreaterThanOrEqual(3);
  });
});
