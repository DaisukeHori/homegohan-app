/**
 * #2195 V3: AI 相談の提案の実行で読み込み直してよいページ (webViewBridge.ts の AI_CONSULTATION_RELOADABLE_PATHS) の、
 * 「入力の途中なら読み込み直さない」の前提を Web のソースで確かめる (静的な検査)
 *
 * 読み込み直すかはページの上で決め、入力の部品・開いているモーダル (aiConsultationReloadBlockingSelectorOf) がある間は
 * 読み込み直さない。これが入力を守るのは、ページの入力の部品が「モーダルか開閉する欄の中にだけあり、それが出ている間は
 * 必ずその要素に当たる」ときだけ。WebViewScreen.ai-data-reload.test.tsx は querySelector を差し替えた sandbox で
 * スクリプトの動きを見るだけなので、後から role="dialog" も入力の部品も無いモーダル (ボタンだけの選択) が足されると、
 * その選択が読み込み直しで消えうる。ここでは Web のソースから次を確かめ、条件を満たさない部品が足されたら赤にする。
 *   1. /menus/weekly のモーダル (_components/modals/*.tsx の全部と、ページが描く名前が Modal / Dialog の部品) は、
 *      role="dialog" / aria-modal="true" か入力の部品を持つ。持たないと分かっていて読み込み直しで閉じることを認めた部品
 *      (KNOWN_NON_BLOCKING_DIALOGS) だけを除く
 *   2. /home の体調のチェックインの欄 (showCheckin の間だけ出る) は、hidden でない入力の部品を持つ
 *   3. /profile の編集のモーダル (isEditing の間だけ出る) は、ページごとに足した要素 (.fixed.inset-0) に当たる層で始まり、
 *      ページの本体 (モーダルの外) には同じ層が無い (あると、マイページはいつまでも読み込み直されない)
 *   4. ほかの一覧のページ (/home・/comparison・/profile) が描く名前が Modal / Dialog の部品も 1 と同じ条件を満たす
 * 文字列で見る検査なので、実際に描く DOM までは確かめない (読み込み直しの判定そのものは sandbox のテストが見る)。
 */
import fs from 'fs';
import path from 'path';

import {
  AI_CONSULTATION_RELOADABLE_PATHS,
  AI_CONSULTATION_RELOAD_PAGE_BLOCKING_SELECTORS,
} from '../../src/lib/webViewBridge';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WEB_SRC = path.join(REPO_ROOT, 'src');
const MAIN_PAGES = path.join(WEB_SRC, 'app/(main)');
const WEEKLY_DIR = path.join(MAIN_PAGES, 'menus/weekly');
const WEEKLY_MODALS_DIR = path.join(WEEKLY_DIR, '_components/modals');
const SOURCE_EXTENSIONS = ['.tsx', '.ts'];

/**
 * role="dialog" も入力の部品も持たず、読み込み直すと閉じることを認めた部品 (webViewBridge.ts の AI_CONSULTATION_RELOADABLE_PATHS の
 * '/menus/weekly' の根拠の文)。入力を持たない確認・結果の知らせで、閉じても保存していない入力は失わない。
 * ここに足すのは、閉じても入力を失わないと確かめた部品だけ
 */
const KNOWN_NON_BLOCKING_DIALOGS: Readonly<Record<string, string>> = {
  CancelGenerationConfirmModal: '生成の取り消しの確認 (ボタンだけ。閉じても生成は続き、もう一度取り消せる)',
  GenerationResultDialogContent: '生成の完了の知らせ (ボタンだけ。閉じても献立は保存済み)',
};

/** 名前が Modal / Dialog の部品の JSX のタグ */
const DIALOG_LIKE_TAG = /<([A-Z][A-Za-z0-9]*(?:Modal|Dialog)[A-Za-z0-9]*)\b/g;
/** 読み込み直しを止める印: role="dialog"・aria-modal (true)・<dialog> */
const DIALOG_MARKER = /role=["']dialog["']|aria-modal(?:=\{?\s*["']?true["']?\s*\}?|\s)|<dialog\b/;
/** 読み込み直しを止める入力の部品 (hidden の input を除く) */
const INPUT_MARKER = /<(?:textarea|select|Input|Textarea|Select)\b|<input\b(?![^>]*type=["']hidden["'])|contentEditable(?!=\{false\})/;

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** ブロックコメントと行コメントを除く (コメントの中の語を印として数えない) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function hasBlockingMarker(source: string): boolean {
  const code = stripComments(source);
  return DIALOG_MARKER.test(code) || INPUT_MARKER.test(code);
}

/** ファイルの拡張子・index を補って、実在するソースのパスにする */
function resolveSourceFile(base: string): string | null {
  for (const candidate of [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** import の指定 (相対・@/) を、ページのファイルから見たソースのパスにする */
function resolveModule(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('@/')) return resolveSourceFile(path.join(WEB_SRC, specifier.slice(2)));
  if (specifier.startsWith('.')) return resolveSourceFile(path.resolve(path.dirname(fromFile), specifier));
  return null;
}

/** ページのファイルで、部品の名前を import している指定 (静的な import と next/dynamic の import の両方) */
function importSpecifierOf(name: string, source: string): string | null {
  for (const match of source.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = match[1];
    const named = /\{([\s\S]*)\}/.exec(clause)?.[1] ?? '';
    const names = named.split(',').map((part) => part.trim().split(/\s+as\s+/).pop()?.trim());
    const defaultName = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
    if (names.includes(name) || defaultName === name) return match[2];
  }
  const dynamicImport = new RegExp(`const\\s+${name}\\s*=\\s*dynamic\\([\\s\\S]*?import\\(["']([^"']+)["']\\)`);
  return dynamicImport.exec(source)?.[1] ?? null;
}

/** 部品の定義のファイル。import が index (まとめのファイル) を指すときは、同じディレクトリの <名前>.tsx */
function componentFileOf(name: string, pageFile: string): string {
  const pageSource = read(pageFile);
  const specifier = importSpecifierOf(name, pageSource);
  if (!specifier) throw new Error(`${path.relative(REPO_ROOT, pageFile)} で ${name} の import が見つからない`);
  const resolved = resolveModule(specifier, pageFile);
  if (!resolved) throw new Error(`${name} の import (${specifier}) をファイルにできない`);
  if (/^index\.tsx?$/.test(path.basename(resolved))) {
    const sibling = resolveSourceFile(path.join(path.dirname(resolved), name));
    if (!sibling) throw new Error(`${name} の定義が ${path.relative(REPO_ROOT, path.dirname(resolved))} に見つからない`);
    return sibling;
  }
  return resolved;
}

/** ページが描く、名前が Modal / Dialog の部品 (重複なし) */
function dialogLikeComponentsOf(pageFile: string): string[] {
  const code = stripComments(read(pageFile));
  return [...new Set(Array.from(code.matchAll(DIALOG_LIKE_TAG), (match) => match[1]))].sort();
}

/**
 * `{<条件> && (` で始まる JSX の塊 (対応する `)` まで)。見つからなければ例外。
 * 括弧の対応は ( と ) の数だけで見る (文字列の中の括弧は数えてしまうが、この検査が見る塊には無い)
 */
function conditionalBlockOf(source: string, condition: string): { start: number; end: number; text: string } {
  const head = `{${condition} && (`;
  const start = source.indexOf(head);
  if (start < 0) throw new Error(`${head} が見つからない`);
  let depth = 0;
  for (let index = start + head.length - 1; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1, text: source.slice(start, index + 1) };
    }
  }
  throw new Error(`${head} の閉じる ) が見つからない`);
}

const pageFileOf = (pathname: string) => path.join(MAIN_PAGES, pathname, 'page.tsx');

describe('/menus/weekly のモーダルは、読み込み直しを止める印を持つ (#2195 V3)', () => {
  const modalFiles = fs
    .readdirSync(WEEKLY_MODALS_DIR)
    .filter((name) => name.endsWith('.tsx'))
    .sort();

  it('モーダルのディレクトリを読めている (走査の場所を間違えて、何も見ずに通ることを防ぐ)', () => {
    expect(modalFiles).toEqual(expect.arrayContaining(['AddMealModal.tsx', 'EditMealModal.tsx', 'ShoppingModal.tsx']));
  });

  it.each(modalFiles.map((name) => [name]))('_components/modals/%s は role="dialog" か入力の部品を持つ', (name) => {
    expect(hasBlockingMarker(read(path.join(WEEKLY_MODALS_DIR, name)))).toBe(true);
  });

  it('ページが描く名前が Modal / Dialog の部品は、認めた部品を除いて印を持つ', () => {
    const pageFile = pageFileOf('/menus/weekly');
    const components = dialogLikeComponentsOf(pageFile);
    expect(components).toEqual(expect.arrayContaining(['V4GenerateModal', 'ConfirmDeleteModal', 'CancelGenerationConfirmModal']));
    const missing = components
      .filter((name) => !Object.prototype.hasOwnProperty.call(KNOWN_NON_BLOCKING_DIALOGS, name))
      .filter((name) => !hasBlockingMarker(read(componentFileOf(name, pageFile))));
    expect(missing).toEqual([]);
  });

  it('認めた部品は、今もページが描いていて、印を持たない (一覧を古いまま残さない)', () => {
    const pageFile = pageFileOf('/menus/weekly');
    const components = dialogLikeComponentsOf(pageFile);
    for (const name of Object.keys(KNOWN_NON_BLOCKING_DIALOGS)) {
      expect(components).toContain(name);
      expect({ name, marked: hasBlockingMarker(read(componentFileOf(name, pageFile))) }).toEqual({ name, marked: false });
    }
  });
});

describe('ほかの一覧のページが描く名前が Modal / Dialog の部品も印を持つ (#2195 V3)', () => {
  it.each(AI_CONSULTATION_RELOADABLE_PATHS.filter((pathname) => pathname !== '/menus/weekly').map((pathname) => [pathname]))(
    '%s',
    (pathname) => {
      const pageFile = pageFileOf(pathname);
      const missing = dialogLikeComponentsOf(pageFile).filter((name) => !hasBlockingMarker(read(componentFileOf(name, pageFile))));
      expect(missing).toEqual([]);
    },
  );
});

describe('/home の体調のチェックインの欄は入力の部品を持つ (#2195 V3)', () => {
  it('showCheckin の間だけ出る欄に、hidden でない入力の部品がある', () => {
    const block = conditionalBlockOf(stripComments(read(pageFileOf('/home'))), 'showCheckin');
    expect(INPUT_MARKER.test(block.text)).toBe(true);
  });
});

describe('/profile の編集のモーダルは、ページごとに足した要素に当たる層で始まる (#2195 V3)', () => {
  const PROFILE_SELECTOR = AI_CONSULTATION_RELOAD_PAGE_BLOCKING_SELECTORS['/profile'];
  /** `.a.b` の形のセレクタのクラス名 (この検査は、クラスだけのセレクタを扱う) */
  const classesOf = (selector: string) => selector.split('.').filter(Boolean);
  const hasAllClasses = (className: string, classes: readonly string[]) => {
    const tokens = className.split(/\s+/);
    return classes.every((name) => tokens.includes(name));
  };
  /** className の値 (文字列と、テンプレート文字列の固定の部分) */
  const classNamesIn = (code: string) =>
    Array.from(code.matchAll(/className=(?:["']([^"']*)["']|\{\s*`([^`]*)`\s*\})/g), (match) => match[1] ?? match[2] ?? '');

  it('ページごとに足す要素はクラスだけのセレクタ', () => {
    expect(PROFILE_SELECTOR).toMatch(/^(?:\.[A-Za-z0-9_-]+)+$/);
  });

  it('isEditing の間だけ出る塊の最初の要素の class が、ページごとに足した要素に当たる', () => {
    const code = stripComments(read(pageFileOf('/profile')));
    const block = conditionalBlockOf(code, 'isEditing');
    const [firstClassName] = classNamesIn(block.text);
    expect(firstClassName).toBeDefined();
    expect(hasAllClasses(firstClassName ?? '', classesOf(PROFILE_SELECTOR))).toBe(true);
  });

  it('編集のモーダルの外 (ページの本体) には、同じ要素に当たる class が無い (あるとマイページが読み込み直されない)', () => {
    const code = stripComments(read(pageFileOf('/profile')));
    const block = conditionalBlockOf(code, 'isEditing');
    const outside = code.slice(0, block.start) + code.slice(block.end);
    const hits = classNamesIn(outside).filter((className) => hasAllClasses(className, classesOf(PROFILE_SELECTOR)));
    expect(hits).toEqual([]);
  });

  it('判定は、両方のクラスを持つときだけ当たる (見張りの自己検査)', () => {
    const classes = classesOf('.fixed.inset-0');
    expect(hasAllClasses('fixed inset-0 z-[60] flex', classes)).toBe(true);
    expect(hasAllClasses('fixed bottom-0', classes)).toBe(false);
    expect(hasAllClasses('absolute inset-0', classes)).toBe(false);
    expect(classNamesIn('<div className={`fixed inset-0 ${open ? "a" : "b"}`} /><p className="x" />')).toEqual([
      'fixed inset-0 ${open ? "a" : "b"}',
      'x',
    ]);
  });
});

describe('印の判定 (見張りの自己検査)', () => {
  it.each([
    ['role="dialog"', '<div role="dialog" aria-modal="true">', true],
    ['入力', '<textarea value={x} />', true],
    ['部品の Input', '<Input value={x} />', true],
    ['hidden の input だけ', '<input type="hidden" name="x" />', false],
    ['ボタンだけ', '<div className="fixed inset-0"><button>はい</button></div>', false],
    ['コメントの中の語だけ', '// role="dialog" を足すこと\n<div><button /></div>', false],
  ])('%s', (_label, source, expected) => {
    expect(hasBlockingMarker(source)).toBe(expected);
  });
});
