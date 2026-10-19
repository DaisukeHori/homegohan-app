/**
 * #1902 (Dependabot #1900 の代わり): アプリが lucide-react-native から読むアイコンの名前が、入っている版に実在することを確かめる。
 *
 * lucide-react-native は版を上げるとアイコンの改名・削除がある。名前が消えると、型検査は d.ts の版しだいで通り得て、
 * 実行時には import が undefined になり、その画面を描いた時点で落ちる。ソース (app/ と src/) の import を全部拾い、
 * 1) Jest が読む CommonJS の版 (jest.config.js の moduleNameMapper で写す先) と
 * 2) アプリ本体 (Metro) が読む ESM の版 (package.json の exports の "react-native" の条件の先)
 * の両方に、その名前の export があることを確かめる。
 *
 * このテストは lucide-react-native を Jest で読めること自体も確かめる。1.57 から exports の "react-native" の条件が
 * ESM の .mjs を指し、jest-expo がそれを変換せずに読んで「Must use import to load ES Module」で落ちていた
 * (Dependabot #1900 の CI の赤)。jest.config.js の写しが無いと、このファイルの import で落ちる。
 */

import fs from 'fs';
import path from 'path';
import * as lucide from 'lucide-react-native';

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const SOURCE_DIRS = [path.join(MOBILE_ROOT, 'app'), path.join(MOBILE_ROOT, 'src')];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const PACKAGE_NAME = 'lucide-react-native';

/**
 * 拾ったアイコンの名前の数の下限 (拾い方が壊れて 0 件で通らないように)。
 * #1902 の時点で AIAdvisorSheet の 7 個 (Archive・Calendar・ChevronDown・MessageCircle・Send・Sparkles・X)。
 * AIFloatingFab の Sparkles は重複なので数えない。
 */
const MIN_ICON_NAMES = 7;

/** CommonJS の版の入口 (dist/cjs/<name>.js) から、パッケージの根までの階層の数 */
const CJS_ENTRY_DEPTH_FROM_PACKAGE_ROOT = 3;

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
  });
}

const FROM_PACKAGE = new RegExp(`from\\s*['"]${PACKAGE_NAME}['"]`, 'g');
const NAMED_IMPORT = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${PACKAGE_NAME}['"]`, 'g');

type ImportedNames = { names: Set<string>; fromCount: number; namedImportCount: number };

function collectImportedNames(): ImportedNames {
  const names = new Set<string>();
  let fromCount = 0;
  let namedImportCount = 0;
  for (const file of SOURCE_DIRS.flatMap(listSourceFiles)) {
    const source = fs.readFileSync(file, 'utf8');
    fromCount += (source.match(FROM_PACKAGE) ?? []).length;
    for (const match of source.matchAll(NAMED_IMPORT)) {
      namedImportCount += 1;
      // import type { ... } は実行時に読まないので数えない
      if (match[1]) continue;
      for (const raw of match[2].split(',')) {
        const spec = raw.trim();
        if (spec === '' || spec.startsWith('type ')) continue;
        // `A as B` は A が export の名前
        names.add(spec.split(/\s+as\s+/)[0].trim());
      }
    }
  }
  return { names, fromCount, namedImportCount };
}

/** ESM の入口の `export { default as A, default as B } from '...'` と `export { A, B }` から、export の名前を全部拾う */
function collectEsmExportNames(esmSource: string): Set<string> {
  const names = new Set<string>();
  for (const match of esmSource.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of match[1].split(',')) {
      const spec = raw.trim();
      if (spec === '') continue;
      const parts = spec.split(/\s+as\s+/);
      names.add(parts[parts.length - 1].trim());
    }
  }
  return names;
}

type ExportTarget = string | { [condition: string]: ExportTarget };

function resolveEsmEntry(): string {
  // moduleNameMapper の写し先 (CommonJS の版) から、パッケージの根を求める
  const cjsEntry = require.resolve(PACKAGE_NAME);
  const packageRoot = path.resolve(
    cjsEntry,
    ...Array.from({ length: CJS_ENTRY_DEPTH_FROM_PACKAGE_ROOT }, () => '..'),
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    name: string;
    exports?: { [subpath: string]: ExportTarget };
    'react-native'?: string;
    module?: string;
  };
  expect(pkg.name).toBe(PACKAGE_NAME);
  const rootExport = pkg.exports?.['.'];
  const fromExports =
    typeof rootExport === 'object' && typeof rootExport['react-native'] === 'string'
      ? rootExport['react-native']
      : undefined;
  // Metro は exports の "react-native" の条件を先に見る。無い版 (1.14 まで) は package.json の "react-native" の欄
  const entry = fromExports ?? pkg['react-native'] ?? pkg.module;
  if (entry === undefined) {
    throw new Error(`${PACKAGE_NAME} の package.json に ESM の入口が見つからない`);
  }
  return path.join(packageRoot, entry);
}

describe('lucide-react-native のアイコンの名前 (#1902)', () => {
  const { names, fromCount, namedImportCount } = collectImportedNames();

  it('ソースの import を全部拾えている (名前付きの import 以外の書き方が無い)', () => {
    expect(namedImportCount).toBe(fromCount);
    expect(names.size).toBeGreaterThanOrEqual(MIN_ICON_NAMES);
  });

  it('Jest が読む版 (CommonJS) に、アプリが読む名前が全部ある', () => {
    const exported = new Map<string, unknown>(Object.entries(lucide));
    const missing = [...names].filter((name) => exported.get(name) == null);
    expect(missing).toEqual([]);
    for (const name of names) {
      // アイコンは forwardRef の部品 (object) か関数
      expect(['object', 'function']).toContain(typeof exported.get(name));
    }
  });

  it('アプリ本体 (Metro) が読む版 (ESM) に、アプリが読む名前が全部ある', () => {
    const esmEntry = resolveEsmEntry();
    expect(path.extname(esmEntry)).toBe('.mjs');
    const exported = collectEsmExportNames(fs.readFileSync(esmEntry, 'utf8'));
    const missing = [...names].filter((name) => !exported.has(name));
    expect(missing).toEqual([]);
  });
});
