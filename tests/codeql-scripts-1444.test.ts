// @vitest-environment node
/**
 * #1444 CodeQL の指摘のうち、開発用のスクリプト (scripts/) で直したものの回帰テスト。
 *
 * 1. js/shell-command-injection-from-environment (scripts/report-embedding-progress.mjs):
 *    パスをシェルのコマンド文字列に埋め込まない。at はシェルを通さずに起動し、ジョブの本文 (標準入力) に渡すパスは
 *    scripts/lib/shell-quote-arg.mjs の quoteShellArg で 1 語に引用する。待ってから実行する代わりの経路は、パスを位置引数で渡す。
 * 2. js/insecure-randomness (scripts/diagnostics/v4-benchmark.js): 一時ユーザーのパスワードを Math.random で作らない。
 *
 * どちらのスクリプトも読み込んだ時点で本体が動く (DB・ファイル・外部コマンドに触る) ので、ここでは import せず、
 * ソースの形を確かめる (見張りであって証明ではない)。引用の関数は実際にシェルに通して確かめる。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { quoteShellArg } from '../scripts/lib/shell-quote-arg.mjs';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 1 件のテストの中で子プロセス (bash・git・node など) を起こすので、負荷の高い機械で vitest の既定の時間切れ (テスト 5 秒) を超えうる (#1605 の同じ型)。
// このファイルだけ延ばす (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts。#1488・#1605)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const ROOT = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
/** コメントを除いたコード (説明のコメントに書いた例を拾わないため) */
const codeOf = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('quoteShellArg: シェルを通しても 1 語・元の値のまま渡る', () => {
  it.each([
    ['ふつうのパス', '/opt/app/scripts/report-embedding-progress-wrapper.sh'],
    ['空白', '/Users/me/My Project/wrapper.sh'],
    ['単一引用符', "/tmp/it's/wrapper.sh"],
    ['コマンド置換と変数', '/tmp/$(touch /tmp/pwned-1444)/`id`/$HOME/wrapper.sh'],
    ['区切りと改行', '/tmp/a; rm -rf /tmp/x && echo b\nnext'],
    ['二重引用符とバックスラッシュ', '/tmp/"q"\\\\path'],
    ['空文字', ''],
  ])('%s', (_label, value) => {
    const result = spawnSync('sh', ['-c', `printf '%s' ${quoteShellArg(value)}`], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(value);
  });

  it('1 語になる (引数の数が 1)', () => {
    const result = spawnSync('sh', ['-c', `set -- ${quoteShellArg("a b 'c' d")}; printf '%s' "$#"`], { encoding: 'utf8' });
    expect(result.stdout).toBe('1');
  });
});

describe('scripts/report-embedding-progress.mjs: パスをシェルのコマンド文字列に埋め込まない', () => {
  const code = codeOf(read('scripts/report-embedding-progress.mjs'));

  it('execSync (シェルを通すコマンド文字列) を使わない', () => {
    expect(code).not.toMatch(/\bexecSync\s*\(/);
    expect(code).not.toMatch(/\bexec\s*\(/);
  });

  it('wrapperPath をテンプレート文字列にそのまま埋め込まない (引用してから標準入力へ・または位置引数で渡す)', () => {
    const templates = code.match(/`[^`]*`/g) ?? [];
    const embedded = templates.filter((t) => t.includes('${wrapperPath}'));
    expect(embedded).toEqual([]);
    expect(code).toContain('quoteShellArg(wrapperPath)');
    expect(code).toMatch(/spawnSync\(\s*'at'\s*,\s*\[/);
    expect(code).toMatch(/spawn\(\s*'sh'\s*,\s*\[\s*'-c'\s*,\s*'[^']*"\$1"[^']*'\s*,[^\]]*wrapperPath\s*\]/);
  });
});

describe('scripts/diagnostics/v4-benchmark.js: 一時ユーザーのパスワードは暗号論的な乱数で作る', () => {
  const code = codeOf(read('scripts/diagnostics/v4-benchmark.js'));

  it('パスワードに Math.random を使わず、crypto の randomBytes を使う', () => {
    const passwordLine = code.split('\n').find((line) => /const password\s*=/.test(line));
    expect(passwordLine).toBeDefined();
    expect(passwordLine).not.toContain('Math.random');
    expect(passwordLine).toMatch(/randomBytes\(/);
    expect(code).toMatch(/const \{ randomBytes \} = require\('crypto'\)/);
  });
});
