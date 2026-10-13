/**
 * scripts/vitest-file-timing-reporter.mjs — vitest の 1 ファイルごとの所要を JSON に書く reporter (#1496)
 *
 *   UNIT_FILE_TIMING_OUTPUT=<出力先.json> npx vitest run --reporter=default --reporter=./scripts/vitest-file-timing-reporter.mjs
 *
 * vitest の JSON reporter (--reporter=json) の各ファイルの startTime / endTime は、最初のテストの開始から最後のテストの
 * 終わりまでで、ファイルの import と describe の中身 (収集) と beforeAll / afterAll を含まない。重い処理を beforeAll や
 * describe の中に置いたファイルは、そこに出ない。ここでは vitest がファイルごとに測る値 (TestModule.diagnostic()) をそのまま書く:
 *   collectDuration          ファイルの import と describe の中身の実行
 *   duration                 すべてのテストとフック (beforeAll / afterAll / beforeEach / afterEach) の合計
 *   setupDuration            setupFiles の import
 *   prepareDuration          vitest の準備 (runner・mock など)
 *   environmentSetupDuration 環境 (node / jsdom など) の読み込み
 * 速度の予算の一覧は scripts/test-speed-ratchet.mjs が作る (scripts/local-ci.sh の unit の段が両方を使う)。
 *
 * 出力先の環境変数が無ければ何もしない。書けなかったときも、テストの結果は変えない (警告を出すだけ)。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 出力先を指定する環境変数 */
export const FILE_TIMING_OUTPUT_ENV = 'UNIT_FILE_TIMING_OUTPUT';
/** 出力の形の版 (scripts/test-speed-ratchet.mjs が確かめる) */
export const FILE_TIMING_FORMAT = 'vitest-file-timing/1';

/**
 * TestModule の並びから、出力する JSON の中身を作る (テストから直接呼ぶ)
 * @param {ReadonlyArray<{ moduleId: string; state(): string; diagnostic(): Record<string, number | undefined> }>} testModules
 * @param {string} root リポジトリの根 (ファイルの名前をここからの相対パスにする)
 */
export function fileTimingReport(testModules, root) {
  const files = testModules.map((m) => {
    const d = m.diagnostic();
    return {
      file: path.relative(root, m.moduleId).split(path.sep).join('/'),
      state: m.state(),
      collectDuration: d.collectDuration ?? 0,
      duration: d.duration ?? 0,
      setupDuration: d.setupDuration ?? 0,
      prepareDuration: d.prepareDuration ?? 0,
      environmentSetupDuration: d.environmentSetupDuration ?? 0,
    };
  });
  return { format: FILE_TIMING_FORMAT, files };
}

export default class FileTimingReporter {
  root = process.cwd();

  onInit(vitest) {
    if (vitest?.config?.root) this.root = vitest.config.root;
  }

  onTestRunEnd(testModules) {
    const output = process.env[FILE_TIMING_OUTPUT_ENV];
    if (!output) return;
    try {
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(fileTimingReport(testModules, this.root), null, 2)}\n`);
    } catch (error) {
      console.warn(`[file-timing] ${output} に書けませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
