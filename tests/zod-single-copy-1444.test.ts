// @vitest-environment node
/**
 * #1444 zod はルートと apps/mobile で同じ範囲を宣言し、package-lock.json の実体を 1 つ (node_modules/zod) にする。
 *
 * Dependabot #1420 と同じ zod の更新を入れたとき、`npm install zod@... -w . -w apps/mobile` で入れたため
 * (npm は `-w .` をルートとして扱わず、ルートにも入れるには --include-workspace-root が要る)、
 * apps/mobile の宣言だけが上がり、apps/mobile/node_modules/zod が入れ子で足され、ルートの zod は古いまま残った。
 *
 * zod が 2 つあると、Web とモバイルで別の版の zod が動く。さらに apps/mobile が読み込む
 * @homegohan/core (packages/core のスキーマ・zod は peer) はルートの node_modules/zod で解決されるので、
 * apps/mobile の宣言を上げても、モバイルで実際に使われる zod は上がらない。入れ子の zod は使われないまま lockfile に残る。
 *
 * 落ちたら: ルートと apps/mobile の package.json の zod を同じ範囲にそろえてから
 * `npm install --package-lock-only --ignore-scripts` で lockfile を作り直す。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
interface Lockfile {
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

const readJson = <T>(relativePath: string): T => JSON.parse(readFileSync(resolve(ROOT, relativePath), 'utf8')) as T;

const rootPkg = readJson<PackageJson>('package.json');
const mobilePkg = readJson<PackageJson>('apps/mobile/package.json');
const lock = readJson<Lockfile>('package-lock.json');

/** ルートの node_modules に巻き上げた 1 つだけの zod の場所 */
const HOISTED_ZOD = 'node_modules/zod';
/** ワークスペース (apps/*・packages/*) の入れ子の zod。npm が依存を持ち込む第三者のパッケージ (node_modules/** の下) は対象外 */
const WORKSPACE_NESTED_ZOD = /^(apps|packages)\/[^/]+\/node_modules\/zod$/;

describe('#1444 zod はルートと apps/mobile で 1 つにそろえる', () => {
  it('package.json: ルートと apps/mobile の zod の範囲が同じ', () => {
    const rootRange = rootPkg.dependencies?.zod;
    const mobileRange = mobilePkg.dependencies?.zod;
    expect(rootRange).toBeDefined();
    expect(mobileRange).toBe(rootRange);
  });

  it('package-lock.json: ワークスペースの下に入れ子の zod が無い', () => {
    const nested = Object.keys(lock.packages).filter((location) => WORKSPACE_NESTED_ZOD.test(location));
    expect(nested).toEqual([]);
  });

  it('package-lock.json: ルートの宣言 (package.json と lockfile のルートの行) が一致し、巻き上げた zod がその範囲の下限以上', () => {
    const rootRange = rootPkg.dependencies?.zod ?? '';
    expect(lock.packages['']?.dependencies?.zod).toBe(rootRange);
    expect(lock.packages['apps/mobile']?.dependencies?.zod).toBe(mobilePkg.dependencies?.zod);

    const floor = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(rootRange);
    const hoisted = /^(\d+)\.(\d+)\.(\d+)$/.exec(lock.packages[HOISTED_ZOD]?.version ?? '');
    expect(floor, `ルートの zod の範囲を ^x.y.z として読めない: ${rootRange}`).not.toBeNull();
    expect(hoisted, `${HOISTED_ZOD} の版を読めない`).not.toBeNull();
    const [, fMajor, fMinor, fPatch] = (floor ?? []).map(Number);
    const [, hMajor, hMinor, hPatch] = (hoisted ?? []).map(Number);
    expect(hMajor).toBe(fMajor);
    const atLeastFloor = hMinor > fMinor || (hMinor === fMinor && hPatch >= fPatch);
    expect(atLeastFloor, `${HOISTED_ZOD} ${lock.packages[HOISTED_ZOD]?.version} が ${rootRange} を満たさない`).toBe(true);
  });
});
