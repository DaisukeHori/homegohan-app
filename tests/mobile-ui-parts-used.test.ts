/**
 * #1598 アプリの共通の部品 (apps/mobile/src/components/ui/index.ts が export する部品) は、どれも残した画面か部品が使う
 *
 * #1598 の続きで、通常の操作で届かないネイティブの画面と、その画面だけが使う部品を消した。そのとき、消した画面だけが使っていた
 * 共通の部品 (StatusBadge・ListItem・StatCard・ChipSelector) が、ui/index.ts の再 export を通して「どこかから import されている」
 * ように見えたため、ファイルの import のつながりだけで「消した画面だけが使う部品」を探した作業から漏れ、使い手の無いまま残った。
 * ここでは、ui/index.ts が export する部品ごとに、残した画面・部品 (apps/mobile/app と apps/mobile/src。テストは除く) のどこかが、
 * その名前を ui/index.ts か部品のファイルから import していることを確かめる。ui の中の部品が使う部品 (EmptyState が使う Button) は、
 * 使う側の部品が使われているときだけ使われているとみなす。
 *   1. ui/index.ts は `export { 名前 } from './ファイル';` の行だけでできている (読み方が外れて空振りしない)
 *   2. どの部品も、残した画面・部品のどこかが import している (使い手が無くなった部品は、画面と一緒に消す)
 *   3. 走査が空振りしていない (いまの画面が import する Card を見つける)
 * この検査の限界: ui/index.ts を通す部品だけを見る。ほかのディレクトリの部品・フック・関数で使い手が無くなったものは見ない。
 * コメントの中の import の文は数えないが、文字列の中の import の文は数える。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
/** モバイルのディレクトリ (リポジトリの根からの相対) */
const MOBILE_DIR = 'apps/mobile';
/** 共通の部品のディレクトリと、その部品をまとめて export するファイル */
const UI_DIR = `${MOBILE_DIR}/src/components/ui`;
const UI_BARREL = `${UI_DIR}/index.ts`;
/** 部品を使う側を探すディレクトリ (残した画面と部品) */
const SOURCE_ROOTS = [`${MOBILE_DIR}/app`, `${MOBILE_DIR}/src`] as const;
/** 読むファイルの拡張子 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx'] as const;
/** 読まないディレクトリ (依存と、テスト) */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '__tests__']);
/** いまの画面が ui/index.ts から import する部品 (走査が空振りしていないことの確かめ用) */
const KNOWN_USED_PART = 'Card';

/** ui/index.ts の 1 行: `export { 名前 } from './ファイル';` */
const BARREL_LINE = /^export \{ ([A-Za-z_$][\w$]*) \} from '\.\/([\w-]+)';$/;
/** 名前を並べた import の文 (1 番目の組が名前の並び、2 番目の組が import 元) */
const NAMED_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
/** 名前空間の import (`import * as UI from '…'`。1 番目の組が import 元) */
const NAMESPACE_IMPORT = /import\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s*['"]([^'"]+)['"]/g;
/** 部品のファイルの拡張子 (import 元の書き方に付けてもよい) */
const PART_EXTENSION = /\.tsx?$/;

type UiPart = { name: string; file: string };

/** ui/index.ts を読む。読めなかった行 (空行以外で、決まった形でないもの) も返す */
function parseBarrel(text: string): { parts: UiPart[]; unreadLines: string[] } {
  const parts: UiPart[] = [];
  const unreadLines: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const match = BARREL_LINE.exec(line);
    if (match) parts.push({ name: match[1], file: match[2] });
    else unreadLines.push(line);
  }
  return { parts, unreadLines };
}

/** コメント (/* … *\/ と // …) を消す。`https://` のような、`:` や引用符のすぐ後ろの // は残す */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** import 元の書き方を、リポジトリの根からのパス (拡張子なし) に直す。相対でないもの (パッケージ) は null */
function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)).replace(PART_EXTENSION, '');
}

/** import 元が ui/index.ts か、ui の部品のファイルか */
function isUiModule(resolved: string, parts: readonly UiPart[]): boolean {
  return (
    resolved === UI_DIR || resolved === `${UI_DIR}/index` || parts.some((part) => resolved === `${UI_DIR}/${part.file}`)
  );
}

/** 名前の並び (`A, type B, C as D`) から、import した元の名前を取り出す */
function importedNames(list: string): string[] {
  return list
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

type UiImports = { byFile: Map<string, Set<string>>; namespaceImports: string[] };

/** ファイルごとに、ui/index.ts か部品のファイルから import した部品の名前を集める (名前空間の import は別に返す) */
function collectUiImports(sources: ReadonlyMap<string, string>, parts: readonly UiPart[]): UiImports {
  const byFile = new Map<string, Set<string>>();
  const namespaceImports: string[] = [];
  for (const [file, source] of sources) {
    const code = stripComments(source);
    const names = new Set<string>();
    for (const match of code.matchAll(NAMED_IMPORT)) {
      const resolved = resolveImport(file, match[2]);
      if (resolved !== null && isUiModule(resolved, parts)) importedNames(match[1]).forEach((name) => names.add(name));
    }
    for (const match of code.matchAll(NAMESPACE_IMPORT)) {
      const resolved = resolveImport(file, match[1]);
      if (resolved !== null && isUiModule(resolved, parts)) namespaceImports.push(file);
    }
    if (names.size > 0) byFile.set(file, names);
  }
  return { byFile, namespaceImports };
}

/**
 * どこからも使われていない部品の名前。ui の中の部品のファイルが import する部品は、その部品が使われているときだけ数える
 * (使い手の無い部品だけが使う部品も、使い手が無い)
 */
function unusedUiParts(parts: readonly UiPart[], imports: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const partNames: ReadonlySet<string> = new Set(parts.map((part) => part.name));
  const ownerOf = new Map(parts.map((part) => [`${UI_DIR}/${part.file}`, part.name]));
  const used = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, names] of imports) {
      const owner = ownerOf.get(file.replace(PART_EXTENSION, ''));
      if (owner !== undefined && !used.has(owner)) continue;
      for (const name of names) {
        if (partNames.has(name) && !used.has(name)) {
          used.add(name);
          grew = true;
        }
      }
    }
  }
  return parts.map((part) => part.name).filter((name) => !used.has(name));
}

/** 残した画面・部品のファイル (リポジトリの根からの相対) */
function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...listSources(rel));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(rel);
    }
  }
  return out;
}

const barrel = parseBarrel(fs.readFileSync(path.join(ROOT, UI_BARREL), 'utf8'));
const sources = new Map(
  SOURCE_ROOTS.flatMap(listSources).map((file) => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')] as const),
);
const uiImports = collectUiImports(sources, barrel.parts);

describe('#1598 アプリの共通の部品 (ui/index.ts) は、どれも残した画面か部品が使う', () => {
  describe('見張りの形', () => {
    const parts: UiPart[] = [
      { name: 'Card', file: 'Card' },
      { name: 'Button', file: 'Button' },
      { name: 'EmptyState', file: 'EmptyState' },
      { name: 'StatCard', file: 'StatCard' },
      { name: 'StatusBadge', file: 'StatusBadge' },
    ];

    it('ui/index.ts の決まった形でない行を、読めなかった行として返す', () => {
      expect(parseBarrel("export { Card } from './Card';\nexport * from './Button';\n").unreadLines).toEqual([
        "export * from './Button';",
      ]);
    });

    it('使い手の無い部品と、使い手の無い部品だけが使う部品を返す (コメントの中の import は数えない)', () => {
      const imports = collectUiImports(
        new Map([
          [`${MOBILE_DIR}/app/settings/account.tsx`, 'import { EmptyState, type Card as C } from "../../src/components/ui";'],
          [`${UI_DIR}/EmptyState.tsx`, "import { Button } from './Button';"],
          [`${UI_DIR}/StatCard.tsx`, "import { Card } from './Card';"],
          [`${MOBILE_DIR}/src/components/Other.tsx`, '/* import { StatusBadge } from "./ui"; */\n// import { StatCard } from "./ui";'],
        ]),
        parts,
      );
      expect(unusedUiParts(parts, imports.byFile)).toEqual(['StatCard', 'StatusBadge']);
    });

    it('消した画面だけが使っていた部品 (#1598 の StatusBadge) は、画面を消すと使い手の無い部品になる', () => {
      const before = collectUiImports(
        new Map([
          [`${MOBILE_DIR}/app/(org)/org/invites.tsx`, 'import { Button, StatusBadge } from "../../../src/components/ui";'],
          [`${MOBILE_DIR}/app/settings/account.tsx`, 'import { Button } from "../../src/components/ui";'],
        ]),
        parts,
      );
      const after = new Map(before.byFile);
      after.delete(`${MOBILE_DIR}/app/(org)/org/invites.tsx`);
      expect(unusedUiParts(parts, before.byFile)).not.toContain('StatusBadge');
      expect(unusedUiParts(parts, after)).toContain('StatusBadge');
    });

    it('名前空間の import と、部品のファイルを直接指す import を見分ける', () => {
      const imports = collectUiImports(
        new Map([
          [`${MOBILE_DIR}/src/components/A.tsx`, "import * as UI from './ui';"],
          [`${MOBILE_DIR}/src/components/B.tsx`, "import { StatCard } from './ui/StatCard.tsx';"],
          [`${MOBILE_DIR}/src/components/C.tsx`, "import { Card } from '@homegohan/shared';"],
        ]),
        parts,
      );
      expect(imports.namespaceImports).toEqual([`${MOBILE_DIR}/src/components/A.tsx`]);
      expect([...imports.byFile.entries()]).toEqual([[`${MOBILE_DIR}/src/components/B.tsx`, new Set(['StatCard'])]]);
    });
  });

  it('ui/index.ts は「export { 名前 } from ./ファイル」の行だけでできている', () => {
    expect(barrel.unreadLines).toEqual([]);
    expect(barrel.parts.map((part) => part.name)).toContain(KNOWN_USED_PART);
  });

  it('ui の部品を名前空間で import しない (どの部品を使うかを読めなくなる)', () => {
    expect(uiImports.namespaceImports).toEqual([]);
  });

  it('どの部品も、残した画面か部品のどこかが使う (使い手の無くなった部品は、画面と一緒に消す)', () => {
    expect(unusedUiParts(barrel.parts, uiImports.byFile)).toEqual([]);
  });

  it('走査が空振りしていない (いまの画面が import する Card を見つける)', () => {
    const importers = [...uiImports.byFile.entries()]
      .filter(([file, names]) => file.startsWith(`${MOBILE_DIR}/app/`) && names.has(KNOWN_USED_PART))
      .map(([file]) => file);
    expect(importers.length).toBeGreaterThan(0);
  });
});
