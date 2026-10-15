// @vitest-environment node
//
// #1686: Edge Function のデプロイを、ランナーの Docker を使わずに Supabase のサーバーでまとめる (--use-api) 形の確かめ
//
// 背景: `supabase functions deploy` は --use-api を付けないと、Docker の edge-runtime のイメージを public.ecr.aws から認証なしで
// 取って手元で関数をまとめる。2026-10-15 にこの取得が ECR の上限 (toomanyrequests: Data limit exceeded) で落ち、
// calculate-segment-stats の新しい版がデプロイされなかった (#1523 の取得元の切り替えは supabase start と db diff の経路だけ)。
//
// ここで確かめること (本番にも Docker にもネットワークにも触らない):
//   1. デプロイのワークフローは --use-api と --import-map supabase/functions/deno.json を付けて全関数を配り、同じジョブで
//      Docker のイメージを取る supabase の呼び出し (db dump / db diff / start / gen types / functions serve など) や docker を打たない
//   2. --use-api のとき CLI が関数ごとに送るファイル (入口・そこから相対パスの import でたどれるファイル・import map) に、
//      関数が実際に import するローカルのファイルがすべて入っている。CLI 2.62.10 は正規表現で import の行を探すだけなので
//      (pkg/function/deno.go の importPathPattern / WalkImportPaths)、書き方によっては拾えない (例: `import type {` で改行する
//      複数行の import)。拾えないと、そのファイルがサーバーに送られず、まとめが「見つからない」で落ちる。
//      CLI と同じたどり方を写して送るファイルを数え、TypeScript の構文解析 (ts.preProcessFile) で拾った import と突き合わせる。
//      deno.json の名前 (zod など) は、import map のキーに無ければ解決できないので、それも確かめる
//   3. デプロイの段の run を偽の npx で動かし、成功・イメージの取得の失敗 (終了コード 75・[image-pull-unavailable])・
//      デプロイそのものの失敗 (CLI の終了コードのまま) を分けて出すことを確かめる
//
// CLI の出典: supabase/cli v2.62.10 の cmd/functions.go (--use-api で Docker を使わない)、internal/functions/deploy/deploy.go
// (Run・GetFunctionSlugs・GetFunctionConfig。--import-map は全関数に効く)、pkg/function/deploy.go (writeForm)、
// pkg/function/deno.go (ImportMap.Load / Resolve / WalkImportPaths)。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 1 件のテストの中で子プロセス (bash) を起こすので、負荷の高い機械で vitest の既定の時間切れを超えうる (#1605 の同じ型)。
// このファイルだけ延ばす (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = '.github/workflows/deploy-supabase-functions.yml';
const DEPLOY_STEP = 'Deploy all functions';
const CLI_VERSION_STEP = 'Verify Supabase CLI version';
const FUNCTIONS_DIR = 'supabase/functions';
/** --import-map で全関数に渡す、共通の import map (Deno の設定ファイル) */
const IMPORT_MAP = 'supabase/functions/deno.json';
const IMAGE_PULL_LIB = 'scripts/lib/supabase-image-pull.sh';
/** GitHub Actions が shell: bash の段を動かすときの bash の引数 */
const ACTIONS_BASH_ARGS = ['--noprofile', '--norc', '-eo', 'pipefail'];
/** 段の run の中で GitHub Actions が置き換える、project ref の式 */
const PROJECT_REF_EXPRESSION = '${{ env.SUPABASE_PROJECT_ID }}';
/** 段を動かすときに式の代わりに入れる project ref (本物ではない) */
const FAKE_PROJECT_REF = 'testprojectref';
/** 段の 1 行 (取得の失敗) の目印。scripts/lib/supabase-image-pull.sh の SIP_UNAVAILABLE_TAG と同じ (下で source して突き合わせる) */
const UNAVAILABLE_TAG = '[image-pull-unavailable]';
/** CLI が失敗したときの終了コード (偽の npx が返す。CLI はエラーで 1 を返す) */
const CLI_EXIT_FAILURE = 1;
/** CLI の終了コードを段がそのまま返すことを見るための、1 でも 75 でもない値 */
const CLI_EXIT_OTHER = 3;

/** CLI 2.62.10 の GetFunctionSlugs が関数の名前に許す形 (utils.FuncSlugPattern) */
const CLI_FUNC_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
/**
 * CLI 2.62.10 の pkg/function/deno.go の importPathPattern を写したもの (Go の (?i) は i フラグ)。
 * Go の RE2 と JS で意味が同じ書き方だけを使っている (. は改行に当たらない・[^{}] は改行に当たる・*? は最短)
 */
const CLI_IMPORT_PATH_PATTERN = /(?:import|export)\s+(?:\{[^{}]+\}|.*?)\s*(?:from)?\s*['"](.*?)['"]|import\(\s*['"](.*?)['"]\)/gi;
/** URL のスキーム (npm: / jsr: / node: / https: など)。Go の url.Parse でスキームが付くもの */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

type Step = { name?: string; shell?: string; run?: string; env?: Record<string, string> };
type Workflow = { on: { push?: unknown; pull_request?: unknown; workflow_dispatch?: unknown }; jobs: Record<string, { steps: Step[] }> };

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const workflowText = read(WORKFLOW);
const workflow = yaml.load(workflowText) as Workflow;
const deploySteps = workflow.jobs.deploy.steps;
const deployStep = deploySteps.find((step) => step.name === DEPLOY_STEP);
const BASH = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. ワークフローの形
// ---------------------------------------------------------------------------

/** 全関数のデプロイの形 (--use-api と、共通の import map) */
const DEPLOY_USE_API = /\bsupabase@\d+\.\d+\.\d+ functions deploy --use-api --import-map supabase\/functions\/deno\.json --project-ref /;

/**
 * Docker のイメージを手元で取る呼び出し (CLI 2.62.10 で Docker を使うのは db dump / db diff / db reset / db start / db test /
 * start / gen types / functions serve / functions download (--use-api を付けないとき) / functions deploy (--use-api を付けないとき)。
 * internal/ の DockerRunOnce・DockerStart の呼び出し元)。docker を直接打つものも数える
 */
const DOCKER_USING_CALLS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'supabase db dump / diff / reset / start / test', pattern: /\bsupabase(?:@[\d.]+)? db (?:dump|diff|reset|start|test)\b/ },
  { label: 'supabase start', pattern: /\bsupabase(?:@[\d.]+)? start\b/ },
  { label: 'supabase gen types', pattern: /\bsupabase(?:@[\d.]+)? gen types\b/ },
  { label: 'supabase functions serve', pattern: /\bsupabase(?:@[\d.]+)? functions serve\b/ },
  { label: 'supabase functions download / deploy (--use-api なし)', pattern: /\bsupabase(?:@[\d.]+)? functions (?:download|deploy)\b(?![^\n]*--use-api)/ },
  // コマンドとしての docker だけ (行頭か ; & | ( の後)。エラーの文の中の「pull docker image」は数えない
  { label: 'docker', pattern: /(?:^\s*|[;&|(]\s*)docker\s/ },
];

/** デプロイのジョブの段の run (コメントの行は除く) から、Docker のイメージを手元で取る呼び出しを探す */
function dockerUsingCalls(steps: readonly Step[]): string[] {
  const found: string[] = [];
  for (const step of steps) {
    const lines = (step.run ?? '').split('\n').filter((line) => !/^\s*#/.test(line));
    for (const line of lines) {
      for (const { label, pattern } of DOCKER_USING_CALLS) {
        if (pattern.test(line)) found.push(`${step.name ?? '(名前なし)'}: ${label}: ${line.trim()}`);
      }
    }
  }
  return found;
}

describe('#1686 デプロイのワークフローは Docker を使わずにサーバーでまとめる', () => {
  it('全関数のデプロイは --use-api と --import-map supabase/functions/deno.json を付けて 1 回だけ打つ', () => {
    expect(deployStep, `${DEPLOY_STEP} の段が無い`).toBeDefined();
    expect(deployStep?.shell).toBe('bash');
    const run = deployStep?.run ?? '';
    const deployLines = run.split('\n').filter((line) => /\bfunctions deploy\b/.test(line) && !/^\s*#/.test(line));
    expect(deployLines).toHaveLength(1);
    expect(deployLines[0]).toMatch(DEPLOY_USE_API);
    expect(deployLines[0]).toContain(`--project-ref ${PROJECT_REF_EXPRESSION}`);
    expect(deployStep?.env?.SUPABASE_ACCESS_TOKEN).toBe('${{ secrets.SUPABASE_ACCESS_TOKEN }}');
  });

  it('デプロイの CLI の版は、版を確かめる段の版と同じ', () => {
    const versionOf = (text: string) => text.match(/\bsupabase@(\d+\.\d+\.\d+)\b/)?.[1];
    const checked = versionOf(deploySteps.find((step) => step.name === CLI_VERSION_STEP)?.run ?? '');
    expect(checked).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionOf(deployStep?.run ?? '')).toBe(checked);
  });

  it('--import-map で渡す deno.json があり、imports を持ち、関数のディレクトリの直下 (全関数の共通) にある', () => {
    const importMap = JSON.parse(read(IMPORT_MAP)) as { imports?: Record<string, string> };
    expect(Object.keys(importMap.imports ?? {}).length).toBeGreaterThan(0);
    expect(path.posix.dirname(IMPORT_MAP)).toBe(FUNCTIONS_DIR);
  });

  it('デプロイのジョブは、Docker のイメージを手元で取る supabase の呼び出しも docker も打たない', () => {
    expect(dockerUsingCalls(deploySteps)).toEqual([]);
  });

  it('PR では動かない (本番へのデプロイは main への push と手での実行だけ)', () => {
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.push).toBeDefined();
  });

  it.each([
    ['--use-api を外す', (run: string) => run.replace(' --use-api', '')],
    ['--import-map を外す', (run: string) => run.replace(` --import-map ${IMPORT_MAP}`, '')],
    ['関数のデプロイの前に db dump を打つ', (run: string) => `npx --yes supabase@2.62.10 db dump --linked -f x.sql\n${run}`],
    ['docker pull を打つ', (run: string) => `docker pull public.ecr.aws/supabase/edge-runtime:v1.69.25\n${run}`],
  ])('%s と、問題として見つける (検査が空振りしない)', (_title, mutate) => {
    const run = deployStep?.run ?? '';
    const mutated = mutate(run);
    expect(mutated).not.toBe(run);
    const steps = deploySteps.map((step) => (step === deployStep ? { ...step, run: mutated } : step));
    const deployLine = mutated.split('\n').find((line) => /\bfunctions deploy\b/.test(line)) ?? '';
    expect(dockerUsingCalls(steps).length > 0 || !DEPLOY_USE_API.test(deployLine)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. --use-api のとき CLI が送るファイルに、関数が import するローカルのファイルがすべて入っている
// ---------------------------------------------------------------------------

/** Go の path.Ext (最後の / より後ろの、最後の . から後ろ。無ければ空) */
function goExt(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot > file.lastIndexOf('/') ? file.slice(dot) : '';
}
const isRelPath = (mod: string) => mod.startsWith('./') || mod.startsWith('../');
const isAbsPath = (mod: string) => mod.startsWith('/');

/** CLI の ImportMap.Load + Resolve: imports の値のうち、URL でも絶対パスでもないものを import map のファイルからの相対で解く */
function cliImportMap(importMapPath: string, readFile: (rel: string) => string): Array<[string, string]> {
  const parsed = JSON.parse(readFile(importMapPath)) as { imports?: Record<string, string> };
  return Object.entries(parsed.imports ?? {}).map(([key, value]) => {
    if (isAbsPath(value) || URL_SCHEME.test(value)) return [key, value];
    let resolved = path.posix.join(path.posix.dirname(importMapPath), value);
    if (value.endsWith('/')) resolved += '/';
    return [key, path.posix.isAbsolute(resolved) ? resolved : `./${resolved}`];
  });
}

/**
 * CLI の ImportMap.WalkImportPaths を写したもの: 入口から、正規表現で拾った import をたどり、読めたファイルを返す。
 * 送るのは、ここで読めたファイルと import map だけ (static_files は config.toml に書いていない。verify_jwt の検査が他のキーを止める)
 */
function cliUploadedFiles(
  entrypoint: string,
  importMap: ReadonlyArray<[string, string]>,
  readFile: (rel: string) => string | null,
): Set<string> {
  const seen = new Set<string>();
  const uploaded = new Set<string>();
  const queue = [entrypoint];
  while (queue.length > 0) {
    const curr = queue.pop() as string;
    if (seen.has(curr)) continue;
    seen.add(curr);
    const text = readFile(curr);
    // CLI は読めないファイルを WARN にして続ける (送らない)
    if (text === null) continue;
    uploaded.add(curr);
    for (const match of text.matchAll(CLI_IMPORT_PATH_PATTERN)) {
      let mod = (match[1] || match[2] || '').trim();
      let substituted = false;
      for (const [key, value] of importMap) {
        if (mod.startsWith(key)) {
          mod = value + mod.slice(key.length);
          substituted = true;
        }
      }
      if (goExt(mod) === '') continue;
      if (!isRelPath(mod) && !isAbsPath(mod)) continue;
      if (isRelPath(mod) && !substituted) mod = path.posix.join(path.posix.dirname(curr), mod);
      queue.push(path.posix.normalize(mod));
    }
  }
  return uploaded;
}

type ModuleGraph = { local: Set<string>; problems: string[] };

/**
 * 関数が実際に import するローカルのファイル (TypeScript の構文解析で、import / export ... from / import() / import type /
 * /// <reference path> / /// <reference types> を拾う)。deno.json の名前は import map のキー (完全一致か「キー/」で始まる) で解く。
 * 解けない名前・無いファイルは problems に入れる
 */
function localModuleGraph(
  entrypoint: string,
  importMap: ReadonlyArray<[string, string]>,
  readFile: (rel: string) => string | null,
): ModuleGraph {
  const local = new Set<string>();
  const problems: string[] = [];
  const queue = [entrypoint];
  while (queue.length > 0) {
    const curr = queue.pop() as string;
    if (local.has(curr)) continue;
    const text = readFile(curr);
    if (text === null) {
      problems.push(`${curr}: ファイルが無い`);
      continue;
    }
    local.add(curr);
    const info = ts.preProcessFile(text, true, true);
    const specifiers = [...info.importedFiles, ...info.referencedFiles, ...info.typeReferenceDirectives].map((ref) => ref.fileName);
    for (const specifier of specifiers) {
      // 相対パスは、いまのファイルからの相対
      if (isRelPath(specifier)) {
        queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(curr), specifier)));
        continue;
      }
      if (isAbsPath(specifier)) {
        queue.push(path.posix.normalize(specifier));
        continue;
      }
      // npm: / jsr: / node: / https: など (外のもの。版の固定は tests/edge-function-dep-pinning.test.ts が見る)
      if (URL_SCHEME.test(specifier)) continue;
      const entry = importMap.find(([key]) => specifier === key || specifier.startsWith(key.endsWith('/') ? key : `${key}/`));
      if (!entry) {
        problems.push(`${curr}: ${specifier} が ${IMPORT_MAP} の imports に無い (解決できない)`);
        continue;
      }
      // import map の値 (cliImportMap で、リポジトリの根からの相対に解いてある) がローカルを指すときだけたどる
      const mapped = entry[1] + specifier.slice(entry[0].length);
      if (isRelPath(mapped) || isAbsPath(mapped)) queue.push(path.posix.normalize(mapped));
    }
  }
  return { local, problems };
}

/** 送るファイルの漏れと、解けない import (無ければ空) */
function uploadProblems(
  entrypoint: string,
  importMapPath: string,
  readFile: (rel: string) => string | null,
): string[] {
  const importMap = cliImportMap(importMapPath, (rel) => readFile(rel) ?? '{}');
  const uploaded = cliUploadedFiles(entrypoint, importMap, readFile);
  const graph = localModuleGraph(entrypoint, importMap, readFile);
  const missing = [...graph.local].filter((file) => !uploaded.has(file)).map((file) => `${file}: --use-api のとき CLI が送らない (CLI の正規表現で拾えない書き方の import)`);
  return [...graph.problems, ...missing];
}

/** リポジトリのファイルを読む (無ければ null)。パスはリポジトリの根からの相対 */
function readRepoFile(rel: string): string | null {
  const full = path.join(ROOT, rel);
  return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : null;
}

/** CLI の GetFunctionSlugs が配る関数 (supabase/functions/<name>/index.ts。config.toml の関数は verify_jwt の検査がどれも index.ts を持つと確かめる) */
const DEPLOYED_FUNCTIONS = fs
  .readdirSync(path.join(ROOT, FUNCTIONS_DIR), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && CLI_FUNC_SLUG_PATTERN.test(entry.name))
  .map((entry) => entry.name)
  .filter((name) => fs.existsSync(path.join(ROOT, FUNCTIONS_DIR, name, 'index.ts')))
  .sort();

describe('#1686 --use-api のとき CLI が送るファイルに、関数が import するローカルのファイルがすべて入っている', () => {
  it('関数を数えられている (空振りしない)', () => {
    expect(DEPLOYED_FUNCTIONS.length).toBeGreaterThan(0);
    expect(DEPLOYED_FUNCTIONS).toContain('calculate-segment-stats');
  });

  it.each(DEPLOYED_FUNCTIONS)('%s', (name) => {
    expect(uploadProblems(`${FUNCTIONS_DIR}/${name}/index.ts`, IMPORT_MAP, readRepoFile)).toEqual([]);
  });

  it('_shared のファイルを送る関数がある (相対パスのたどりが空振りしていない)', () => {
    const importMap = cliImportMap(IMPORT_MAP, (rel) => readRepoFile(rel) ?? '{}');
    const sharedPrefix = `${FUNCTIONS_DIR}/_shared/`;
    const sending = DEPLOYED_FUNCTIONS.filter((name) =>
      [...cliUploadedFiles(`${FUNCTIONS_DIR}/${name}/index.ts`, importMap, readRepoFile)].some((file) => file.startsWith(sharedPrefix)),
    );
    expect(sending.length).toBeGreaterThan(0);
  });
});

describe('検査の道具が空振りしない (送るファイルの漏れ・解けない名前を見つける)', () => {
  const IMPORT_MAP_JSON = JSON.stringify({ imports: { zod: 'npm:zod@4.1.13', '@local/': './_lib/' } });
  /** supabase/functions/ の下に置いたつもりのファイル (パスはリポジトリの根からの相対) */
  const files = (entries: Record<string, string>) => {
    const all: Record<string, string> = { [IMPORT_MAP]: IMPORT_MAP_JSON };
    for (const [rel, text] of Object.entries(entries)) all[`${FUNCTIONS_DIR}/${rel}`] = text;
    return (rel: string) => all[rel] ?? null;
  };
  const entry = `${FUNCTIONS_DIR}/f/index.ts`;

  it.each([
    ['1 行の import', 'import { a } from "../_shared/a.ts";\n'],
    ['複数行の名前つき import', 'import {\n  a,\n  b,\n} from "../_shared/a.ts";\n'],
    ['1 行の import type', 'import type { A } from "../_shared/a.ts";\n'],
    ['export ... from', 'export { a } from "../_shared/a.ts";\n'],
    ['動的 import', 'const m = await import("../_shared/a.ts");\n'],
    ['import map の名前でローカルを指す', 'import { a } from "@local/a.ts";\n'],
    ['deno.json の名前 (npm)', 'import { z } from "zod";\n'],
  ])('%s は、CLI も送る (漏れなし)', (_title, text) => {
    const readFile = files({ 'f/index.ts': text, '_shared/a.ts': 'export const a = 1;\n', '_lib/a.ts': 'export const a = 1;\n' });
    expect(uploadProblems(entry, IMPORT_MAP, readFile)).toEqual([]);
  });

  it.each([
    ['import type { で改行する複数行の import', 'import type {\n  A,\n} from "../_shared/a.ts";\n'],
    ['既定の名前のあとに { で改行する複数行の import', 'import def, {\n  a,\n} from "../_shared/a.ts";\n'],
    ['/// <reference path>', '/// <reference path="../_shared/a.ts" />\n'],
  ])('%s は、CLI が送らないので漏れとして見つける', (_title, text) => {
    const readFile = files({ 'f/index.ts': text, '_shared/a.ts': 'export const a = 1;\n' });
    expect(uploadProblems(entry, IMPORT_MAP, readFile)).toEqual([
      `${FUNCTIONS_DIR}/_shared/a.ts: --use-api のとき CLI が送らない (CLI の正規表現で拾えない書き方の import)`,
    ]);
  });

  it('import map に無い名前と、無いファイルを見つける', () => {
    const readFile = files({ 'f/index.ts': 'import { x } from "left-pad";\nimport { y } from "./gone.ts";\n' });
    expect(uploadProblems(entry, IMPORT_MAP, readFile)).toEqual([
      `${entry}: left-pad が ${IMPORT_MAP} の imports に無い (解決できない)`,
      `${FUNCTIONS_DIR}/f/gone.ts: ファイルが無い`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. デプロイの段の run を偽の npx で動かす
// ---------------------------------------------------------------------------

type FakeCli = { exit: number; stdout?: string; stderr?: string };

/** 偽の npx (引数をファイルに書き、決めた出力と終了コードを返す) を PATH の先頭に置いて、段の run をリポジトリの根で動かす */
function runDeployStep(cli: FakeCli) {
  const work = tempDir('deploy-step-');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  const argsFile = path.join(work, 'npx-args');
  const summary = path.join(work, 'summary.md');
  fs.writeFileSync(path.join(work, 'stdout'), cli.stdout ?? '');
  fs.writeFileSync(path.join(work, 'stderr'), cli.stderr ?? '');
  fs.writeFileSync(
    path.join(bin, 'npx'),
    `#!${BASH}\nprintf '%s\\n' "$@" > '${argsFile}'\ncat '${work}/stdout'\ncat '${work}/stderr' >&2\nexit ${cli.exit}\n`,
    { mode: 0o755 },
  );
  const run = deployStep?.run ?? '';
  const script = path.join(work, 'step.sh');
  fs.writeFileSync(script, run.split(PROJECT_REF_EXPRESSION).join(FAKE_PROJECT_REF));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, GITHUB_STEP_SUMMARY: summary, GITHUB_ACTIONS: 'true' };
  const result = spawnSync(BASH, [...ACTIONS_BASH_ARGS, script], { cwd: ROOT, env, encoding: 'utf8' });
  const readIf = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    args: readIf(argsFile).split('\n').filter((line) => line !== ''),
    summary: readIf(summary),
  };
}

describe('#1686 デプロイの段は、イメージの取得の失敗とデプロイの失敗を分けて出す', () => {
  const sourced = spawnSync(BASH, ['-c', `. ${IMAGE_PULL_LIB} && printf '%s\\n%s\\n' "$SIP_EXIT_PULL_UNAVAILABLE" "$SIP_UNAVAILABLE_TAG"`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const [exitPullUnavailableText, unavailableTag] = sourced.stdout.split('\n');
  const EXIT_PULL_UNAVAILABLE = Number(exitPullUnavailableText);

  it('段が比べる名前は、#1523 のライブラリの値 (75・[image-pull-unavailable]) と同じ', () => {
    expect(sourced.status, sourced.stderr).toBe(0);
    expect(EXIT_PULL_UNAVAILABLE).toBe(75);
    expect(unavailableTag).toBe(UNAVAILABLE_TAG);
  });

  it('成功: 0 で終わり、CLI に --use-api と共通の import map を渡す', () => {
    const r = runDeployStep({ exit: 0, stdout: 'Deployed Functions on project testprojectref: a, b\n' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Deployed Functions on project');
    expect(r.stdout).not.toContain('::error');
    expect(r.summary).toBe('');
    expect(r.args.slice(1)).toEqual(['functions', 'deploy', '--use-api', '--import-map', IMPORT_MAP, '--project-ref', FAKE_PROJECT_REF]);
    expect(r.args[0]).toBe('--yes');
  });

  it.each([
    ['ECR の上限', 'failed to pull docker image: Error response from daemon: toomanyrequests: Data limit exceeded\n'],
    ['取得の失敗', 'Error: failed to pull docker image: Get "https://public.ecr.aws/v2/": EOF\n'],
  ])('イメージの取得の失敗 (%s): 75 で終わり、[image-pull-unavailable] と「デプロイの赤ではない」の注記を出す', (_title, stderr) => {
    const r = runDeployStep({ exit: CLI_EXIT_FAILURE, stderr });
    expect(r.status).toBe(EXIT_PULL_UNAVAILABLE);
    expect(r.stderr).toContain(stderr.trim());
    expect(r.stderr).toContain(`${UNAVAILABLE_TAG} ${DEPLOY_STEP}:`);
    expect(r.stdout).toContain(`::error title=${DEPLOY_STEP}: イメージを取得できない (関数のデプロイの赤ではない)::`);
    expect(r.summary).toContain('イメージを取得できない');
    expect(r.summary).toContain('docs/operations/ci-supabase-image-pull.md');
  });

  it.each([
    ['API の 5xx', 'unexpected deploy status 500: {"message":"Internal Server Error"}\n', CLI_EXIT_FAILURE],
    // 接続の時間切れは、デプロイの API の時間切れでも出るので、イメージの取得の失敗に数えない
    ['API の時間切れ', 'failed to deploy function: Post "https://api.supabase.com/v1/projects/x/functions/deploy": context deadline exceeded (Client.Timeout exceeded while awaiting headers)\n', CLI_EXIT_FAILURE],
    ['まとめの失敗', 'unexpected deploy status 400: {"message":"Module not found \\"file:///tmp/a.ts\\""}\n', CLI_EXIT_OTHER],
  ])('デプロイの失敗 (%s): CLI の終了コードのまま終わり、デプロイの失敗の注記を出す ([image-pull-unavailable] は出さない)', (_title, stderr, exit) => {
    const r = runDeployStep({ exit, stderr });
    expect(r.status).toBe(exit);
    expect(r.stderr).toContain(stderr.trim());
    expect(r.stdout).toContain(`::error title=${DEPLOY_STEP}: 関数のデプロイが失敗した::`);
    expect(`${r.stdout}${r.stderr}`).not.toContain(UNAVAILABLE_TAG);
    expect(r.summary).toContain('関数のデプロイが失敗した');
  });
});
