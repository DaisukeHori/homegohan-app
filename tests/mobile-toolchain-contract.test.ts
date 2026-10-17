/**
 * #1591 モバイルのツールチェーンの版の組と、OTA の設定の固定
 *
 * モバイルの React は react-native に入っているレンダラーと「完全に同じ版」でないと動かない (ルート CLAUDE.md)。
 * Expo は SDK ごとに合う版を expo/bundledNativeModules.json に持ち、`npx expo install --fix` がそれに合わせる。
 * Dependabot の react-native のパッチ更新 (許している) や手作業の更新で片方だけが上がると、起動時に落ちる。
 * ここでは次を固定する。
 *   1. apps/mobile の react / react-native / react-native-reanimated / expo-router / jest-expo の宣言が、
 *      入っている expo の bundledNativeModules.json の値と同じ (react-test-renderer は react と同じ版)
 *   2. package-lock.json で apps/mobile から解決される react と react-test-renderer が同じ版で、react-native が宣言と同じ
 *   3. jest は 30 系で、jest-expo の必須の peer @react-native/jest-preset が react-native と同じ版
 *   3b. lockfile の置き場: react-native・@react-native/jest-preset・react-test-renderer・jest・jest-expo・expo はルートに巻き上がり、
 *      apps/mobile の入れ子は react と @types/react だけ (@react-native/jest-preset は自分の場所から react-native を
 *      Node の require.resolve で引き、jest.config.js の moduleNameMapper は react-test-renderer をルートに写すため。
 *      lockfile を 1 回で作り直すと react-native ほかが入れ子になり、Jest が preset の読み込みで止まる。docs/design/mobile/07 §2.4)
 *   4. app.json の runtimeVersion は fingerprint の方針 (トップレベルだけ) で、更新は無効のまま
 *      (OTA を使う設計が通ったら、その設計がこの 2 行の期待を書き換える)
 *   5. expo-file-system は /legacy の入口だけを読む (新旧の API を混ぜない)。アプリのソースに加えて Jest のテストの
 *      jest.mock と import も見る (テストが既定の入口から mock の関数を取り出すと、SDK 58 では mock でない本物の入口になって落ちる)
 *   6. 使っていないので消した依存が、import の無いまま戻っていない
 *   7. expo install --check から外すのは typescript だけ (ルートと同じ 1 つの typescript に据え置く。ほかの依存のずれは --check に報告させる)。
 *      Jest の resolver は react-native-reanimated/jest/resolver (Reanimated 4 の内部ファイルを Jest の下で読む。docs/design/mobile/07 §7.2 C-10)
 * 落ちたら: SDK の更新としてまとめて上げる (docs/design/mobile/07-toolchain-upgrade.md §6)。片方だけ上げない。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MOBILE_DIR = 'apps/mobile';
const MOBILE_PACKAGE_JSON = `${MOBILE_DIR}/package.json`;
const MOBILE_APP_JSON = `${MOBILE_DIR}/app.json`;
const MOBILE_JEST_CONFIG = `${MOBILE_DIR}/jest.config.js`;
const LOCKFILE = 'package-lock.json';
/** expo が SDK ごとに決める版の表 (expo install --fix / --check が読む)。ルートの node_modules に巻き上がる */
const BUNDLED_NATIVE_MODULES = 'node_modules/expo/bundledNativeModules.json';
/** Jest のメジャー (jest-expo 58 が Jest 30 の依存で組まれている) */
const JEST_MAJOR = 30;
/** runtimeVersion の方針。ネイティブに効く依存と設定のハッシュ (docs/design/mobile/07 §11) */
const RUNTIME_VERSION_POLICY = 'fingerprint';
/** 宣言を bundledNativeModules と逐語で合わせるパッケージ */
const BUNDLED_PINNED = ['react', 'react-native', 'react-native-reanimated', 'react-native-worklets', 'expo-router', 'jest-expo'] as const;
/** #1591 で消した、使っていない依存。戻すなら import する所と一緒に足し、ここから外す */
const REMOVED_UNUSED = ['@react-native-community/slider', 'expo-haptics', 'expo-image-manipulator'] as const;
/** ルートに巻き上がっていなければならないツールチェーン (docs/design/mobile/07 §2.4・§10.1) */
const HOISTED_TOOLCHAIN = ['react-native', '@react-native/jest-preset', 'react-test-renderer', 'jest', 'jest-expo', 'expo'] as const;
/** apps/mobile/node_modules に入れ子で持ってよいもの (Web と版が違う React とその型だけ) */
const MOBILE_NESTED_ALLOWED = ['@types/react', 'react'] as const;
/** lockfile の packages のキーで、apps/mobile の入れ子の接頭辞 */
const MOBILE_NESTED_PREFIX = `${MOBILE_DIR}/node_modules/`;
/** expo-file-system の指定子を見るディレクトリ (アプリのソースと Jest のテスト) */
const FILE_SYSTEM_SCAN_DIRS = [`${MOBILE_DIR}/app`, `${MOBILE_DIR}/src`, `${MOBILE_DIR}/__tests__`];
const SOURCE_FILE = /\.(ts|tsx)$/;
/** import の from・require・jest.mock の第 1 引数にある expo-file-system の指定子 (第 1 グループは /legacy などの下の入口) */
const FILE_SYSTEM_SPECIFIER = /(?:from\s+|require\(\s*|jest\.mock\(\s*)['"]expo-file-system(\/[^'"]*)?['"]/g;
const FILE_SYSTEM_LEGACY_SUBPATH = '/legacy';
/** FILE_SYSTEM_SPECIFIER が拾う形の見本。subpath は第 1 グループ (下の入口。既定の入口は undefined) */
interface FileSystemSpecifierSample {
  label: string;
  sample: string;
  subpath: string | undefined;
}
/**
 * 走査の it は「既定の入口が 0 件」しか確かめないので、正規表現の 3 つの選択肢 (`from`・`require(`・`jest.mock(`) の
 * どれかが欠けても、違反を見逃したまま緑になる。見本で拾う力を固定する。jest.mock の見本は、後から足された Jest のテストが
 * mock の指定子を既定の入口のまま書いた形 (__tests__/settings/export-rows.test.tsx。#1876)
 */
const FILE_SYSTEM_SPECIFIER_SAMPLES: readonly FileSystemSpecifierSample[] = [
  { label: '既定の入口の import', sample: "import * as FileSystem from 'expo-file-system';", subpath: undefined },
  { label: '/legacy の import', sample: 'import * as FileSystem from "expo-file-system/legacy";', subpath: FILE_SYSTEM_LEGACY_SUBPATH },
  { label: '/legacy でない下の入口の import', sample: "import { File } from 'expo-file-system/next';", subpath: '/next' },
  { label: '既定の入口の require', sample: "const FileSystem = require('expo-file-system');", subpath: undefined },
  { label: '既定の入口の jest.mock', sample: "jest.mock('expo-file-system', () => ({", subpath: undefined },
  { label: '改行をはさんだ既定の入口の jest.mock', sample: "jest.mock(\n  'expo-file-system',\n  () => ({}),\n);", subpath: undefined },
  { label: '/legacy の jest.mock', sample: "jest.mock('expo-file-system/legacy', () => ({", subpath: FILE_SYSTEM_LEGACY_SUBPATH },
];
/**
 * expo install --check から外す依存 (apps/mobile/package.json の expo.install.exclude)。typescript だけ:
 * SDK 58 の --check は Expo の API の relatedPackages (typescript ~6.0.3) とも突き合わせるが、ルートと同じ 5.9.3 に据え置く
 * (docs/design/mobile/07 §6.4)。ほかの依存を足すと、その依存の SDK とのずれを --check が報告しなくなる
 */
const EXPO_INSTALL_EXCLUDED = ['typescript'] as const;
/** jest.config.js の resolver (Reanimated 4 の Jest の resolver。docs/design/mobile/07 §7.2 C-10・§9.2) */
const MOBILE_JEST_RESOLVER = 'react-native-reanimated/jest/resolver';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  expo?: { install?: { exclude?: unknown } };
}
interface Lockfile {
  packages: Record<string, { version?: string }>;
}
interface AppJson {
  expo: {
    runtimeVersion?: unknown;
    ios?: { runtimeVersion?: unknown };
    android?: { runtimeVersion?: unknown };
    updates?: { enabled?: unknown; checkAutomatically?: unknown };
  };
}

const readText = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = <T>(rel: string): T => JSON.parse(readText(rel)) as T;

const mobilePkg = readJson<PackageJson>(MOBILE_PACKAGE_JSON);
const lock = readJson<Lockfile>(LOCKFILE);
const bundled = readJson<Record<string, string>>(BUNDLED_NATIVE_MODULES);
const appJson = readJson<AppJson>(MOBILE_APP_JSON);

/** package-lock.json 上で fromDir ('' はルート) から見て name がどの版に解決されるか。入れ子を先に探し、無ければルートへ戻る */
function resolveInLock(fromDir: string, name: string): { location: string; version: string } {
  const segments = fromDir === '' ? [] : fromDir.split('/');
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const base = segments.slice(0, depth).join('/');
    const location = `${base === '' ? '' : `${base}/`}node_modules/${name}`;
    const version = lock.packages[location]?.version;
    if (version !== undefined) return { location, version };
  }
  throw new Error(`package-lock.json に ${name} が見つかりません (${fromDir === '' ? 'ルート' : fromDir} から解決)`);
}

/** "~30.5.2" / "^19.0.0" / "19.3.0" → 30 / 19 / 19 */
function majorOf(range: string | undefined, what: string): number {
  const match = range === undefined ? null : /\d+/.exec(range);
  if (match === null) throw new Error(`${what} のバージョンを読み取れません: ${String(range)}`);
  return Number(match[0]);
}

function listSourceFiles(dirRel: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dirRel), { withFileTypes: true })) {
    const rel = `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__' && entry.name !== '__mocks__') out.push(...listSourceFiles(rel));
    } else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
  return out;
}

describe('#1591 apps/mobile の版の組 (bundledNativeModules と同じ)', () => {
  it.each(BUNDLED_PINNED)('%s の宣言は expo/bundledNativeModules.json の値と同じ', (name) => {
    const declared = mobilePkg.dependencies?.[name] ?? mobilePkg.devDependencies?.[name];
    expect(declared, `${name} が apps/mobile/package.json に無い`).toBeDefined();
    expect(bundled[name], `${name} が bundledNativeModules.json に無い`).toBeDefined();
    expect(declared).toBe(bundled[name]);
  });

  it('react-test-renderer の宣言は react と同じ版 (レンダラーは React と完全に同じ版でないと動かない)', () => {
    expect(mobilePkg.devDependencies?.['react-test-renderer']).toBe(mobilePkg.dependencies?.react);
  });

  it('package-lock.json: apps/mobile から見た react と react-test-renderer が同じ版で、react-native が宣言と同じ', () => {
    const react = resolveInLock(MOBILE_DIR, 'react').version;
    expect(react).toBe(mobilePkg.dependencies?.react);
    expect(resolveInLock(MOBILE_DIR, 'react-test-renderer').version).toBe(react);
    expect(resolveInLock(MOBILE_DIR, 'react-native').version).toBe(mobilePkg.dependencies?.['react-native']);
  });

  it(`jest は ${JEST_MAJOR} 系で、jest-expo の必須の peer @react-native/jest-preset は react-native と同じ版`, () => {
    expect(majorOf(mobilePkg.devDependencies?.jest, 'jest')).toBe(JEST_MAJOR);
    expect(majorOf(resolveInLock(MOBILE_DIR, 'jest').version, 'jest (lock)')).toBe(JEST_MAJOR);
    expect(mobilePkg.devDependencies?.['@react-native/jest-preset']).toBe(mobilePkg.dependencies?.['react-native']);
  });

  it('package-lock.json: react-native・@react-native/jest-preset・react-test-renderer・jest・jest-expo・expo はルートにあり、apps/mobile の入れ子は react と @types/react だけ', () => {
    for (const name of HOISTED_TOOLCHAIN) {
      expect(lock.packages[`node_modules/${name}`]?.version, `${name} がルートの node_modules に無い`).toBeDefined();
    }
    const nested = Object.keys(lock.packages)
      .filter((location) => location.startsWith(MOBILE_NESTED_PREFIX))
      .map((location) => location.slice(MOBILE_NESTED_PREFIX.length))
      .sort();
    expect(nested).toEqual([...MOBILE_NESTED_ALLOWED].sort());
  });

  it.each(REMOVED_UNUSED)('使っていないので消した %s が宣言に戻っていない', (name) => {
    expect(mobilePkg.dependencies?.[name]).toBeUndefined();
    expect(mobilePkg.devDependencies?.[name]).toBeUndefined();
  });
});

describe('#1591 OTA の設定 (app.json)', () => {
  it(`runtimeVersion はトップレベルの { policy: '${RUNTIME_VERSION_POLICY}' } だけ (ios / android の直書きは無い)`, () => {
    expect(appJson.expo.runtimeVersion).toEqual({ policy: RUNTIME_VERSION_POLICY });
    expect(appJson.expo.ios?.runtimeVersion).toBeUndefined();
    expect(appJson.expo.android?.runtimeVersion).toBeUndefined();
  });

  it('更新は無効のまま (enabled: false・checkAutomatically: NEVER)。OTA を使う設計が通るまで変えない', () => {
    expect(appJson.expo.updates?.enabled).toBe(false);
    expect(appJson.expo.updates?.checkAutomatically).toBe('NEVER');
  });
});

describe('#1591 expo-file-system は /legacy の入口だけを読む', () => {
  it('app/・src/・__tests__ の import・require・jest.mock の指定子はすべて expo-file-system/legacy', () => {
    const offenders: string[] = [];
    let imports = 0;
    for (const file of FILE_SYSTEM_SCAN_DIRS.flatMap(listSourceFiles)) {
      const text = readText(file);
      const pattern = new RegExp(FILE_SYSTEM_SPECIFIER.source, 'g');
      let match: RegExpExecArray | null = pattern.exec(text);
      while (match !== null) {
        imports += 1;
        if (match[1] !== FILE_SYSTEM_LEGACY_SUBPATH) offenders.push(`${file}: expo-file-system${match[1] ?? ''}`);
        match = pattern.exec(text);
      }
    }
    expect(imports, '走査が空振りしていない (expo-file-system を読むファイルがある)').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it.each(FILE_SYSTEM_SPECIFIER_SAMPLES)('指定子の正規表現は $label を拾い、下の入口を読み分ける', ({ sample, subpath }) => {
    const match = new RegExp(FILE_SYSTEM_SPECIFIER.source, 'g').exec(sample);
    expect(match, `拾えていない: ${sample}`).not.toBeNull();
    expect(match?.[1]).toBe(subpath);
  });
});

describe('#1591 expo install --check と Jest の resolver', () => {
  it('expo install --check から外すのは typescript だけで、apps/mobile の typescript はルートと同じ 1 つ (入れ子にしない)', () => {
    expect(mobilePkg.expo?.install?.exclude).toEqual([...EXPO_INSTALL_EXCLUDED]);
    expect(resolveInLock(MOBILE_DIR, 'typescript').location).toBe('node_modules/typescript');
  });

  it(`jest.config.js の resolver は ${MOBILE_JEST_RESOLVER} で、apps/mobile から解決できる`, () => {
    const config = readText(MOBILE_JEST_CONFIG);
    expect(config).toContain(`resolver: require.resolve('${MOBILE_JEST_RESOLVER}')`);
    const requireFromMobile = createRequire(path.join(ROOT, MOBILE_PACKAGE_JSON));
    expect(fs.existsSync(requireFromMobile.resolve(MOBILE_JEST_RESOLVER))).toBe(true);
  });
});
