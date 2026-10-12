// @vitest-environment node
/**
 * #1515 Edge Function の依存の版の固定の検査 (deploy-supabase-functions.yml の「Verify Edge Function dependency pinning」)
 *
 * 背景: この段は rg で探していたが、ubuntu の runner に rg が無く (command not found)、if が偽になって毎回通っていた。
 * grep -E に置き換え、道具が無い・grep が失敗した・検査したファイルが 0 本・正規表現が見本に当たらない、のどれでも赤にした。
 *
 * #1518 で対象を広げた: jsr: / npm: に加えて https:// (と http://) を直接書いた import、バッククォートの import()、
 * 型だけを引く // @deno-types="..." と /// <reference types="..." /> も赤にする (_shared/db-logger.ts が
 * esm.sh からメジャー版だけの指定で supabase-js を読んでいたのを、この検査が見ていなかった)。
 * 検査したファイルの本数は、中身が空のファイルも数える (このテストの walkSources と同じ数え方)。
 *
 * ここでは、ワークフローの run を書き写さず、yml から取り出してそのまま bash で動かす
 * (書き写すと、ワークフローだけが壊れたときに気づけない)。動かす bash の引数は、shell: bash の段に GitHub Actions が
 * 付けるもの (--noprofile --norc -eo pipefail) と同じにする。
 *
 * このワークフローは main への push でしか走らないので、PR の段階で止めるのはこのテスト (PR の npm test・local-ci.sh の unit 段)。
 * いまの supabase/functions をこの段で検査して緑であることも、ここで確かめる。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = '.github/workflows/deploy-supabase-functions.yml';
const STEP_NAME = 'Verify Edge Function dependency pinning';
const FUNCTIONS_DIR = 'supabase/functions';
/** 検査の対象の拡張子 (段の --include と同じ。下で段の文字列と突き合わせる) */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];
/** GitHub Actions が shell: bash の段を動かすときの bash の引数 */
const ACTIONS_BASH_ARGS = ['--noprofile', '--norc', '-eo', 'pipefail'];
/** 段が赤で止まるときの終了コード (exit 1) */
const EXIT_RED = 1;
/** grep の「エラー」の終了コード (0 = 当たった・1 = 当たらなかった・2 以上 = エラー) */
const GREP_EXIT_ERROR = 2;
/** コマンドが見つからないときのシェルの終了コード (rg が無かったときの元の空回りの再現) */
const EXIT_COMMAND_NOT_FOUND = 127;
/** 段が緑で終わるときに出す文 */
const GREEN_MESSAGE = 'jsr:/npm:/https:// を直接書いた依存はありません';

type Step = { name?: string; shell?: string; run?: string };
const workflow = yaml.load(fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf8')) as { jobs: { deploy: { steps: Step[] } } };
const steps = workflow.jobs.deploy.steps;
const stepIndex = steps.findIndex((step) => step.name === STEP_NAME);
const step = steps[stepIndex];
const BASH = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
const REAL_GREP = execFileSync(BASH, ['-c', 'command -v grep'], { encoding: 'utf8' }).trim();

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 段の run を、cwd をリポジトリの直下に見立てて動かす */
function runStep(cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const script = path.join(tempDir('pin-step-'), 'step.sh');
  fs.writeFileSync(script, step.run ?? '');
  const result = spawnSync(BASH, [...ACTIONS_BASH_ARGS, script], { cwd, env, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** supabase/functions/<file> に中身を置いた作業場所を作る */
function repoWith(files: Record<string, string>): string {
  const root = tempDir('pin-repo-');
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(root, FUNCTIONS_DIR, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

/** 本物の grep の前に置く偽の grep (body は bash)。PATH の先頭にこのディレクトリを置く */
function fakeGrepPath(body: string): NodeJS.ProcessEnv {
  const bin = tempDir('pin-bin-');
  fs.writeFileSync(path.join(bin, 'grep'), `#!${BASH}\n${body}\n`, { mode: 0o755 });
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
}

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSources(full, out);
    else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

describe('#1515 段の形', () => {
  it('段があり、関数のデプロイより前に走る', () => {
    expect(stepIndex).toBeGreaterThanOrEqual(0);
    expect(stepIndex).toBeLessThan(steps.findIndex((s) => s.name === 'Deploy all functions'));
  });

  it('shell: bash で、先頭で set -euo pipefail し、grep の有無を確かめる。rg は使わない', () => {
    expect(step.shell).toBe('bash');
    const lines = (step.run ?? '').split('\n').map((line) => line.trim());
    expect(lines[0]).toBe('set -euo pipefail');
    expect(step.run).toMatch(/command -v grep\b/);
    expect(step.run).not.toMatch(/(^|[\s;|&(])rg\s/m);
  });

  it('#1518 見本の行に、新しく止める形 (https://・バッククォートの import()・@deno-types・<reference types>) が入っている', () => {
    const run = step.run ?? '';
    const mustMatch = run.slice(run.indexOf('must_match=('), run.indexOf('must_not_match=('));
    expect(mustMatch).toContain('import(`npm:');
    expect(mustMatch).toContain('from "https://');
    expect(mustMatch).toContain('// @deno-types="npm:');
    expect(mustMatch).toContain('/// <reference types="npm:');
    const mustNotMatch = run.slice(run.indexOf('must_not_match=('), run.indexOf('for sample in'));
    expect(mustNotMatch).toContain('fetch("https://');
    expect(mustNotMatch).toContain('import { z } from "zod";');
  });

  it('検査する拡張子は、このテストの一覧と同じ', () => {
    const included = [...(step.run ?? '').matchAll(/--include='\*(\.[a-z]+)'/g)].map((m) => m[1]).sort();
    expect(included).toEqual([...SOURCE_EXTENSIONS].sort());
  });
});

describe('#1515 #1518 版を固定していない依存の書き方を止め、deno.json の名前で書いた import は通す', () => {
  const RAW = [
    { title: 'npm: の版なし', file: 'a/index.ts', text: 'import { z } from "npm:zod";\n' },
    { title: 'jsr: の版なし (単一引用符)', file: 'a/index.ts', text: "import { createClient } from 'jsr:@supabase/supabase-js';\n" },
    { title: '複数行の import の from の行', file: 'a/index.ts', text: 'import {\n  OpenAI,\n} from "npm:openai";\n' },
    { title: 'import type', file: 'a/index.ts', text: 'import type { Agent } from "npm:@openai/agents";\n' },
    { title: '副作用だけの import', file: 'a/index.ts', text: 'import "npm:dotenv/config";\n' },
    { title: 'export ... from', file: '_shared/re.ts', text: 'export * from "jsr:@std/assert";\n' },
    { title: 'import()', file: 'a/index.ts', text: 'const m = await import("npm:zod");\n' },
    { title: '行頭の字下げ', file: 'a/index.ts', text: '  import { z } from "npm:zod";\n' },
    // 版を書いても、関数のファイルに直接書くのは止める (版は deno.json の imports の 1 か所で固定する)
    { title: '版を書いた npm:', file: 'a/index.ts', text: 'import { z } from "npm:zod@4.1.13";\n' },
    { title: '.tsx', file: 'a/view.tsx', text: 'import { z } from "npm:zod";\n' },
    { title: '.mjs', file: 'a/tool.mjs', text: 'import { z } from "npm:zod";\n' },
    // #1518: https:// の import (版の固定は URL の書き方しだいなので、URL で直接書くこと自体を止める)
    { title: 'esm.sh の import (#1518 の元の行)', file: '_shared/db-logger.ts', text: 'import { createClient } from "https://esm.sh/@supabase/supabase-js@2";\n' },
    { title: 'deno.land の import (版つき)', file: 'a/index.ts', text: "import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';\n" },
    { title: 'http:// の import', file: 'a/index.ts', text: 'import { x } from "http://example.com/mod.ts";\n' },
    { title: 'https:// の副作用だけの import', file: 'a/index.ts', text: 'import "https://cdn.jsdelivr.net/npm/dotenv/config.js";\n' },
    { title: 'https:// の export ... from', file: '_shared/re.ts', text: 'export { z } from "https://esm.sh/zod@4.1.13";\n' },
    { title: 'https:// の import()', file: 'a/index.ts', text: 'const m = await import("https://esm.sh/zod");\n' },
    // #1518: バッククォートの import()
    { title: 'バッククォートの import() (npm:)', file: 'a/index.ts', text: 'const m = await import(`npm:zod`);\n' },
    { title: 'バッククォートの import() (https://)', file: 'a/index.ts', text: 'const m = await import(`https://esm.sh/zod`);\n' },
    // #1518: 型だけを引く書き方
    { title: '// @deno-types="npm:..."', file: 'a/index.ts', text: '// @deno-types="npm:@types/express@4.17.21"\nimport express from "express";\n' },
    { title: '// @deno-types="https://..."', file: 'a/index.ts', text: '// @deno-types="https://esm.sh/@types/express"\nimport express from "express";\n' },
    { title: '/// <reference types="npm:..." />', file: 'a/index.ts', text: '/// <reference types="npm:@types/node" />\nexport const x = 1;\n' },
    { title: '/// <reference types="jsr:..." /> (単一引用符)', file: 'a/index.ts', text: "/// <reference types='jsr:@supabase/functions-js/edge-runtime.d.ts' />\nexport const x = 1;\n" },
    { title: '/// <reference types="https://..." />', file: 'a/index.ts', text: '/// <reference types="https://esm.sh/@types/node" />\nexport const x = 1;\n' },
  ];

  it.each(RAW)('$title は赤', ({ file, text }) => {
    const root = repoWith({ 'ok/index.ts': 'import { z } from "zod";\n', [file]: text });
    const { status, output } = runStep(root);
    expect(status).toBe(EXIT_RED);
    expect(output).toContain(`${FUNCTIONS_DIR}/${file}:`);
    expect(output).toContain('deno.json の imports');
  });

  const PINNED = [
    { title: 'deno.json の名前 (npm)', text: 'import { z } from "zod";\n' },
    { title: 'deno.json の名前 (jsr)', text: "import { createClient } from '@supabase/supabase-js';\n" },
    { title: 'deno.json の名前 (パスつき)', text: 'import "@supabase/functions-js/edge-runtime.d.ts";\n' },
    { title: '相対パス', text: 'import { createLogger } from "../_shared/db-logger.ts";\n' },
    { title: 'コメントの中の npm: (引用符なし)', text: '/**\n * Stripe SDK (npm:stripe) は使わない\n */\nexport const x = 1;\n' },
    { title: '名前の末尾が import の関数の呼び出し', text: 'declare function reimport(s: string): void;\nreimport("npm:zod");\n' },
    // #1518: import でない https:// (送信先の URL・コメントの中のリンク) は止めない
    { title: 'fetch の URL', text: 'const res = await fetch("https://api.openai.com/v1/models");\n' },
    { title: 'バッククォートの URL', text: 'const url = `https://api.x.ai/v1/chat/completions`;\n' },
    { title: 'コメントの中のリンク', text: '// 仕様: https://deno.land/manual\nexport const x = 1;\n' },
    { title: 'バッククォートの import() (deno.json の名前)', text: 'const m = await import(`zod`);\n' },
    { title: '/// <reference types="..." /> (deno.json の名前)', text: '/// <reference types="@supabase/functions-js/edge-runtime.d.ts" />\nexport const x = 1;\n' },
    { title: '// @deno-types="..." (相対パス)', text: '// @deno-types="./types.d.ts"\nimport x from "./x.js";\n' },
  ];

  it.each(PINNED)('$title は緑', ({ text }) => {
    const { status, output } = runStep(repoWith({ 'a/index.ts': text }));
    expect(output).toContain(GREEN_MESSAGE);
    expect(status).toBe(0);
  });
});

describe('#1515 いまの supabase/functions', () => {
  it('段で検査して緑。検査したファイルの本数が、対象の拡張子のファイルの本数と同じ (空回りしていない)', () => {
    const expected = walkSources(path.join(ROOT, FUNCTIONS_DIR)).length;
    expect(expected).toBeGreaterThan(0);
    const { status, output } = runStep(ROOT);
    expect(output).toContain(`検査したファイル: ${expected} 本`);
    expect(output).toContain(GREEN_MESSAGE);
    expect(status).toBe(0);
  });

  it('#1518 _shared/db-logger.ts は supabase-js を deno.json の名前で import する (esm.sh の URL で読まない)', () => {
    const source = fs.readFileSync(path.join(ROOT, FUNCTIONS_DIR, '_shared/db-logger.ts'), 'utf8');
    expect(source).toMatch(/^import \{ createClient \} from "@supabase\/supabase-js";$/m);
    expect(source).not.toMatch(/from\s*["'`]https?:\/\//);
    const denoJson = JSON.parse(fs.readFileSync(path.join(ROOT, FUNCTIONS_DIR, 'deno.json'), 'utf8')) as { imports: Record<string, string> };
    expect(denoJson.imports['@supabase/supabase-js']).toMatch(/^jsr:@supabase\/supabase-js@\d+\.\d+\.\d+$/);
  });

  it('deno.json の imports はすべて jsr:/npm: の正確な版 (x.y.z) で固定している', () => {
    const denoJsons = fs
      .readdirSync(path.join(ROOT, FUNCTIONS_DIR), { recursive: true, encoding: 'utf8' })
      .filter((file) => path.basename(file) === 'deno.json');
    expect(denoJsons).toContain('deno.json');
    const EXACT_PIN = /^(jsr|npm):(@[a-z0-9-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(\/\S*)?$/;
    for (const file of denoJsons) {
      const imports = (JSON.parse(fs.readFileSync(path.join(ROOT, FUNCTIONS_DIR, file), 'utf8')) as { imports?: Record<string, string> })
        .imports ?? {};
      for (const [name, target] of Object.entries(imports)) {
        expect(target, `${file} の ${name}`).toMatch(EXACT_PIN);
      }
    }
  });
});

describe('#1518 検査したファイルの本数の数え方 (walkSources と同じく、中身が空のファイルも数える)', () => {
  it('中身が空のソースも本数に入る', () => {
    const root = repoWith({ 'a/index.ts': 'import { z } from "zod";\n', 'b/empty.ts': '', '_shared/empty.mjs': '' });
    const expected = walkSources(path.join(root, FUNCTIONS_DIR)).length;
    expect(expected).toBe(3);
    const { status, output } = runStep(root);
    expect(output).toContain(`検査したファイル: ${expected} 本`);
    expect(status).toBe(0);
  });

  it('中身が空のソースだけでも、検査したファイルは 0 本にならず緑', () => {
    const { status, output } = runStep(repoWith({ 'a/index.ts': '' }));
    expect(output).toContain('検査したファイル: 1 本');
    expect(output).toContain(GREEN_MESSAGE);
    expect(status).toBe(0);
  });

  it('対象の拡張子でないファイルは数えない', () => {
    const { output } = runStep(repoWith({ 'a/index.ts': '', 'a/README.md': 'x\n', 'a/deno.json': '{}\n' }));
    expect(output).toContain('検査したファイル: 1 本');
  });
});

describe('#1515 空回りしない (道具が無い・grep が失敗したときは赤)', () => {
  const RAW_FILE = { 'a/index.ts': 'import { z } from "npm:zod";\n' };

  it('grep が無いときは赤', () => {
    const emptyBin = tempDir('pin-nobin-');
    const { status, output } = runStep(repoWith(RAW_FILE), { PATH: emptyBin });
    expect(status).toBe(EXIT_RED);
    expect(output).toContain('grep が無いため');
  });

  it('grep が「コマンドが無い」で終わる (元の rg の空回りと同じ形) ときは、見本の確認で赤', () => {
    const { status, output } = runStep(repoWith(RAW_FILE), fakeGrepPath(`exit ${EXIT_COMMAND_NOT_FOUND}`));
    expect(status).toBe(EXIT_RED);
    expect(output).toContain('見本に当たりません');
  });

  it('grep が何にも当たらない (正規表現の誤りの再現) ときは赤', () => {
    const { status, output } = runStep(repoWith(RAW_FILE), fakeGrepPath('exit 1'));
    expect(status).toBe(EXIT_RED);
    expect(output).toContain('見本に当たりません');
  });

  it('#1518 grep が何にでも当たる (当たってはいけない見本に当たる) ときは赤', () => {
    const { status, output } = runStep(repoWith(RAW_FILE), fakeGrepPath('exit 0'));
    expect(status).toBe(EXIT_RED);
    expect(output).toContain('見本に当たります');
  });

  it('#1518 本数を数える grep がエラー (終了コード 2) を返したときは赤', () => {
    const env = fakeGrepPath(`for a in "$@"; do [ "$a" = -rc ] && exit ${GREP_EXIT_ERROR}; done\nexec ${REAL_GREP} "$@"`);
    const { status, output } = runStep(repoWith({ 'a/index.ts': 'import { z } from "zod";\n' }), env);
    expect(status).toBe(EXIT_RED);
    expect(output).toContain(`ソースを読めません (grep の終了コード ${GREP_EXIT_ERROR})`);
  });

  it('本体の検索の grep がエラー (終了コード 2) を返したときは赤 (「該当なし」と取り違えない)', () => {
    const env = fakeGrepPath(`for a in "$@"; do [ "$a" = -rnE ] && exit ${GREP_EXIT_ERROR}; done\nexec ${REAL_GREP} "$@"`);
    const { status, output } = runStep(repoWith({ 'a/index.ts': 'import { z } from "zod";\n' }), env);
    expect(status).toBe(GREP_EXIT_ERROR);
    expect(output).toContain(`grep が失敗しました (終了コード ${GREP_EXIT_ERROR})`);
  });

  it('supabase/functions が無い・ソースが 1 本も無いときは赤', () => {
    expect(runStep(tempDir('pin-empty-')).status).toBe(EXIT_RED);
    const noSources = repoWith({ 'a/README.md': 'import { z } from "npm:zod";\n' });
    const { status, output } = runStep(noSources);
    expect(status).toBe(EXIT_RED);
    expect(output).toContain('検査するソースがありません');
  });
});
