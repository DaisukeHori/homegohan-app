// @vitest-environment node
/**
 * tests/edge-functions-prune.test.ts
 *
 * scripts/edge-functions-prune.mjs の契約テスト (#1452)。本番の Supabase にあってリポジトリ (supabase/functions/) に無い
 * Edge Function を、デプロイのワークフローが消す。その「何を消すか」の計算と、消さずに止める安全装置を固める。
 * supabase CLI は呼ばない (呼び出しを差し替える)。本番にはつながない。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLI_TIMEOUT_ENV,
  DEFAULT_CLI_TIMEOUT_MS,
  DEFAULT_MAX_DELETIONS,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  MAX_DELETIONS_ENV,
  PruneError,
  SUPABASE_CLI_PACKAGE,
  computeFunctionsToDelete,
  listRepoFunctions,
  main,
  parseArgs,
  parseFunctionsListJson,
  planPrune,
  resolveCliTimeoutMs,
  resolveMaxDeletions,
} from '../scripts/edge-functions-prune.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';

/** #1452 の表にある、本番に残っていた旧い関数 13 本 */
const LEGACY_FUNCTIONS_1452 = [
  'generate-weekly-menu',
  'generate-single-meal',
  'regenerate-meal-direct',
  'myfunc',
  'test-deploy',
  'regenerate-meal',
  'regenerate-day',
  'generate-weekly-menu-v2',
  'generate-single-meal-v2',
  'regenerate-meal-direct-v2',
  'generate-weekly-menu-v3',
  'generate-single-meal-v3',
  'regenerate-meal-direct-v3',
];

/** supabase functions list -o json の 1 件 (2.62.10 の API の応答の形に寄せた最小のもの) */
const fn = (slug: string) => ({ id: `id-${slug}`, slug, name: slug, status: 'ACTIVE', version: 1, verify_jwt: true });

type RunResult = { status: number | null; stdout: string };

/** CLI の呼び出しを記録して、決めた結果を返す差し替え */
function fakeCli(options: {
  list: RunResult;
  deleteStatus?: (slug: string) => number | null;
}) {
  const calls: string[][] = [];
  const run = (args: string[]): RunResult => {
    calls.push(args);
    if (args[0] === 'functions' && args[1] === 'list') return options.list;
    if (args[0] === 'functions' && args[1] === 'delete') {
      return { status: options.deleteStatus ? options.deleteStatus(args[2]) : 0, stdout: '' };
    }
    throw new Error(`想定外の呼び出し: ${args.join(' ')}`);
  };
  return { run, calls };
}

function runMain(argv: string[], deps: { run: (args: string[]) => RunResult; repo: string[]; env?: Record<string, string> }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    env: deps.env ?? {},
    run: deps.run,
    listRepo: () => deps.repo,
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  });
  return { code, out, err, all: [...out, ...err].join('\n') };
}

const listOf = (slugs: string[]): RunResult => ({ status: 0, stdout: JSON.stringify(slugs.map(fn)) });

describe('computeFunctionsToDelete: 本番にあってリポジトリに無い関数', () => {
  it.each([
    { title: '両方にある関数は消さない', remote: ['a', 'b'], repo: ['a', 'b'], expected: [] },
    { title: '本番だけにある関数を消す', remote: ['a', 'old-1', 'b', 'old-0'], repo: ['a', 'b'], expected: ['old-0', 'old-1'] },
    { title: 'リポジトリだけにある関数は何もしない (デプロイが作る)', remote: ['a'], repo: ['a', 'new-fn'], expected: [] },
    { title: '本番が空なら何も消さない', remote: [], repo: ['a'], expected: [] },
    { title: 'リポジトリが空なら本番の全部 (planPrune の安全装置が止める)', remote: ['b', 'a'], repo: [], expected: ['a', 'b'] },
    { title: '本番の一覧に重複があっても 1 回だけ', remote: ['old', 'old', 'a'], repo: ['a'], expected: ['old'] },
  ])('$title', ({ remote, repo, expected }) => {
    expect(computeFunctionsToDelete(remote, repo)).toEqual(expected);
  });

  it('並びは入力の順に関係なく名前の昇順 (安定)', () => {
    const repo = ['keep'];
    const a = computeFunctionsToDelete(['z-old', 'keep', 'a-old', 'M-old'], repo);
    const b = computeFunctionsToDelete(['a-old', 'M-old', 'z-old', 'keep'], repo);
    expect(a).toEqual(['M-old', 'a-old', 'z-old']);
    expect(b).toEqual(a);
  });
});

describe('listRepoFunctions: リポジトリの関数 = _ や . で始まらず index.ts を持つディレクトリ', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'edge-functions-prune-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const addFunction = (name: string, files: string[] = ['index.ts']) => {
    mkdirSync(path.join(dir, name), { recursive: true });
    for (const file of files) writeFileSync(path.join(dir, name, file), '');
  };

  it('_shared・README.md・deno.json・index.ts の無いディレクトリ・隠しディレクトリは関数に数えない', () => {
    addFunction('zeta');
    addFunction('alpha', ['index.ts', 'deno.json']);
    addFunction('_shared', ['index.ts', 'cors.ts']);
    addFunction('.hidden');
    addFunction('no-entry', ['main.ts']);
    writeFileSync(path.join(dir, 'README.md'), '');
    writeFileSync(path.join(dir, 'deno.json'), '{}');
    expect(listRepoFunctions(dir)).toEqual(['alpha', 'zeta']);
  });

  it('空のディレクトリ・存在しないディレクトリは 0 本', () => {
    expect(listRepoFunctions(dir)).toEqual([]);
    expect(listRepoFunctions(path.join(dir, 'missing'))).toEqual([]);
  });

  it('実際の supabase/functions: _shared を含まず、どれも index.ts を持ち、#1452 の旧い関数 13 本は含まない', () => {
    const repo = listRepoFunctions(path.join(process.cwd(), 'supabase', 'functions'));
    expect(repo.length).toBeGreaterThan(0);
    expect(repo).not.toContain('_shared');
    expect(repo).toContain('generate-menu-v5');
    for (const name of LEGACY_FUNCTIONS_1452) expect(repo).not.toContain(name);
    // #1452 の状態 (本番 = リポジトリの関数 + 旧い 13 本) なら、消すのはちょうど 13 本で、既定の上限に収まる
    const toDelete = planPrune({
      remoteSlugs: [...repo, ...LEGACY_FUNCTIONS_1452],
      repoFunctions: repo,
      maxDeletions: DEFAULT_MAX_DELETIONS,
    });
    expect(toDelete).toEqual([...LEGACY_FUNCTIONS_1452].sort());
    expect(toDelete).toHaveLength(13);
  });
});

describe('parseFunctionsListJson: supabase functions list -o json の出力を読む', () => {
  it('関数の配列から slug を取り出す', () => {
    expect(parseFunctionsListJson(JSON.stringify([fn('a'), fn('b-c')]))).toEqual(['a', 'b-c']);
  });

  it('{ functions: [...] } の形も受け付ける', () => {
    expect(parseFunctionsListJson(JSON.stringify({ functions: [fn('a')] }))).toEqual(['a']);
  });

  it('空の配列は 0 本', () => {
    expect(parseFunctionsListJson('[]\n')).toEqual([]);
  });

  it('先頭に JSON 以外の行があっても、行頭の [ から読む', () => {
    expect(parseFunctionsListJson(`A new version of Supabase CLI is available\n${JSON.stringify([fn('a')])}`)).toEqual(['a']);
  });

  it.each([
    { title: '空の出力', text: '' },
    { title: 'JSON でない (表の形の出力)', text: '  ID | NAME | SLUG\n  ---|---|---\n  x | a | a' },
    { title: '配列でもなく functions も無い', text: '{"message":"Unauthorized"}' },
    { title: 'slug が無い要素', text: '[{"name":"a"}]' },
    { title: 'slug が文字列でない', text: '[{"slug":1}]' },
    { title: 'null の要素', text: '[null]' },
  ])('$title は PruneError', ({ text }) => {
    expect(() => parseFunctionsListJson(text)).toThrow(PruneError);
  });
});

describe('上限の環境変数', () => {
  it('既定は DEFAULT_MAX_DELETIONS で、#1452 の 13 本を通す', () => {
    expect(resolveMaxDeletions({})).toBe(DEFAULT_MAX_DELETIONS);
    expect(DEFAULT_MAX_DELETIONS).toBeGreaterThanOrEqual(LEGACY_FUNCTIONS_1452.length);
  });

  it('環境変数で上書きできる (0 も可 = 1 本も消させない)', () => {
    expect(resolveMaxDeletions({ [MAX_DELETIONS_ENV]: '3' })).toBe(3);
    expect(resolveMaxDeletions({ [MAX_DELETIONS_ENV]: '0' })).toBe(0);
    expect(resolveMaxDeletions({ [MAX_DELETIONS_ENV]: '' })).toBe(DEFAULT_MAX_DELETIONS);
  });

  it.each(['-1', '1.5', 'abc', ' 5'])('整数として読めない値 %j は既定値に戻さず PruneError', (raw) => {
    expect(() => resolveMaxDeletions({ [MAX_DELETIONS_ENV]: raw })).toThrow(PruneError);
  });

  it('CLI の時間の上限: 既定・上書き・0 は不可', () => {
    expect(resolveCliTimeoutMs({})).toBe(DEFAULT_CLI_TIMEOUT_MS);
    expect(resolveCliTimeoutMs({ [CLI_TIMEOUT_ENV]: '5000' })).toBe(5000);
    expect(() => resolveCliTimeoutMs({ [CLI_TIMEOUT_ENV]: '0' })).toThrow(PruneError);
  });
});

describe('planPrune: 安全装置', () => {
  it('リポジトリの関数が 0 本なら止める', () => {
    expect(() => planPrune({ remoteSlugs: ['a'], repoFunctions: [], maxDeletions: DEFAULT_MAX_DELETIONS })).toThrow(/0 本/);
  });

  it('削除の数が上限を超えたら止める / ちょうど上限なら通す', () => {
    const repo = ['keep'];
    const old = ['o1', 'o2', 'o3'];
    expect(() => planPrune({ remoteSlugs: [...repo, ...old], repoFunctions: repo, maxDeletions: 2 })).toThrow(/上限 2 本を超え/);
    expect(planPrune({ remoteSlugs: [...repo, ...old], repoFunctions: repo, maxDeletions: 3 })).toEqual(old);
  });

  it.each(['bad slug', 'a;rm', '../x', '-flag', '1abc', 'ａ', 'a/b', ''])('slug %j のような想定外の文字があれば止める', (slug) => {
    expect(() => planPrune({ remoteSlugs: ['keep', slug], repoFunctions: ['keep'], maxDeletions: DEFAULT_MAX_DELETIONS })).toThrow(
      PruneError,
    );
  });

  it('想定外の slug は、リポジトリにある名前でも止める (一覧そのものを疑う)', () => {
    expect(() => planPrune({ remoteSlugs: ['keep', 'x y'], repoFunctions: ['keep', 'x y'], maxDeletions: 1 })).toThrow(PruneError);
  });
});

describe('parseArgs', () => {
  it('既定は dry-run', () => {
    expect(parseArgs(['--project-ref', PROJECT_REF])).toMatchObject({ apply: false, projectRef: PROJECT_REF });
    expect(parseArgs([`--project-ref=${PROJECT_REF}`, '--apply'])).toMatchObject({ apply: true, projectRef: PROJECT_REF });
  });

  it.each([[[]], [['--project-ref']], [['--project-ref', 'BAD REF']], [['--project-ref', PROJECT_REF, '--force']]])(
    '%j は使い方の誤り',
    (argv) => {
      expect(() => parseArgs(argv)).toThrow(PruneError);
    },
  );
});

describe('main: 入口', () => {
  const REPO = ['analyze-fridge', 'generate-menu-v5'];

  it('既定 (dry-run) は削除を呼ばず、削除予定の名前と件数だけを出す', () => {
    const cli = fakeCli({ list: listOf([...REPO, 'old-b', 'old-a']) });
    const result = runMain(['--project-ref', PROJECT_REF], { run: cli.run, repo: REPO });
    expect(result.code).toBe(EXIT_OK);
    expect(cli.calls).toEqual([['functions', 'list', '--project-ref', PROJECT_REF, '-o', 'json']]);
    expect(result.out).toContain('edge-functions-prune: 削除予定: old-a');
    expect(result.out).toContain('edge-functions-prune: 削除予定: old-b');
    expect(result.all).toMatch(/削除予定 2 本/);
    expect(result.all).not.toMatch(/削除しました/);
  });

  it('--apply なら削除対象ごとに対話なしで delete を呼ぶ (名前の昇順)', () => {
    const cli = fakeCli({ list: listOf([...REPO, 'old-b', 'old-a']) });
    const result = runMain(['--project-ref', PROJECT_REF, '--apply'], { run: cli.run, repo: REPO });
    expect(result.code).toBe(EXIT_OK);
    expect(cli.calls.slice(1)).toEqual([
      ['functions', 'delete', 'old-a', '--project-ref', PROJECT_REF, '--yes'],
      ['functions', 'delete', 'old-b', '--project-ref', PROJECT_REF, '--yes'],
    ]);
    expect(result.out).toContain('edge-functions-prune: 削除しました: old-a');
    expect(result.out).toContain('edge-functions-prune: 削除しました: old-b');
    expect(result.all).toMatch(/削除 2 本 \/ 失敗 0 本/);
  });

  it('消すものが無ければ削除を呼ばずに緑', () => {
    const cli = fakeCli({ list: listOf(REPO) });
    const result = runMain(['--project-ref', PROJECT_REF, '--apply'], { run: cli.run, repo: REPO });
    expect(result.code).toBe(EXIT_OK);
    expect(cli.calls).toHaveLength(1);
    expect(result.all).toMatch(/0 本/);
  });

  it('削除に 1 本失敗しても残りを試し、最後に赤で終わる', () => {
    const cli = fakeCli({ list: listOf([...REPO, 'old-a', 'old-b', 'old-c']), deleteStatus: (slug) => (slug === 'old-a' ? 1 : 0) });
    const result = runMain(['--project-ref', PROJECT_REF, '--apply'], { run: cli.run, repo: REPO });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(cli.calls.slice(1).map((args) => args[2])).toEqual(['old-a', 'old-b', 'old-c']);
    expect(result.err.join('\n')).toMatch(/削除に失敗しました: old-a/);
    expect(result.out).toContain('edge-functions-prune: 削除しました: old-c');
    expect(result.all).toMatch(/削除 2 本 \/ 失敗 1 本/);
  });

  it('CLI が時間切れ等で終了コードを返さなかった削除も失敗に数える', () => {
    const cli = fakeCli({ list: listOf([...REPO, 'old-a']), deleteStatus: () => null });
    const result = runMain(['--project-ref', PROJECT_REF, '--apply'], { run: cli.run, repo: REPO });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.all).toMatch(/失敗 1 本/);
  });

  describe('安全装置に当たったら 1 本も消さずに赤', () => {
    const cases: {
      title: string;
      list: RunResult;
      repo?: string[];
      env?: Record<string, string>;
      message: RegExp;
    }[] = [
      { title: 'リポジトリの関数が 0 本', list: listOf(['old-a']), repo: [], message: /0 本/ },
      { title: '一覧の CLI が失敗した', list: { status: 1, stdout: '' }, message: /一覧を取れませんでした/ },
      { title: '一覧の CLI が終了コードを返さなかった (時間切れ等)', list: { status: null, stdout: '' }, message: /一覧を取れませんでした/ },
      { title: '一覧が JSON でない', list: { status: 0, stdout: 'not json' }, message: /JSON として読めません/ },
      { title: '一覧の形が違う', list: { status: 0, stdout: '{"message":"x"}' }, message: /想定した形/ },
      { title: 'slug に想定外の文字', list: listOf([...REPO, 'old a']), message: /想定外の文字/ },
      {
        title: '削除の数が上限を超えた (環境変数の上限)',
        list: listOf([...REPO, 'old-a', 'old-b']),
        env: { [MAX_DELETIONS_ENV]: '1' },
        message: /上限 1 本を超え/,
      },
      {
        title: '削除の数が既定の上限を超えた',
        list: listOf([...REPO, ...Array.from({ length: DEFAULT_MAX_DELETIONS + 1 }, (_, i) => `old-${i}`)]),
        message: new RegExp(`上限 ${DEFAULT_MAX_DELETIONS} 本を超え`),
      },
      { title: '上限の環境変数が読めない', list: listOf([...REPO, 'old-a']), env: { [MAX_DELETIONS_ENV]: 'many' }, message: /0 以上の整数/ },
    ];

    it.each(cases)('$title', ({ list, repo, env, message }) => {
      const cli = fakeCli({ list });
      const result = runMain(['--project-ref', PROJECT_REF, '--apply'], { run: cli.run, repo: repo ?? REPO, env });
      expect(result.code).toBe(EXIT_FAILURE);
      expect(cli.calls.filter((args) => args[1] === 'delete')).toEqual([]);
      expect(result.err.join('\n')).toMatch(/1 本も消していません/);
      expect(result.err.join('\n')).toMatch(message);
    });
  });

  it('引数の誤りは CLI を呼ばずに使い方の誤り', () => {
    const cli = fakeCli({ list: listOf(REPO) });
    const result = runMain(['--apply'], { run: cli.run, repo: REPO });
    expect(result.code).toBe(EXIT_USAGE);
    expect(cli.calls).toEqual([]);
  });

  it('ログにトークンや CLI の出力 (stdout) を出さない', () => {
    // 本物のトークンの形 (sbp_...) にはしない (シークレットの検査に引っかからないように)。ログに出ないことだけを見る
    const token = 'TEST-ACCESS-TOKEN-VALUE-NOT-REAL';
    const marker = 'CLI-STDOUT-MARKER';
    const cli = fakeCli({
      list: { status: 0, stdout: `${marker}\n${JSON.stringify([...REPO, 'old-a'].map((slug) => ({ ...fn(slug), note: marker })))}` },
    });
    const result = runMain(['--project-ref', PROJECT_REF, '--apply'], {
      run: cli.run,
      repo: REPO,
      env: { SUPABASE_ACCESS_TOKEN: token },
    });
    expect(result.code).toBe(EXIT_OK);
    expect(result.all).not.toContain(token);
    expect(result.all).not.toContain(marker);
    // 失敗のときも CLI の出力は出さない
    const failing = fakeCli({ list: { status: 1, stdout: `${marker} ${token}` } });
    const failed = runMain(['--project-ref', PROJECT_REF], { run: failing.run, repo: REPO, env: { SUPABASE_ACCESS_TOKEN: token } });
    expect(failed.code).toBe(EXIT_FAILURE);
    expect(failed.all).not.toContain(token);
    expect(failed.all).not.toContain(marker);
  });
});

describe('.github/workflows/deploy-supabase-functions.yml', () => {
  const WORKFLOW = '.github/workflows/deploy-supabase-functions.yml';
  const SCRIPT = 'scripts/edge-functions-prune.mjs';
  type Step = { name?: string; run?: string; env?: Record<string, string> };
  const workflow = yaml.load(readFileSync(WORKFLOW, 'utf8')) as {
    on: { push: { branches: string[]; paths: string[] } };
    jobs: { deploy: { steps: Step[] } };
  };
  const steps = workflow.jobs.deploy.steps;
  const indexOfStep = (name: string) => steps.findIndex((step) => step.name === name);
  const pruneIndex = steps.findIndex((step) => step.run?.includes(SCRIPT));

  it('全関数のデプロイのあと、デプロイの確認の前に、削除の手順を --apply で走らせる', () => {
    const deployIndex = indexOfStep('Deploy all functions');
    const verifyIndex = indexOfStep('Verify deployment');
    expect(deployIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(pruneIndex).toBeGreaterThan(deployIndex);
    expect(pruneIndex).toBeLessThan(verifyIndex);
    const prune = steps[pruneIndex];
    expect(prune.run).toMatch(new RegExp(`node ${SCRIPT.replace('.', '\\.')} .*--apply`));
    expect(prune.run).toContain('--project-ref ${{ env.SUPABASE_PROJECT_ID }}');
    expect(prune.env?.SUPABASE_ACCESS_TOKEN).toBe('${{ secrets.SUPABASE_ACCESS_TOKEN }}');
  });

  it('ワークフローとスクリプトの CLI の版が同じ', () => {
    const deploy = steps[indexOfStep('Deploy all functions')];
    expect(deploy.run).toContain(`npx --yes ${SUPABASE_CLI_PACKAGE} functions deploy`);
  });

  it('このワークフロー自身と削除のスクリプトを変えたときも main への push で走る', () => {
    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.on.push.paths).toEqual(expect.arrayContaining(['supabase/functions/**', WORKFLOW, SCRIPT]));
  });
});
