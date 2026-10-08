/**
 * #1199 React 本体と @types/react のメジャーバージョン不一致を防ぐ contract テスト
 *
 * 以前はルートの react / react-dom が 18 系なのに @types/react / @types/react-dom が 19 系で、
 * 実行時は React 18・型検査は React 19 という食い違いが Web アプリ (Next 14) に及んでいた。
 * React 19 の型にしかない書き方 (例: `<Context value={...}>`) が typecheck を素通りしかねなかった。
 * 型の版を実行時の React にそろえておくと、そうした書き方は型検査で落ちる。
 *
 * ただし、型の版をそろえても `use` / `useOptimistic` / `useActionState` / `useFormStatus` は止まらない。
 * Next 14 の型 (next/types/index.d.ts) が react/experimental と react-dom/experimental (canary の型) を
 * 読み込むため、@types/react が 18 系でも `npm run typecheck` を通る。#1275 (`use(params)` が本番で 500 に
 * なった) のような書き方を止めているのは eslint.config.mjs の ESLint ルールだけで、前提と挙動は
 * tests/eslint-react19-guard.test.ts が確かめる。このテストが守るのは「型の版をそろえておくこと」だけ。
 *
 * このテストは「React 本体と型のメジャーが同じ」であることを、宣言 (package.json) と
 * 実際に解決された版 (package-lock.json) の両方で確かめる。
 *
 *   - Web アプリ (ルート): react / react-dom ↔ @types/react / @types/react-dom
 *   - モバイル (apps/mobile): react ↔ @types/react (Expo 53 + React 19 で、ルートとは別の版を入れ子で持つ)
 *
 * モバイルは CI で型検査をしていないため、ルートの型を 18 系にした結果として
 * 「react-native などルートに巻き上げられたパッケージの型だけが React 18 の型で解決される」状態になると、
 * 気付かないままモバイルの型エラーが大きく増える。これを防ぐ apps/mobile/tsconfig.json の固定 (paths) が
 * 外れていないことも確かめる。
 *
 * 落ちたら: 片方だけ上げ下げしていないか確認し、React 本体と型を同時に同じメジャーへそろえる。
 * Web を React 19 / Next 15 に上げるときは、react と @types/react を一緒に上げ、
 * eslint.config.mjs の React 19 専用 API 禁止ルールと CLAUDE.md の記述も更新する。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface Lockfile {
  packages: Record<string, { version?: string }>;
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

/** "^18.3.1" / "~19.0.10" / "19.0.0" → 18 / 19 / 19 */
function majorOf(versionOrRange: string | undefined, what: string): number {
  const match = versionOrRange ? /\d+/.exec(versionOrRange) : null;
  if (!match) throw new Error(`${what} のバージョンを読み取れません: ${String(versionOrRange)}`);
  return Number(match[0]);
}

/**
 * package-lock.json 上で、`fromDir` (ルートは ''、ワークスペースは 'apps/mobile') から見て
 * `name` が実際にどの版に解決されるかを返す。Node と同じく入れ子の node_modules を先に探し、なければルートへ戻る。
 */
function resolveInLock(lock: Lockfile, fromDir: string, name: string): { location: string; version: string } {
  const candidates =
    fromDir === '' ? [`node_modules/${name}`] : [`${fromDir}/node_modules/${name}`, `node_modules/${name}`];
  for (const location of candidates) {
    const version = lock.packages[location]?.version;
    if (version) return { location, version };
  }
  throw new Error(`package-lock.json に ${name} が見つかりません (${fromDir || 'ルート'} から解決)`);
}

const rootPkg = readJson<PackageJson>('package.json');
const mobilePkg = readJson<PackageJson>('apps/mobile/package.json');
const lock = readJson<Lockfile>('package-lock.json');

describe('#1199 Web アプリ (ルート) の React 本体と型のメジャーが一致する', () => {
  it('package.json: @types/react は react と同じメジャー', () => {
    const react = majorOf(rootPkg.dependencies?.react, 'react');
    const types = majorOf(rootPkg.devDependencies?.['@types/react'], '@types/react');
    expect(types).toBe(react);
  });

  it('package.json: @types/react-dom は react-dom と同じメジャー', () => {
    const reactDom = majorOf(rootPkg.dependencies?.['react-dom'], 'react-dom');
    const types = majorOf(rootPkg.devDependencies?.['@types/react-dom'], '@types/react-dom');
    expect(types).toBe(reactDom);
  });

  it('package-lock.json: 実際に解決される @types/react は react と同じメジャー', () => {
    const react = majorOf(resolveInLock(lock, '', 'react').version, 'react');
    const types = majorOf(resolveInLock(lock, '', '@types/react').version, '@types/react');
    expect(types).toBe(react);
  });

  it('package-lock.json: 実際に解決される @types/react-dom は react-dom と同じメジャー', () => {
    const reactDom = majorOf(resolveInLock(lock, '', 'react-dom').version, 'react-dom');
    const types = majorOf(resolveInLock(lock, '', '@types/react-dom').version, '@types/react-dom');
    expect(types).toBe(reactDom);
  });

  it('react と react-dom は同じメジャー (片方だけ上げていない)', () => {
    const react = majorOf(rootPkg.dependencies?.react, 'react');
    const reactDom = majorOf(rootPkg.dependencies?.['react-dom'], 'react-dom');
    expect(reactDom).toBe(react);
  });
});

describe('#1199 モバイル (apps/mobile) の React 本体と型のメジャーが一致する', () => {
  it('package.json: @types/react は react と同じメジャー', () => {
    const react = majorOf(mobilePkg.dependencies?.react, 'apps/mobile の react');
    const types = majorOf(mobilePkg.devDependencies?.['@types/react'], 'apps/mobile の @types/react');
    expect(types).toBe(react);
  });

  it('package-lock.json: apps/mobile から見て解決される @types/react は react と同じメジャー', () => {
    // ルートの @types/react は Web (React 18) 用なので、モバイルは apps/mobile/node_modules に自前の版を持つ必要がある。
    const react = majorOf(resolveInLock(lock, 'apps/mobile', 'react').version, 'apps/mobile から見た react');
    const types = majorOf(
      resolveInLock(lock, 'apps/mobile', '@types/react').version,
      'apps/mobile から見た @types/react',
    );
    expect(types).toBe(react);
  });
});

describe('#1199 Web とモバイルで @types/react のメジャーが違う間は、モバイルの tsconfig で react の型を固定している', () => {
  const webTypes = resolveInLock(lock, '', '@types/react');
  const mobileTypes = resolveInLock(lock, 'apps/mobile', '@types/react');
  const webMajor = majorOf(webTypes.version, 'Web の @types/react');
  const mobileMajor = majorOf(mobileTypes.version, 'モバイルの @types/react');
  // 同じメジャーでルートに 1 つだけ巻き上げられている (固定が不要な) 場合は、この 2 件は実行しない
  const dualTypes = webMajor !== mobileMajor;

  // tsconfig はコメントを書けるので、JSON.parse ではなく TypeScript の読み込みを使う
  const mobileTsconfig = ts.parseConfigFileTextToJson(
    'apps/mobile/tsconfig.json',
    readText('apps/mobile/tsconfig.json'),
  ).config as { compilerOptions?: { paths?: Record<string, string[]> } };

  it.runIf(dualTypes)('モバイルの @types/react は apps/mobile/node_modules に入れ子で入っている', () => {
    expect(mobileTypes.location).toBe('apps/mobile/node_modules/@types/react');
  });

  it.runIf(dualTypes)(
    'apps/mobile/tsconfig.json の paths.react が入れ子の @types/react を指す (react-native などの型も React 19 で解決させる)',
    () => {
      // 固定しないと、ルートに巻き上げられた react-native などが React 18 の型で解決され、
      // モバイルの型検査で TS2786 (JSX コンポーネントとして使えない) などが一斉に増える。
      // 末尾が .d.ts の別名は Expo の Metro に無視される (実行時の react の解決は metro.config.js のまま) ので安全。
      expect(mobileTsconfig.compilerOptions?.paths?.react).toEqual(['./node_modules/@types/react/index.d.ts']);
    },
  );
});
