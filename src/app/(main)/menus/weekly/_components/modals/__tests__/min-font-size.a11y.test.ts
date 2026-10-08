// src/app/(main)/menus/weekly/_components/modals/__tests__/min-font-size.a11y.test.ts
// #1119 (1): 週間献立 (menus/weekly 配下) と推移グラフ (health/graphs) の極小フォント再発防止。
//
// #1052 では「主要情報/補足の個別判断と密グリッドの再検証が要る」として据え置かれた 8〜10px の文字を、
// #1119 で「主要情報 (栄養値・分量・達成率) は 12px、補足は最低 11px」にそろえた。
// 新しく書いたコードで 8〜10px (text-[9px] や fontSize: 10 など) が戻ってこないよう、
// ソースを走査して 11px 未満の指定があれば落とす。
//
// 8〜10px だけでなく 11px 未満をすべて検出する (text-[10.5px] や fontSize: 7 も同じ問題のため)。
// 走査の正規表現が壊れて素通りにならないよう、走査関数そのものも先に検証する。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** この大きさ (px) 未満を「極小」として検出する */
const MIN_FONT_SIZE_PX = 11;

// このファイルは weekly/_components/modals/__tests__ にある
const WEEKLY_DIR = path.resolve(__dirname, '../../..');
const GRAPHS_PAGE = path.resolve(WEEKLY_DIR, '../../health/graphs/page.tsx');
const REPO_SRC_ROOT = path.resolve(WEEKLY_DIR, '../../../..');

interface TinyFont {
  line: number;
  /** 見つかった記述そのまま (例: text-[9px] / fontSize: 10) */
  snippet: string;
  sizePx: number;
}

/**
 * コメントを空白に置き換える (改行は残すので行番号は変わらない)。
 * コメントの中の説明 (例: 「以前は text-[9px] だった」) を誤検知しないため。
 * 行コメントは "https://" のような URL の "//" を巻き込まないよう、直前が : や引用符・英数字のときは除く。
 */
function stripComments(source: string): string {
  const blanked = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return blanked.replace(/(^|[^:'"`\w])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

function toPx(value: string, unit: string | undefined): number {
  const n = Number(value);
  return unit === 'rem' ? n * 16 : n;
}

/** 11px 未満の文字サイズ指定を探す: Tailwind の text-[Npx] / style の fontSize / CSS の font-size */
function findTinyFonts(source: string): TinyFont[] {
  const code = stripComments(source);
  const found: TinyFont[] = [];

  const patterns: { regex: RegExp; value: number; unit: number }[] = [
    // text-[9px] / sm:text-[0.6rem] など (Tailwind の任意値)
    { regex: /text-\[(\d+(?:\.\d+)?)(px|rem)\]/g, value: 1, unit: 2 },
    // fontSize: 9 / fontSize: '9px' / fontSize={10} / fontSize="10" (React の style と SVG の属性)
    { regex: /fontSize\s*[:=]\s*\{?\s*(['"]?)(\d+(?:\.\d+)?)(px|rem)?\1/g, value: 2, unit: 3 },
    // font-size: 9px (CSS 文字列)
    { regex: /font-size\s*:\s*(\d+(?:\.\d+)?)(px|rem)/g, value: 1, unit: 2 },
  ];

  for (const { regex, value, unit } of patterns) {
    for (const match of code.matchAll(regex)) {
      const sizePx = toPx(match[value], match[unit]);
      if (sizePx >= MIN_FONT_SIZE_PX) continue;
      const line = code.slice(0, match.index).split('\n').length;
      found.push({ line, snippet: match[0], sizePx });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('極小フォントの走査 (この下のファイル検査が素通りにならないことの確認)', () => {
  it.each([
    ['<span className="text-[8px]">', 8],
    ['<p className="text-[9px] mt-1">', 9],
    ['<p className="text-[10px]">', 10],
    ['className="px-2 text-[10.5px]"', 10.5],
    ['className="sm:text-[9px]"', 9],
    ['className="text-[0.6rem]"', 9.6],
    ['<span style={{ fontSize: 9, color: c }}>', 9],
    ['<span style={{ fontSize: 10 }}>', 10],
    ['<span style={{ fontSize:8 }}>', 8],
    ["<span style={{ fontSize: '10px' }}>", 10],
    ['<text fontSize={10} fill="x">', 10],
    ['<text fontSize="10" fill="x">', 10],
    ['const css = `font-size: 9px;`', 9],
  ])('検出する: %s', (source, expectedPx) => {
    const found = findTinyFonts(source);
    expect(found).toHaveLength(1);
    expect(found[0].sizePx).toBeCloseTo(expectedPx, 5);
  });

  it.each([
    '<span className="text-[11px]">',
    '<span className="text-[12px] text-[#FF8A65]">',
    '<span className="text-xs text-sm text-lg">',
    '<span className="text-[length:var(--x)]">',
    '<span className="text-[0.6875rem]">',
    '<span style={{ fontSize: 11 }}>',
    '<span style={{ fontSize: 12, fontWeight: 600 }}>',
    "<span style={{ fontSize: '14px' }}>",
    '<text fontSize={CHART_FONT_SIZE}>',
    '<span style={{ lineHeight: 1.4, margin: 10 }}>',
    'const css = `font-size: 12px;`',
  ])('検出しない: %s', (source) => {
    expect(findTinyFonts(source)).toEqual([]);
  });

  it('コメント内の記述は無視する (ブロック・行・JSX のコメント)', () => {
    const source = [
      '// 以前は text-[9px] だった',
      '{/* fontSize: 10 から 12 に変更 */}',
      '/* text-[8px]',
      '   fontSize: 9 */',
      'const url = "https://example.com/text-[9px]"; // fontSize: 10',
    ].join('\n');
    // 文字列リテラル中の URL は走査対象 (コメントではない) なので 1 件だけ残る
    expect(findTinyFonts(source).map((f) => f.snippet)).toEqual(['text-[9px]']);
  });

  it('行番号を返す (コメントを消しても行はずれない)', () => {
    const source = ['/* a', '   b */', '<p className="ok">', '<p className="text-[9px]">'].join('\n');
    expect(findTinyFonts(source)[0].line).toBe(4);
  });
});

describe('極小フォントの再発防止 (#1119): 8〜10px を含む 11px 未満の文字サイズを使わない', () => {
  const files = [...collectSourceFiles(WEEKLY_DIR), GRAPHS_PAGE];
  const rel = (file: string) => path.relative(REPO_SRC_ROOT, file);

  it('検査対象に weekly 配下と推移グラフが含まれる (パスの取り違えで素通りしないための前提条件)', () => {
    const names = files.map(rel);
    expect(files.length).toBeGreaterThan(20);
    expect(names).toContain('app/(main)/menus/weekly/page.tsx');
    expect(names).toContain('app/(main)/menus/weekly/_components/modals/StatsModal.tsx');
    expect(names).toContain('app/(main)/menus/weekly/_components/modals/NutritionDetailModal.tsx');
    expect(names).toContain('app/(main)/menus/weekly/request/page.tsx');
    expect(names).toContain('app/(main)/health/graphs/page.tsx');
    // テストファイル自身は検査しない
    expect(names.some((n) => n.includes('__tests__'))).toBe(false);
  });

  it.each(files.map((file) => [rel(file), file]))('%s に 11px 未満の文字サイズが無い', (_name, file) => {
    const found = findTinyFonts(fs.readFileSync(file, 'utf-8'));
    expect(
      found,
      `${_name} に ${MIN_FONT_SIZE_PX}px 未満の文字サイズがあります: ` +
        found.map((f) => `${f.line} 行目 ${f.snippet} (${f.sizePx}px)`).join(' / ') +
        ` — 主要情報 (栄養値・分量・達成率・日付・期限) は 12px (text-xs / fontSize: 12)、` +
        `補足は最低 11px (text-[11px] / fontSize: 11) にすること (#1119)`,
    ).toEqual([]);
  });
});
