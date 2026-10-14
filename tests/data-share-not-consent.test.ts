/**
 * #1144 「トレーナーと共有」の保存済みの値を、同意として使わせないためのソース走査 contract テスト
 *
 * 設定画面の「トレーナーと共有」は、トレーナーなどに共有する機能がどこにも無いまま、スイッチの ON / OFF だけを
 * notification_preferences.data_share_enabled に保存していた。利用者に「共有できる / すでに共有している」と
 * 思わせる表示だったため、Web とアプリの設定画面から外した (オーナー判断 2026-10-08)。
 * 列と API の項目は、旧ビルドのアプリがまだ読み書きするので残してある。
 * (AI の事業者へデータを送る処理 (自動解析など) とは別の項目で、そちらはこの変更で止めていない)
 *
 * 残してある値は「共有への同意」ではない (共有先・範囲・使いみちの説明も、同意の日時の記録も無かった)。
 * 将来、トレーナーなどへの共有を始めるときは、先に既存の値を全員 false に戻し、同意を取り直す仕組みを作ってから使う。
 * そのために、次の 2 つをソースを読んで確かめる。
 *
 *   1. data_share_enabled (と、その画面用の名前 dataShare) をコードで使っているのは、旧ビルド向けの API と
 *      DB の型だけであること。新しく読み書きするコードが入ったらこのテストが落ちるので、同意の扱いを決めてから足す。
 *   2. Web とアプリの設定画面に、「トレーナーと共有」の項目が戻っていないこと。
 *
 * 走査は TypeScript の構文木のトークンで行うので、コメントの中の名前には反応しない
 * (画面のコードに「外した理由」のコメントを残せる)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/**
 * 保存済みの「トレーナーと共有」の値を指す名前 (DB の列 / API の項目 / 画面の state とその setter)。
 * 別の機能の名前 (家族への健康データ共有の healthDataShare など) に反応しないよう、名前の切れ目 (\b) まで合わせる。
 */
const DATA_SHARE_NAME = /\bdata_share_enabled\b|\b(?:set)?[dD]ataShare\b/;

/** 外した項目の、画面に出ていた言葉 (モバイルの副題も含む) */
const TRAINER_SHARE_WORDS = /トレーナーと共有|栄養士やジムと連携/;

/**
 * data_share_enabled を、コードで使ってよいファイルと、その理由。
 * 足すときは、保存済みの値を同意として読まないこと (読むなら、先に全員 false に戻して同意を取り直すこと) を確かめてから。
 */
const ALLOWED_FILES: Record<string, string> = {
  'src/app/api/notification-preferences/route.ts':
    '旧ビルドのアプリが読み書きするので、API の項目として残してある (値は同意ではない。route のコメント参照)',
  'src/types/database.types.ts': 'supabase gen types が出力する列の型',
  'packages/shared/src/database.types.ts': 'supabase gen types が出力する列の型 (モバイルと共有)',
};

/** 名前の走査対象 (リポジトリのコード置き場。テスト・ビルド成果物・node_modules は除く) */
const SCAN_ROOTS = ['src', 'components', 'lib', 'types', 'shared', 'packages', 'apps', 'supabase/functions'];
const SKIP_DIRS = new Set([
  'node_modules',
  '__tests__',
  '.next',
  '.expo',
  'ios',
  'android',
  'dist',
  'build',
  'coverage',
  'maestro',
]);
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** 「トレーナーと共有」の項目が戻っていないことを確かめる画面のコード (Web の設定画面 / アプリの設定画面) */
const SETTINGS_SCREEN_DIRS = ['src/app/(main)/settings', 'apps/mobile/app/(tabs)', 'apps/mobile/app/settings'];

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...collectSourceFiles(full));
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const relativePath = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** ソースを構文木のトークン (識別子・文字列・JSX の文など。コメントは含まない) に分けて返す */
function codeTokens(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sf);
    if (children.length === 0) {
      tokens.push(node.getText(sf));
    } else {
      children.forEach(visit);
    }
  };
  visit(sf);
  return tokens;
}

/** コード (コメントを除く) の中で pattern に当たったトークンを返す */
function findInCode(source: string, fileName: string, pattern: RegExp): string[] {
  // 構文木に分けるのは時間がかかるので、生のテキストに当たらないファイルは先に除く
  if (!pattern.test(source)) return [];
  return codeTokens(source, fileName).filter((token) => pattern.test(token));
}

/** 全ファイルの走査結果: ファイル -> 当たったトークン。ALLOWED_FILES 以外で当たったファイルを調べる */
const scannedFiles: string[] = [];
const dataShareUsages = new Map<string, string[]>();
for (const scanRoot of SCAN_ROOTS) {
  for (const file of collectSourceFiles(path.join(ROOT, scanRoot))) {
    const relative = relativePath(file);
    scannedFiles.push(relative);
    const hits = findInCode(fs.readFileSync(file, 'utf-8'), relative, DATA_SHARE_NAME);
    if (hits.length > 0) dataShareUsages.set(relative, hits);
  }
}

describe('「トレーナーと共有」の保存済みの値は、同意として使わない (#1144): リポジトリのソース', () => {
  it('走査が機能している: 許可しているファイルで、実際に名前を検出する', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(scannedFiles.length).toBeGreaterThan(300);
    for (const file of Object.keys(ALLOWED_FILES)) {
      expect(dataShareUsages.has(file), `${file} が data_share_enabled を使っていません。許可リスト (ALLOWED_FILES) から外してください`).toBe(
        true,
      );
    }
  });

  it('data_share_enabled をコードで使っているのは、旧ビルド向けの API と DB の型だけ', () => {
    const others = [...dataShareUsages.keys()].filter((file) => !(file in ALLOWED_FILES));

    expect(
      others,
      `${others.join(', ')} が、保存済みの「トレーナーと共有」の値 (data_share_enabled) を使っています。` +
        'この値は利用者の同意ではありません (トレーナーなどに共有する機能は無く、画面からも外しました。#1144)。' +
        '共有を始めるときは、先に既存の値を全員 false に戻し、同意を取り直す仕組みを作ってから使ってください。',
    ).toEqual([]);
  });
});

describe('「トレーナーと共有」の項目は、設定画面に戻さない (#1144): リポジトリのソース', () => {
  const screenFiles = SETTINGS_SCREEN_DIRS.flatMap((dir) => collectSourceFiles(path.join(ROOT, dir)));

  it('走査が機能している: Web とアプリの設定画面のコードを読んでいる', () => {
    const relatives = screenFiles.map(relativePath);
    expect(relatives).toContain('src/app/(main)/settings/page.tsx');
    expect(relatives).toContain('apps/mobile/app/(tabs)/settings.tsx');
  });

  it('Web とアプリの設定画面のコードに、「トレーナーと共有」の言葉が無い', () => {
    const found = screenFiles.flatMap((file) =>
      findInCode(fs.readFileSync(file, 'utf-8'), relativePath(file), TRAINER_SHARE_WORDS).map((token) => `${relativePath(file)}: ${token.trim()}`),
    );

    expect(
      found,
      '「トレーナーと共有」は、トレーナーなどに共有する機能が無いまま保存だけをしていたため、設定画面から外しました (#1144)。' +
        '共有の機能を作るときは、共有先・範囲の説明と同意の取り直しを含めて設計してから、この項目を戻してください。',
    ).toEqual([]);
  });
});

describe('「トレーナーと共有」の保存済みの値は、同意として使わない (#1144): 走査のロジック', () => {
  it('識別子・文字列・JSX の文・テンプレートの中の名前を検出する', () => {
    const source = `
      const dataShare = 1;
      const key = 'data_share_enabled';
      const tpl = \`select \${a}, data_share_enabled\`;
      const row = { data_share_enabled: true };
      export const el = <button>トレーナーと共有（準備中）</button>;
    `;

    expect(findInCode(source, 'file.tsx', DATA_SHARE_NAME).length).toBeGreaterThanOrEqual(4);
    expect(findInCode(source, 'file.tsx', TRAINER_SHARE_WORDS)).toHaveLength(1);
  });

  it('別の機能の名前 (healthDataShare / dataSharePolicy など) には反応しない', () => {
    const source = `
      const healthDataShare = true;
      const dataSharePolicy = 'x';
      export function FamilyDataShareDialog() { return null; }
    `;

    expect(findInCode(source, 'file.tsx', DATA_SHARE_NAME)).toEqual([]);
  });

  it('画面の state とその setter の名前 (dataShare / setDataShare) は検出する', () => {
    const source = `const [dataShare, setDataShare] = useState(true);`;

    expect(findInCode(source, 'file.tsx', DATA_SHARE_NAME)).toEqual(['dataShare', 'setDataShare']);
  });

  it('コメントの中の名前には反応しない (外した理由のコメントを画面のコードに残せる)', () => {
    const source = `
      // data_share_enabled は同意ではない。トレーナーと共有 の項目は外した (#1144)
      /* const [dataShare, setDataShare] = useState(false); */
      export const el = <div>{/* トレーナーと共有 は外した */}</div>;
    `;

    expect(findInCode(source, 'file.tsx', DATA_SHARE_NAME)).toEqual([]);
    expect(findInCode(source, 'file.tsx', TRAINER_SHARE_WORDS)).toEqual([]);
  });
});
