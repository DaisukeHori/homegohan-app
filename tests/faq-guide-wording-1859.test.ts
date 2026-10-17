// @vitest-environment node
/**
 * #1859: よくある質問 (/faq) と使い方ガイド (/guide) の言葉が、今の画面の文言とずれないことの見張り
 *
 * 以前の /faq は「メニュー画面から「AIに献立を提案してもらう」をタップ」「予算や調理時間などの条件」と書いていたが、
 * 今の献立表の画面のボタンは「AI献立アシスタント」(空欄があるときは「AIに埋めてもらう」) で、
 * 条件の選択肢 (V4 のモーダル) に予算・調理時間は無い。使い方ガイドは #1852 で画面に合わせて直してあった。
 *
 *   1. 画面に無い言い回しが、FAQ とガイドに戻らないこと
 *   2. FAQ とガイドが「」で名前を挙げる画面の項目 (ボタン名など) が、画面のソースの文言に実在すること
 *   3. FAQ とガイドが挙げる献立の条件の名前が、条件の選択肢 (V4 のモーダル) に実在すること
 *
 * 画面の文言を変えたら、FAQ (src/app/faq/page.tsx) とガイド (src/app/guide/guide-content.ts) も見直す。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDES } from '@/app/guide/guide-content';

const ROOT = path.resolve(__dirname, '..');
const FAQ_FILE = 'src/app/faq/page.tsx';
const GUIDE_FILE = 'src/app/guide/guide-content.ts';
/** 献立の条件の選択肢 (Web の V4 のモーダル。モバイルの献立のタブは同じ Web の画面を WebView で出す) */
const V4_MODAL_FILE = 'src/components/ai-assistant/V4GenerateModal.tsx';

/** 画面のソースを探す場所 (FAQ とガイドそのもの・API・テストは除く) */
const SCREEN_SOURCE_DIRS = ['src/app', 'src/components', 'src/hooks', 'apps/mobile/app', 'apps/mobile/src'];
const SCREEN_SOURCE_EXCLUDED_DIRS = ['src/app/faq', 'src/app/guide', 'src/app/api', '__tests__', 'node_modules'];
const SCREEN_SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/**
 * FAQ の項目数の下限 (読み取りが空振りしていないことの確かめ。2026-10-17 時点で 28 項目)。
 * 項目を減らしたときはこの値も見直す
 */
const MIN_FAQ_ENTRY_COUNT = 20;

/** FAQ とガイドのどこにも書いてはいけない言い回しと、その理由 */
const FORBIDDEN_PHRASES: { text: string; reason: string }[] = [
  { text: 'AIに献立を提案してもらう', reason: '画面のボタンは「AI献立アシスタント」(空欄があるときは「AIに埋めてもらう」)' },
  { text: 'メニュー画面', reason: '献立の画面の名前は「献立」(ナビゲーション) / 「献立表」' },
];

/** 献立の話の中で書いてはいけない条件 (条件の選択肢に無い) */
const FORBIDDEN_MENU_CONDITIONS = ['予算', '調理時間'];

const readSource = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

interface FaqEntry {
  category: string;
  q: string;
  a: string;
}

/** FAQ のページのソースから、項目 (category・q・a) を読み取る */
function readFaqEntries(): { entries: FaqEntry[]; declaredCount: number } {
  const source = readSource(FAQ_FILE);
  const start = source.indexOf('const faqs = [');
  const end = source.indexOf('];', start);
  if (start < 0 || end < 0) throw new Error(`${FAQ_FILE} に const faqs = [ ... ]; が見つからない`);
  const block = source.slice(start, end);
  const entries = [...block.matchAll(/\{\s*category:\s*'([^']+)',\s*q:\s*'([^']*)',\s*a:\s*'([^']*)'\s*\}/g)].map(
    ([, category, q, a]) => ({ category, q, a }),
  );
  const declaredCount = [...block.matchAll(/category:\s*'/g)].length;
  return { entries, declaredCount };
}

/** ガイドの文 (章の題・手順の題・説明・画像の代替テキスト) */
function guideTexts(): { where: string; text: string }[] {
  return GUIDES.flatMap((guide) => [
    { where: `guide ${guide.id} の題`, text: guide.title },
    ...guide.steps.flatMap((step) => [
      { where: `guide ${guide.id}「${step.title}」の題`, text: step.title },
      { where: `guide ${guide.id}「${step.title}」の説明`, text: step.desc },
      { where: `guide ${guide.id}「${step.title}」の画像の代替テキスト`, text: step.imageAlt },
    ]),
  ]);
}

function faqTexts(entries: FaqEntry[]): { where: string; text: string }[] {
  return entries.flatMap((entry) => [
    { where: `faq「${entry.q}」の質問`, text: entry.q },
    { where: `faq「${entry.q}」の答え`, text: entry.a },
  ]);
}

/** 「」で囲んだ名前をすべて取り出す */
function quotedNames(text: string): string[] {
  return [...text.matchAll(/「([^「」]+)」/g)].map(([, name]) => name);
}

/** コメント (ブロックと行) を取り除く。コメントにだけ書かれた言葉を「画面の文言」と数えないため */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function listSourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const result: string[] = [];
  for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, dirent.name);
    if (SCREEN_SOURCE_EXCLUDED_DIRS.some((excluded) => rel === excluded || rel.split(path.sep).includes(excluded))) continue;
    if (dirent.isDirectory()) {
      result.push(...listSourceFiles(rel));
    } else if (SCREEN_SOURCE_EXTENSIONS.includes(path.extname(dirent.name)) && !/\.test\.tsx?$/.test(dirent.name)) {
      result.push(rel);
    }
  }
  return result;
}

describe('#1859 FAQ とガイドの言葉が今の画面と合っている', () => {
  const { entries: faqEntries, declaredCount } = readFaqEntries();
  const allTexts = [...faqTexts(faqEntries), ...guideTexts()];

  it('FAQ の項目をすべて読み取れている (読み取りの空振りで見張りが素通りしない)', () => {
    expect(faqEntries.length).toBe(declaredCount);
    expect(faqEntries.length).toBeGreaterThanOrEqual(MIN_FAQ_ENTRY_COUNT);
  });

  it('画面に無い言い回しが FAQ とガイドに無い', () => {
    for (const { text: phrase, reason } of FORBIDDEN_PHRASES) {
      for (const { where, text } of allTexts) {
        expect(text, `${where} に「${phrase}」がある (${reason})`).not.toContain(phrase);
      }
    }
  });

  it('献立の話 (FAQ の献立の項目・ガイドの献立の章) に、条件の選択肢に無い条件 (予算・調理時間) が無い', () => {
    const menuTexts = [
      ...faqTexts(faqEntries.filter((entry) => entry.q.includes('献立') || entry.a.includes('献立'))),
      ...guideTexts().filter(({ where }) => where.startsWith('guide menu')),
    ];
    expect(menuTexts.length).toBeGreaterThan(0);
    for (const condition of FORBIDDEN_MENU_CONDITIONS) {
      for (const { where, text } of menuTexts) {
        expect(text, `${where} に「${condition}」がある (献立の条件の選択肢に無い)`).not.toContain(condition);
      }
    }
  });

  it('FAQ とガイドが挙げる献立の条件の名前は、条件の選択肢 (V4 のモーダル) に実在する', () => {
    const modal = stripComments(readSource(V4_MODAL_FILE));
    const named = allTexts.flatMap(({ where, text }) =>
      [...text.matchAll(/([^、。（）()]+?)などの条件/g)].flatMap(([, list]) =>
        list.split('・').map((name) => ({ where, name: name.trim() })),
      ),
    );
    // FAQ の「献立提案機能はどう使いますか？」とガイドの「条件を設定」の 2 か所が挙げている
    expect(new Set(named.map(({ where }) => where)).size).toBeGreaterThanOrEqual(2);
    for (const { where, name } of named) {
      expect(modal, `${where} の条件「${name}」が ${V4_MODAL_FILE} の選択肢に無い`).toContain(`label: '${name}'`);
    }
  });

  it('FAQ とガイドが「」で挙げる画面の項目の名前は、画面のソースの文言に実在する', () => {
    const screenSource = SCREEN_SOURCE_DIRS.flatMap(listSourceFiles)
      .map((file) => stripComments(readSource(file)))
      .join('\n');
    const named = allTexts.flatMap(({ where, text }) => quotedNames(text).map((name) => ({ where, name })));
    // 少なくとも、献立表の画面のボタン名と設定画面の項目名を挙げている
    expect(named.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['AI献立アシスタント', 'AIに埋めてもらう', 'データをエクスポート']),
    );
    for (const { where, name } of named) {
      expect(screenSource.includes(name), `${where} の「${name}」が画面のソースに無い`).toBe(true);
    }
  });

  it('FAQ の献立の使い方は、ガイドと同じ画面の名前 (献立表の「AI献立アシスタント」) を案内する', () => {
    const howTo = faqEntries.find((entry) => entry.q === '献立提案機能はどう使いますか？');
    expect(howTo, `${FAQ_FILE} に「献立提案機能はどう使いますか？」が無い`).toBeDefined();
    const guideRequest = GUIDES.find((guide) => guide.id === 'menu')?.steps[0];
    expect(guideRequest, `${GUIDE_FILE} に献立の章の最初の手順が無い`).toBeDefined();
    for (const name of quotedNames(guideRequest?.desc ?? '')) {
      expect(howTo?.a, `FAQ の献立の使い方に、ガイドが挙げる「${name}」が無い`).toContain(`「${name}」`);
    }
    expect(howTo?.a).toContain('献立表');
  });
});
