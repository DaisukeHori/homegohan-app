// @vitest-environment node
/**
 * tests/next-swc-styled-jsx-transform.test.ts
 *
 * `<style jsx>` (styled-jsx) を持つファイルが、Next 15 の SWC の変換で止まらないことを確かめる (#1444)。
 *
 * Next 15.5.27 の SWC は、`<style jsx global>` がある src/components/AIChatBubble.tsx で、変数に入れたコンポーネント
 * (`const Icon = actionInfo?.icon || Sparkles; <Icon />`) を JSX で描く形に当たると、SSR 向けとブラウザ向けの変換が
 * 終わらなくなった (CPU を 1 つ使い続ける)。next build は「Creating an optimized production build ...」のまま 30 分以上進まず、
 * next dev でもこの部品を読む画面が開かなくなる。変換は Next の SWC (ネイティブ) の中で止まるので、
 * 型検査・lint・単体テストでは見つからない。ここで、next build と同じ Next の SWC と同じ層の設定で変換して確かめる。
 *
 * 変換が止まると子のプロセスは終わらないので、時間を区切って打ち切り、止まったファイルと層を出す。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
/** styled-jsx を探す範囲 (Web アプリのソース) */
const SOURCE_DIRS = ['src', 'components', 'lib'];
/** next build が変換する層: サーバーの部品 (rsc)・SSR (ssr)・ブラウザ (app-pages-browser) */
const LAYERS = ['rsc', 'ssr', 'app-pages-browser'] as const;
/**
 * 子のプロセス全体の時間切れ (ミリ秒)。止まらなければ、1 ファイル・1 層の変換は数十ミリ秒で終わり、
 * Next の SWC の読み込みを含めても数秒。負荷の高い機械でも誤って落ちないよう、大きめにとる
 */
const CHILD_TIMEOUT_MS = 60_000;
/** テストそのものの時間切れ (ミリ秒)。子の時間切れより長くする */
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 30_000;

function listStyledJsxFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx|jsx)$/.test(entry.name) && readFileSync(full, 'utf8').includes('<style jsx')) out.push(full);
    }
  };
  for (const dir of SOURCE_DIRS) walk(path.join(ROOT, dir));
  return out.sort();
}

/** 子のプロセスで動かす: 受け取ったファイルを各層で変換し、始める前と終えたあとに 1 行ずつ出す */
const CHILD_SCRIPT = `
const path = require('node:path');
const fs = require('node:fs');
const [root, layersJson, ...files] = process.argv.slice(1);
const swc = require(require.resolve('next/dist/build/swc', { paths: [root] }));
const { getLoaderSWCOptions } = require(require.resolve('next/dist/build/swc/options', { paths: [root] }));
(async () => {
  await swc.loadBindings();
  for (const file of files) {
    for (const layer of JSON.parse(layersJson)) {
      const options = getLoaderSWCOptions({
        filename: file, development: false, isServer: layer !== 'app-pages-browser', appDir: path.join(root, 'src/app'),
        isPageFile: false, hasReactRefresh: false, jsConfig: { compilerOptions: {} },
        relativeFilePathFromRoot: path.relative(root, file), serverComponents: true, serverReferenceHashSalt: '',
        bundleLayer: layer, esm: true, useCacheEnabled: false, cacheHandlers: {}, isCacheComponents: false,
        trackDynamicImports: false,
      });
      console.log('START ' + path.relative(root, file) + ' ' + layer);
      await swc.transform(fs.readFileSync(file, 'utf8'), { ...options, filename: file, sourceMaps: false });
      console.log('DONE ' + path.relative(root, file) + ' ' + layer);
    }
  }
  process.exit(0);
})().catch((error) => { console.log('ERROR ' + String(error)); process.exit(1); });
`;

describe('styled-jsx を持つファイルを、Next 15 の SWC が止まらずに変換できる (#1444)', () => {
  const files = listStyledJsxFiles();

  it('styled-jsx を持つファイルを見つけている (探し方が空回りしていない)', () => {
    expect(files.map((f) => path.relative(ROOT, f))).toContain('src/components/AIChatBubble.tsx');
  });

  it(
    'すべてのファイルを、すべての層で、時間内に変換し終える',
    () => {
      const result = spawnSync(process.execPath, ['-e', CHILD_SCRIPT, ROOT, JSON.stringify(LAYERS), ...files], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: CHILD_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      const lines = result.stdout.split('\n').filter(Boolean);
      const started = lines.filter((l) => l.startsWith('START ')).map((l) => l.slice('START '.length));
      const done = new Set(lines.filter((l) => l.startsWith('DONE ')).map((l) => l.slice('DONE '.length)));
      const stuck = started.filter((s) => !done.has(s));

      expect(stuck, `変換が終わらなかったファイルと層: ${stuck.join(', ')}`).toEqual([]);
      expect(lines.filter((l) => l.startsWith('ERROR ')), result.stderr).toEqual([]);
      expect(result.status).toBe(0);
      // すべてのファイル × 層を変換したこと
      expect(done.size).toBe(files.length * LAYERS.length);
    },
    TEST_TIMEOUT_MS,
  );
});
