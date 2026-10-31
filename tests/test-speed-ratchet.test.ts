// @vitest-environment node
/**
 * #1496 単体テストの 1 ファイルの時間の予算 (速度のラチェット)。
 *
 *   - scripts/vitest-file-timing-reporter.mjs: vitest がファイルごとに測る値 (収集・テストとフック) を JSON に書く
 *   - scripts/test-speed-ratchet.mjs: その JSON (または vitest の --reporter=json の結果) から、予算 (既定 5 秒) を超えた
 *     ファイルを一覧にする。赤にはしない (記録だけ)。時間切れを延ばしたファイル (#1488・#1501) には印を付けて別に並べる
 *   - scripts/local-ci.sh の unit の段が、vitest に reporter を足し、vitest のあとで一覧を成果物に書く (段の判定には入れない)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TEST_FILE_BUDGET_MS,
  EXIT_USAGE,
  FILE_TIMING_FORMAT,
  SPEED_REPORT_FORMAT,
  TEST_FILE_BUDGET_ENV,
  buildSpeedReport,
  formatSpeedReport,
  hasExtendedTimeout,
  main,
  readFileDurations,
  resolveTestFileBudgetMs,
} from '../scripts/test-speed-ratchet.mjs';
import FileTimingReporter, {
  FILE_TIMING_FORMAT as REPORTER_FORMAT,
  FILE_TIMING_OUTPUT_ENV,
  fileTimingReport,
} from '../scripts/vitest-file-timing-reporter.mjs';
import { HEAVY_UNIT_TEST_FILES } from './helpers/heavy-unit-test-timeout';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** tests/helpers/local-ci-slot-test-timeout.ts を使う 3 本 (#1501 の 2 本と #1605 の 1 本) */
const SLOT_TIMEOUT_FILES = [
  'tests/local-ci-slot.test.ts',
  'tests/local-ci-slot-consumers.test.ts',
  'tests/mobile-easignore-bundle-inputs.test.ts',
];

const timingFile = (file: string, collectDuration: number, duration: number, state = 'passed') => ({
  file,
  state,
  collectDuration,
  duration,
  setupDuration: 1,
  prepareDuration: 2,
  environmentSetupDuration: 3,
});

const tmpDirs: string[] = [];
const makeTmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-speed-ratchet-'));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('予算 (UNIT_TEST_FILE_BUDGET_MS)', () => {
  it('既定は 5 秒。正の整数なら上書きする', () => {
    expect(DEFAULT_TEST_FILE_BUDGET_MS).toBe(5_000);
    expect(TEST_FILE_BUDGET_ENV).toBe('UNIT_TEST_FILE_BUDGET_MS');
    expect(resolveTestFileBudgetMs({})).toBe(5_000);
    expect(resolveTestFileBudgetMs({ UNIT_TEST_FILE_BUDGET_MS: ' ' })).toBe(5_000);
    expect(resolveTestFileBudgetMs({ UNIT_TEST_FILE_BUDGET_MS: '8000' })).toBe(8_000);
  });

  it('正の整数でなければ止まる (黙って既定に戻さない)', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '5s']) {
      expect(() => resolveTestFileBudgetMs({ UNIT_TEST_FILE_BUDGET_MS: bad }), bad).toThrow(/UNIT_TEST_FILE_BUDGET_MS/);
    }
  });
});

describe('結果の JSON の読み方', () => {
  it('reporter の結果: 所要 = 収集 + テストとフック (準備・環境・setupFiles は別に持つ)。名前は根からの相対パス', () => {
    const durations = readFileDurations(
      { format: FILE_TIMING_FORMAT, files: [timingFile('tests/a.test.ts', 1_200, 4_000), timingFile(path.join(ROOT, 'tests/b.test.ts'), 10, 20, 'failed')] },
      ROOT,
    );
    expect(durations).toEqual({
      source: 'file-timing',
      files: [
        { file: 'tests/a.test.ts', state: 'passed', ms: 5_200, collectMs: 1_200, testsAndHooksMs: 4_000, overheadMs: 6 },
        { file: 'tests/b.test.ts', state: 'failed', ms: 30, collectMs: 10, testsAndHooksMs: 20, overheadMs: 6 },
      ],
    });
  });

  it('vitest の --reporter=json の結果: 所要 = 最初のテストの開始から最後のテストの終わりまで', () => {
    const durations = readFileDurations(
      { testResults: [{ name: path.join(ROOT, 'tests/a.test.ts'), status: 'passed', startTime: 1_000, endTime: 7_500 }] },
      ROOT,
    );
    expect(durations).toEqual({
      source: 'vitest-json',
      files: [{ file: 'tests/a.test.ts', state: 'passed', ms: 6_500, collectMs: null, testsAndHooksMs: null, overheadMs: null }],
    });
  });

  it('形の分からない JSON は投げる', () => {
    expect(() => readFileDurations({ files: [] }, ROOT)).toThrow(/形が分からない/);
    expect(() => readFileDurations(null, ROOT)).toThrow(/形が分からない/);
  });

  it('reporter と一覧のスクリプトは、同じ形の版を使う', () => {
    expect(REPORTER_FORMAT).toBe(FILE_TIMING_FORMAT);
  });
});

describe('一覧 (予算を超えたファイル・時間切れを延ばしたファイル)', () => {
  const sources: Record<string, string> = {
    'tests/slow.test.ts': 'applyHeavyUnitTestTimeout();',
    'tests/edge.test.ts': '',
    'tests/fast.test.ts': 'vi.setConfig({ testTimeout: 60_000 });',
    'tests/slower.test.ts': '',
  };
  const report = buildSpeedReport(
    readFileDurations(
      {
        format: FILE_TIMING_FORMAT,
        files: [
          timingFile('tests/fast.test.ts', 100, 200),
          timingFile('tests/edge.test.ts', 2_500, 2_500), // ちょうど予算 (超えていない)
          timingFile('tests/slow.test.ts', 1_000, 5_000),
          timingFile('tests/slower.test.ts', 4_000, 9_000),
          timingFile('tests/missing.test.ts', 9_000, 9_000), // 中身を読めない (延ばしていないとみなす)
        ],
      },
      ROOT,
    ),
    { budgetMs: 5_000, readSource: (file) => sources[file] },
  );

  it('予算を超えたもの (等しいものは入らない) を、所要の長い順に並べる', () => {
    expect(report.format).toBe(SPEED_REPORT_FORMAT);
    expect(report.budgetMs).toBe(5_000);
    expect(report.totalFiles).toBe(5);
    expect(report.overBudget.map((f) => [f.file, f.ms, f.extendedTimeout])).toEqual([
      ['tests/missing.test.ts', 18_000, false],
      ['tests/slower.test.ts', 13_000, false],
      ['tests/slow.test.ts', 6_000, true],
    ]);
  });

  it('時間切れを延ばしたファイルは、予算の内外によらず別に並べる', () => {
    expect(report.extendedTimeout.map((f) => [f.file, f.ms])).toEqual([
      ['tests/slow.test.ts', 6_000],
      ['tests/fast.test.ts', 300],
    ]);
  });

  it('文の一覧: 予算・測り方・超えた本数・延ばしたファイルの印・内訳を出す', () => {
    const text = formatSpeedReport(report);
    expect(text).toContain('1 ファイルの時間の予算: 5000 ms (UNIT_TEST_FILE_BUDGET_MS で上書きできる。記録だけで、赤にはしない)');
    expect(text).toContain('所要の測り方: 収集 (import と describe の中身) + テストとフック');
    expect(text).toContain('予算を超えたファイル: 3 本 (全 5 本中)');
    expect(text).toMatch(/^ +6000 ms {2}tests\/slow\.test\.ts \[時間切れを延ばしたファイル\] \(収集 1000 ms \+ テストとフック 5000 ms\)$/m);
    expect(text).toContain('時間切れを延ばしたファイル: 2 本');
  });

  it('延ばしたかどうかは、延ばす関数の呼び出しか vi.setConfig の testTimeout / hookTimeout で見分ける', () => {
    expect(hasExtendedTimeout('applyHeavyUnitTestTimeout();')).toBe(true);
    expect(hasExtendedTimeout('const T = resolveUnitSlotTestTimeout(process.env);')).toBe(true);
    expect(hasExtendedTimeout('vi.setConfig(resolveHeavyUnitTimeouts(process.env));')).toBe(true);
    expect(hasExtendedTimeout('vi.setConfig({ hookTimeout: 1 });')).toBe(true);
    expect(hasExtendedTimeout("import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';")).toBe(false);
    expect(hasExtendedTimeout('vi.setConfig({ restoreMocks: true });')).toBe(false);
  });

  it('時間切れを延ばしたファイル (heavy-unit-test-timeout.ts の一覧 49 本 + local-ci-slot-test-timeout.ts の 3 本 = 52 本。#1501 で 20 本・#1498 で 2 本を一覧から外し、#1605 で一覧に 15 本・local-ci-slot-test-timeout.ts に 1 本、#1657 で一覧に 1 本、#1686 で一覧に 1 本、#1792 で一覧に 1 本、#1779 で一覧に 2 本、#1845 で一覧に 1 本、bash 3.2 のマルチバイトの文字の見張り (tests/shell-multibyte-var-expansion.test.ts) で一覧に 1 本、#1917 の読み込みの失敗の route のテストで一覧に 3 本、#1917 の続きの入力の誤りの route のテスト (tests/route-invalid-input-1917.test.ts) で一覧に 1 本、#1917 の続きの運営の凍結の route と運営の route のゲートの 403 の文のテストで一覧に 2 本、#1917 の続きの仕分け triage-1025a の route のテスト (tests/route-input2-1917.test.ts) で一覧に 1 本、#2093 の構文木によるリポジトリの走査のテスト (tests/email-suppressed-log-level-scan.test.ts と同じ型の 2 本) で一覧に 3 本、#2144 の AI 相談の会話の続きの route のテスト (tests/ai-consultation-latest-messages-2144.test.ts) で一覧に 1 本足した) は、どれも延ばしたファイルとして拾う', () => {
    const extended = [...HEAVY_UNIT_TEST_FILES, ...SLOT_TIMEOUT_FILES];
    expect(extended).toHaveLength(52);
    for (const file of extended) expect(hasExtendedTimeout(read(file)), file).toBe(true);
  });
});

describe('コマンド (main)', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      streams: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } },
    };
  };

  it('一覧を標準出力と --out の JSON に書き、終了コード 0 (予算を超えたファイルがあっても赤にしない)', () => {
    const dir = makeTmp();
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'tests/slow.test.ts'), 'applyHeavyUnitTestTimeout();');
    const input = path.join(dir, 'timing.json');
    fs.writeFileSync(input, JSON.stringify({ format: FILE_TIMING_FORMAT, files: [timingFile('tests/slow.test.ts', 3_000, 9_000)] }));
    const out = path.join(dir, 'nested/report.json');
    const s = io();
    expect(main([input, '--out', out, '--root', dir], {}, s.streams)).toBe(0);
    expect(s.err).toEqual([]);
    expect(s.out.join('')).toContain('予算を超えたファイル: 1 本 (全 1 本中)');
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(written.overBudget).toEqual([
      expect.objectContaining({ file: 'tests/slow.test.ts', ms: 12_000, extendedTimeout: true }),
    ]);
  });

  it('読めない入力・形の違う JSON・正しくない予算・引数の誤りは、終了コード 2 で理由を出す', () => {
    const dir = makeTmp();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{"files": []}');
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ testResults: [] }));
    const cases: Array<[string[], Record<string, string>, RegExp]> = [
      [[path.join(dir, 'none.json')], {}, /ENOENT/],
      [[bad], {}, /形が分からない/],
      [[good], { UNIT_TEST_FILE_BUDGET_MS: 'x' }, /UNIT_TEST_FILE_BUDGET_MS/],
      [[], {}, /使い方/],
      [[good, '--out'], {}, /--out/],
    ];
    for (const [argv, env, message] of cases) {
      const s = io();
      expect(main(argv, env, s.streams), argv.join(' ')).toBe(EXIT_USAGE);
      expect(s.err.join(''), argv.join(' ')).toMatch(message);
    }
  });
});

describe('scripts/vitest-file-timing-reporter.mjs', () => {
  const modules = [
    {
      moduleId: path.join(ROOT, 'tests/a.test.ts'),
      state: () => 'passed',
      diagnostic: () => ({ collectDuration: 10, duration: 20, setupDuration: 1, prepareDuration: 2, environmentSetupDuration: 3 }),
    },
    { moduleId: path.join(ROOT, 'tests/b.test.ts'), state: () => 'failed', diagnostic: () => ({}) },
  ];

  it('vitest がファイルごとに測る値を、根からの相対パスで書く (値が無ければ 0)', () => {
    expect(fileTimingReport(modules, ROOT)).toEqual({
      format: FILE_TIMING_FORMAT,
      files: [
        { file: 'tests/a.test.ts', state: 'passed', collectDuration: 10, duration: 20, setupDuration: 1, prepareDuration: 2, environmentSetupDuration: 3 },
        { file: 'tests/b.test.ts', state: 'failed', collectDuration: 0, duration: 0, setupDuration: 0, prepareDuration: 0, environmentSetupDuration: 0 },
      ],
    });
  });

  it('出力先 (UNIT_FILE_TIMING_OUTPUT) があれば書き、無ければ何も書かない', () => {
    const dir = makeTmp();
    const output = path.join(dir, 'sub/timing.json');
    const reporter = new FileTimingReporter();
    reporter.onInit({ config: { root: ROOT } });
    reporter.onTestRunEnd(modules);
    expect(fs.existsSync(output)).toBe(false);
    vi.stubEnv(FILE_TIMING_OUTPUT_ENV, output);
    reporter.onTestRunEnd(modules);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual(fileTimingReport(modules, ROOT));
  });

  it('書けなくても投げない (テストの結果を変えない。警告だけ)', () => {
    const dir = makeTmp();
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.stubEnv(FILE_TIMING_OUTPUT_ENV, path.join(blocker, 'timing.json'));
      expect(() => new FileTimingReporter().onTestRunEnd(modules)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('scripts/local-ci.sh の unit の段の配線', () => {
  const script = read('scripts/local-ci.sh');
  const fnBody = (name: string) => {
    const lines = script.split('\n');
    const start = lines.findIndex((l) => l === `${name}() {`);
    const end = lines.findIndex((l, i) => i > start && l === '}');
    expect(start, `${name} が無い`).toBeGreaterThanOrEqual(0);
    return lines.slice(start, end + 1).join('\n');
  };

  it('vitest に reporter を足し、出力先を成果物 ($ART) に置く', () => {
    expect(fnBody('stage_unit')).toMatch(
      /^\s*run_in "\$WT" "\$log" env UNIT_FILE_TIMING_OUTPUT="\$ART\/unit-vitest-file-timing\.json" npm test -- .*--reporter=\.\/scripts\/vitest-file-timing-reporter\.mjs$/m,
    );
    expect(fs.existsSync(path.join(ROOT, 'scripts/vitest-file-timing-reporter.mjs'))).toBe(true);
  });

  it('一覧は vitest の判定 (record_parsed unit:vitest) のあとで作り、段の判定には入れない (record を呼ばない・必ず 0 で返る)', () => {
    const unit = fnBody('stage_unit');
    expect(unit.indexOf('unit_test_speed')).toBeGreaterThan(unit.indexOf('record_parsed unit:vitest'));
    const speed = fnBody('unit_test_speed');
    expect(speed).toContain('node scripts/test-speed-ratchet.mjs "$timing" --out "$ART/unit-test-speed.json"');
    expect(speed).not.toMatch(/\brecord(_parsed)?\b/);
    expect(speed.trimEnd().split('\n').slice(-2)[0].trim()).toBe('return 0');
  });

  it('予算の上書き (UNIT_TEST_FILE_BUDGET_MS) を、段へ持ち込む環境変数に入れる', () => {
    const m = /^readonly ENV_ALLOWLIST="([^"]*)"$/m.exec(script);
    expect(m?.[1].split(' ')).toContain(TEST_FILE_BUDGET_ENV);
  });
});
