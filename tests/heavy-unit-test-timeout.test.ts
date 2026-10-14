// @vitest-environment node
/**
 * tests/heavy-unit-test-timeout.test.ts
 * 負荷の高い機械で既定の時間切れを超えたことがある単体テストのファイルの時間切れ (tests/helpers/heavy-unit-test-timeout.ts) の検査 (#1488)。
 *
 *   - 既定はテスト 30 秒・フック 60 秒。環境変数 UNIT_HEAVY_TEST_TIMEOUT_MS / UNIT_HEAVY_HOOK_TIMEOUT_MS で上書きでき、
 *     正の整数でなければ止まる (黙って既定に戻さない。規則と文面は vitest.integration.config.ts の timeoutFromEnv と同じ)
 *   - 全体の既定 (vitest.config.ts の testTimeout / hookTimeout) は変えない (延ばすのは一覧のファイルだけ)
 *   - 一覧のファイルは、テスト・フックを定義する前に applyHeavyUnitTestTimeout() を呼ぶ。一覧に無いファイルは呼ばない
 *   - applyHeavyUnitTestTimeout() は、呼んだファイルのこのあとに登録するテストの時間切れを実際に変える (このファイル自身で確かめる)
 *   - scripts/local-ci.sh は上書きの環境変数を unit の段まで持ち込み、CONTRIBUTING.md の環境変数の表に載っている
 *   - 同じ型のファイル (1 件のテスト・フックの中で子プロセスを起こす・route / Edge Function を丸ごと読み込む。読み込みを
 *     importHandler("../supabase/functions/x/index.ts") のように関数に任せる書き方も含む) は、どれも時間切れを
 *     延ばしている (一覧・ファイルの vi.setConfig・フックやテストへの個別の時間切れのどれか。#1605)。延ばしていないものは、
 *     理由を書いた例外の一覧に載っている。フックやテストへ個別に渡すファイルは、読み込み・子プロセスを含むフック・テストの
 *     どれにも渡している (1 つにだけ渡して残りを既定のままにしていない)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { hasExtendedTimeout } from "../scripts/test-speed-ratchet.mjs";
import vitestConfig from "../vitest.config";
import { timeoutFromEnv } from "../vitest.integration.config";
import {
  DEFAULT_UNIT_HEAVY_HOOK_TIMEOUT_MS,
  DEFAULT_UNIT_HEAVY_TEST_TIMEOUT_MS,
  HEAVY_UNIT_TEST_FILES,
  UNIT_HEAVY_HOOK_TIMEOUT_ENV,
  UNIT_HEAVY_TEST_TIMEOUT_ENV,
  applyHeavyUnitTestTimeout,
  resolveHeavyUnitTimeouts,
} from "./helpers/heavy-unit-test-timeout";
import { testsWithUnexpectedTimeout } from "./helpers/local-ci-slot-test-timeout";

// このファイル自身でも呼び、呼んだあとに登録したテストの時間切れが変わることを確かめる (下の「仕組み」)
const APPLIED = applyHeavyUnitTestTimeout();

const ROOT = process.cwd();
const SELF = "tests/heavy-unit-test-timeout.test.ts";
const LOCAL_CI = "scripts/local-ci.sh";
const CONTRIBUTING = "CONTRIBUTING.md";
/** 別の値 (tests/helpers/local-ci-slot-test-timeout.ts) を使うファイル。一覧に入れない */
const SLOT_TEST_FILES = [
  "tests/local-ci-slot.test.ts",
  "tests/local-ci-slot-consumers.test.ts",
  "tests/mobile-easignore-bundle-inputs.test.ts",
];
/** 呼び出しを探す範囲 (結合テストも含める。結合テストが呼ぶと、結合テストの長い既定を縮めてしまう) */
const SCAN_ROOTS = ["tests", "src"];
const TEST_FILE = /\.test\.tsx?$/;
const SKIP_DIRS = new Set(["node_modules", ".next"]);

/** 既定 (根拠は tests/helpers/heavy-unit-test-timeout.ts) */
const EXPECTED_TEST_TIMEOUT_MS = 30_000;
const EXPECTED_HOOK_TIMEOUT_MS = 60_000;
/** 上書きに使う値 (既定と違えば何でもよい) */
const OVERRIDE_TEST_TIMEOUT_MS = 45_000;
const OVERRIDE_HOOK_TIMEOUT_MS = 90_000;

/** 呼び出しの行 (ファイルの一番外側。文末のセミコロンはファイルの書き方に合わせる) */
const CALL_LINE = /^applyHeavyUnitTestTimeout\(\);?$/m;
/** テスト・フックの登録 (字下げ・.each / .skip などを含む)。呼び出しより前にあってはならない */
const REGISTRATION = /^\s*(?:describe|it|test|suite|beforeAll|beforeEach|afterAll|afterEach)(?:\.[\w.]+)?\s*[(`]/m;

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walkTestFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walkTestFiles(rel);
    return TEST_FILE.test(e.name) ? [rel] : [];
  });
}

/** 一覧のファイルの呼び出しの置き方の問題 (無ければ空) */
function placementProblems(rel: string, text: string): string[] {
  const problems: string[] = [];
  const call = CALL_LINE.exec(text);
  if (!call) return [`${rel}: 一番外側で applyHeavyUnitTestTimeout() を呼んでいない`];
  if (!/import \{ applyHeavyUnitTestTimeout \} from ['"][./]+[\w./-]*helpers\/heavy-unit-test-timeout['"]/.test(text)) {
    problems.push(`${rel}: tests/helpers/heavy-unit-test-timeout から applyHeavyUnitTestTimeout を import していない`);
  }
  const before = text.slice(0, call.index);
  const early = REGISTRATION.exec(before);
  if (early) problems.push(`${rel}: 呼ぶ前にテスト・フックを登録している (${early[0].trim()})`);
  if (/vi\.(?:setConfig|resetConfig)\(/.test(text)) {
    problems.push(`${rel}: vi.setConfig / vi.resetConfig を自分で呼んでいる (時間切れを上書き・巻き戻してしまう)`);
  }
  return problems;
}

/** 同じ型のファイルを探す範囲 (単体テストの全部。vitest.config.ts が外す結合テスト・e2e は除く) */
const SAME_TYPE_SCAN_ROOTS = ["tests", "src", "lib", "packages"];
const SAME_TYPE_SKIP_PREFIXES = ["tests/e2e/", "tests/integration/"];
const UNIT_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** route か Edge Function の本体のパスの文字列 (引用符を含む) */
const ROUTE_PATH_LITERAL = /['"`][^'"`]*(?:\/route(?:\.tsx?)?|supabase\/functions\/[^'"`/]+\/index(?:\.ts)?)['"`]/.source;
/** 字下げした行 (関数・テスト・フックの中) */
const IN_BODY_LINE = /^[ \t]+.*/.source;
/** 文字列そのものを渡す動的 import */
const ROUTE_IMPORT_CALL = String.raw`\bimport\(\s*` + ROUTE_PATH_LITERAL + String.raw`\s*\)`;
/** パスの文字列を関数に渡す (読み込みを関数に任せる書き方) */
const ROUTE_PATH_ARG = String.raw`[\w$]\(\s*` + ROUTE_PATH_LITERAL;
/**
 * 字下げした行 (関数・テスト・フックの中) で、route か Edge Function の本体を丸ごと動的に読み込む。
 * ファイルの一番外側の `await import(...)` は収集のときに読むので、テスト・フックの時間切れに入らない (対象外)
 */
const IN_BODY_ROUTE_IMPORT = new RegExp(IN_BODY_LINE + ROUTE_IMPORT_CALL, "m");
/**
 * 字下げした行で、route か Edge Function の本体のパスを文字列で関数に渡す (importHandler("../supabase/functions/x/index.ts") のように、
 * 読み込みを関数に任せる書き方。#1605 の R1 で、tests/edge-missing-env-response.test.ts をこの形で取りこぼした)。
 * ファイルのどこかに、変数を渡す動的 import (VARIABLE_DYNAMIC_IMPORT) があるときだけ数える
 * (パスの文字列をファイルとして読むだけのもの (fs.readFileSync など) を拾わないため)
 */
const IN_BODY_ROUTE_PATH_ARG = new RegExp(IN_BODY_LINE + ROUTE_PATH_ARG, "m");
/** 文字列そのものでなく、変数・式を渡す動的 import (`import(/* @vite-ignore *\/ modulePath)` など) */
const VARIABLE_DYNAMIC_IMPORT = /\bimport\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(?!['"`])[A-Za-z_$]/;
/** node:child_process から名前で import したもの (このリポジトリのテストは名前で import する) */
const CHILD_PROCESS_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g;
/** 延ばした印 (tests/helpers の値を個別に渡す形。ファイルの vi.setConfig と一覧の呼び出しは hasExtendedTimeout が見る) */
const INDIVIDUAL_TIMEOUT_MARKER = /\bDEFAULT_UNIT_HEAVY_(?:TEST|HOOK)_TIMEOUT_MS\b/;

/**
 * 同じ型だが、延ばす印が無くてよいファイルと理由。stillValid が偽になったら (書き方が変わったら) 一覧から外すか、延ばす。
 * ownTimeout: 自分の時間切れの定数を、読み込み・子プロセスを含むフック・テストに個別に渡しているもの。どのフック・テストにも
 * 渡していることを「例外の一覧は…」が hooksAndTestsWithoutTimeout で確かめる (あとから足したテストが既定の 5 秒のまま残らない)。
 *
 * 自分の定数を渡す形を、例外に載せずに走査で一般に「延ばした」と見なすことはしない: 渡す値は式 (CHILD_TIMEOUT_MS + 30_000 など) で、
 * 既定の 5 秒より長いかを字面からは決められない (tests/check-cron-secret-drift.test.ts には 100 ミリ秒の SHORT_TIMEOUT_MS もある)。
 * 値の根拠はファイルごとに人が読んで reason に書き、stillValid で字面を固定する
 */
const SAME_TYPE_EXCEPTIONS: ReadonlyArray<{ file: string; reason: string; stillValid: RegExp; ownTimeout: boolean }> = [
  {
    file: "tests/check-cron-secret-drift.test.ts",
    reason: "子プロセスを起こすテストは 1 件だけで、そのテストに自分の 60 秒 (TEST_TIMEOUT_MS) を渡している",
    stillValid: /^\s+TEST_TIMEOUT_MS,\n\s+\);/m,
    ownTimeout: true,
  },
  {
    file: "tests/no-committed-credentials.test.ts",
    reason: "git を起こすどのテストにも、自分の 60 秒 (GIT_TIMEOUT_MS) を渡している",
    stillValid: /^const GIT_TIMEOUT_MS = /m,
    ownTimeout: true,
  },
  {
    file: "tests/next-swc-styled-jsx-transform.test.ts",
    reason:
      "子プロセス (Next の SWC の変換) を起こすテストは 1 件だけで、そのテストに自分の 90 秒 (TEST_TIMEOUT_MS = 子の時間切れ 60 秒 + 30 秒) を渡している。" +
      "子の時間切れより長くするのがこのファイルの約束で、applyHeavyUnitTestTimeout の 30 秒では子より短くなる",
    stillValid: /^const CHILD_TIMEOUT_MS = 60_000;$[\s\S]*^const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS \+ 30_000;$[\s\S]*^\s+TEST_TIMEOUT_MS,\n\s+\);/m,
    ownTimeout: true,
  },
  {
    file: "src/__tests__/api/cron/app-log-alerts.test.ts",
    reason: "route はファイルの一番外側で読み込み済みで、テストの中の import は同じモジュールのキャッシュを返すだけ (vi.resetModules をしない)",
    stillValid: /^const \{ GET \} = await import\('@\/app\/api\/cron\/app-log-alerts\/route'\);$/m,
    ownTimeout: false,
  },
];

function walkUnitTestFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) || SAME_TYPE_SKIP_PREFIXES.includes(`${rel}/`) ? [] : walkUnitTestFiles(rel);
    return UNIT_TEST_FILE.test(e.name) ? [rel] : [];
  });
}

/** node:child_process から import した名前 (別名を付けたものは別名) */
function childProcessNames(text: string): string[] {
  return [...text.matchAll(CHILD_PROCESS_IMPORT)].flatMap((m) =>
    m[1]
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/).pop() ?? "")
      .filter((name) => /^[\w$]+$/.test(name)),
  );
}

/** route / Edge Function を丸ごと読み込む (文字列を渡す import か、パスを関数に渡して変数の import で読む) */
const importsRouteInBody = (text: string) =>
  IN_BODY_ROUTE_IMPORT.test(text) || (VARIABLE_DYNAMIC_IMPORT.test(text) && IN_BODY_ROUTE_PATH_ARG.test(text));

/** 同じ型の理由 (route / 子プロセス)。同じ型でなければ空 */
function sameTypeReasons(text: string): string[] {
  const reasons: string[] = [];
  if (importsRouteInBody(text)) reasons.push("route / Edge Function を丸ごと読み込む");
  const names = childProcessNames(text);
  if (names.length > 0 && new RegExp(`^[ \\t]+.*(?<![.\\w$])(?:${names.join("|")})\\s*\\(`, "m").test(text)) {
    reasons.push("子プロセスを起こす");
  }
  return reasons;
}

/**
 * ファイル全体の時間切れを延ばす (applyHeavyUnitTestTimeout() の呼び出しか、ファイル自身の vi.setConfig)。延ばしていれば
 * フック・テストごとに見なくてよい (このファイル自身は `const APPLIED = applyHeavyUnitTestTimeout();` と呼ぶので、行頭の形に限らない。
 * 一覧のファイルの置き方は「一覧のファイルは、テスト・フックを定義する前に…」が別に見る)
 */
const extendsWholeFile = (text: string) => /\bapplyHeavyUnitTestTimeout\(\)/.test(text) || /\bvi\.setConfig\(/.test(text);

/** 時間切れを個別に受け取るフック・テストの関数の名前 */
const HOOK_OR_TEST = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach", "it", "test"]);
/** it.only / test.skip などの修飾 */
const HOOK_OR_TEST_MODIFIERS = new Set(["only", "skip", "concurrent", "sequential", "fails", "todo"]);

function hookOrTestName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return HOOK_OR_TEST.has(callee.text) ? callee.text : null;
  if (ts.isPropertyAccessExpression(callee) && HOOK_OR_TEST_MODIFIERS.has(callee.name.text)) return hookOrTestName(callee.expression);
  return null;
}

/**
 * ファイル全体を延ばしていない同じ型のファイルで、本体 (関数の引数) が route / Edge Function を読み込むか子プロセスを起こすのに、
 * 時間切れを渡していないフック・テスト (`beforeAll (12 行)` の形)。無ければ空。
 * 見張りであって証明ではない: 本体の中に読み込み・子プロセスの呼び出しが書いてあるものだけを見る
 * (本体から呼んだ別の関数の中の読み込みは見ない。その関数にパスを文字列で渡していれば拾う)
 */
function hooksAndTestsWithoutTimeout(rel: string, text: string): string[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, /\.[cm]?[jt]sx$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = childProcessNames(text);
  const spawns = names.length > 0 ? new RegExp(`(?<![.\\w$])(?:${names.join("|")})\\s*\\(`) : null;
  const hasVariableImport = VARIABLE_DYNAMIC_IMPORT.test(text);
  // 本体の文字列は 1 行目が字下げされていないので、字下げの条件を外した形で見る
  const routeImport = new RegExp(ROUTE_IMPORT_CALL);
  const routePathArg = new RegExp(ROUTE_PATH_ARG);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = hookOrTestName(node.expression);
      const fnIndex = node.arguments.findIndex((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      if (name !== null && fnIndex >= 0) {
        const body = node.arguments[fnIndex].getText(source);
        const heavy = routeImport.test(body) || (hasVariableImport && routePathArg.test(body)) || (spawns?.test(body) ?? false);
        const hasTimeout =
          node.arguments.length > fnIndex + 1 ||
          node.arguments.some(
            (a) => ts.isObjectLiteralExpression(a) && a.properties.some((p) => p.name !== undefined && p.name.getText(source) === "timeout"),
          );
        if (heavy && !hasTimeout) {
          found.push(`${rel}: ${name} (${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} 行)`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const extendsTimeout = (text: string) => hasExtendedTimeout(text) || INDIVIDUAL_TIMEOUT_MARKER.test(text);

describe("tests/helpers/heavy-unit-test-timeout.ts の既定と上書き", () => {
  it("環境変数が無ければ テスト 30 秒・フック 60 秒", () => {
    expect(DEFAULT_UNIT_HEAVY_TEST_TIMEOUT_MS).toBe(EXPECTED_TEST_TIMEOUT_MS);
    expect(DEFAULT_UNIT_HEAVY_HOOK_TIMEOUT_MS).toBe(EXPECTED_HOOK_TIMEOUT_MS);
    expect(resolveHeavyUnitTimeouts({})).toEqual({ testTimeout: EXPECTED_TEST_TIMEOUT_MS, hookTimeout: EXPECTED_HOOK_TIMEOUT_MS });
  });

  it("環境変数で、テストとフックをそれぞれ上書きできる。空なら既定", () => {
    expect(resolveHeavyUnitTimeouts({ [UNIT_HEAVY_TEST_TIMEOUT_ENV]: String(OVERRIDE_TEST_TIMEOUT_MS) })).toEqual({
      testTimeout: OVERRIDE_TEST_TIMEOUT_MS,
      hookTimeout: EXPECTED_HOOK_TIMEOUT_MS,
    });
    expect(resolveHeavyUnitTimeouts({ [UNIT_HEAVY_HOOK_TIMEOUT_ENV]: String(OVERRIDE_HOOK_TIMEOUT_MS) })).toEqual({
      testTimeout: EXPECTED_TEST_TIMEOUT_MS,
      hookTimeout: OVERRIDE_HOOK_TIMEOUT_MS,
    });
    expect(resolveHeavyUnitTimeouts({ [UNIT_HEAVY_TEST_TIMEOUT_ENV]: " ", [UNIT_HEAVY_HOOK_TIMEOUT_ENV]: "" })).toEqual({
      testTimeout: EXPECTED_TEST_TIMEOUT_MS,
      hookTimeout: EXPECTED_HOOK_TIMEOUT_MS,
    });
  });

  it("環境変数が正の整数でなければ止まる (黙って既定に戻さない)。文面は結合テストの timeoutFromEnv と同じ", () => {
    for (const name of [UNIT_HEAVY_TEST_TIMEOUT_ENV, UNIT_HEAVY_HOOK_TIMEOUT_ENV]) {
      for (const bad of ["0", "-1", "1.5", "abc", "30s"]) {
        const expected = (() => {
          try {
            timeoutFromEnv({ [name]: bad }, name, EXPECTED_TEST_TIMEOUT_MS);
          } catch (e) {
            return (e as Error).message;
          }
          return "止まらなかった";
        })();
        expect(() => resolveHeavyUnitTimeouts({ [name]: bad }), `${name}=${bad}`).toThrow(expected);
        expect(expected, `${name}=${bad}`).toContain(name);
      }
    }
  });
});

describe("仕組み: applyHeavyUnitTestTimeout() は、呼んだあとに登録したテストの時間切れを変える", () => {
  it("返した値は環境変数から決めた値", () => {
    expect(APPLIED).toEqual(resolveHeavyUnitTimeouts(process.env));
  });

  it("このファイルのどのテストも、呼んだときの時間切れで切れる (全体の既定の 5 秒のまま残っていない)", ({ task }) => {
    expect(testsWithUnexpectedTimeout(task.file, [APPLIED.testTimeout])).toEqual([]);
  });
});

describe("延ばすのは一覧のファイルだけ", () => {
  it("全体の設定 (vitest.config.ts) は testTimeout / hookTimeout を書かない (vitest の既定のまま)", () => {
    expect(vitestConfig.test?.testTimeout).toBeUndefined();
    expect(vitestConfig.test?.hookTimeout).toBeUndefined();
  });

  it("一覧に重複が無く、どれも実在し、別の値を使う local-ci-slot*.test.ts を含まない", () => {
    expect(new Set(HEAVY_UNIT_TEST_FILES).size).toBe(HEAVY_UNIT_TEST_FILES.length);
    for (const rel of HEAVY_UNIT_TEST_FILES) expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
    for (const rel of SLOT_TEST_FILES) expect(HEAVY_UNIT_TEST_FILES, rel).not.toContain(rel);
  });

  it("一覧のファイルは、テスト・フックを定義する前に applyHeavyUnitTestTimeout() を呼ぶ", () => {
    expect(HEAVY_UNIT_TEST_FILES.flatMap((rel) => placementProblems(rel, read(rel)))).toEqual([]);
  });

  it("置き方の検査は、呼び出しの欠け・登録のあと・vi.setConfig の上書きを見つける", () => {
    const imp = "import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';\n";
    expect(placementProblems("ok", `${imp}applyHeavyUnitTestTimeout();\ndescribe('a', () => {});\n`)).toEqual([]);
    expect(placementProblems("missing", `${imp}describe('a', () => {});\n`)).toHaveLength(1);
    expect(placementProblems("late", `${imp}describe('a', () => {});\napplyHeavyUnitTestTimeout();\n`).join()).toContain("登録している");
    expect(placementProblems("nested", `${imp}for (const x of xs) {\n  it.each(xs)('a', () => {});\n}\napplyHeavyUnitTestTimeout();\n`).join()).toContain(
      "登録している",
    );
    expect(placementProblems("hook", `${imp}beforeAll(async () => {});\napplyHeavyUnitTestTimeout();\n`).join()).toContain("登録している");
    expect(placementProblems("override", `${imp}applyHeavyUnitTestTimeout();\nvi.setConfig({ testTimeout: 1 });\n`).join()).toContain("vi.setConfig");
    expect(placementProblems("noimport", "applyHeavyUnitTestTimeout();\n").join()).toContain("import していない");
  });

  it("一覧に無いテストのファイルは applyHeavyUnitTestTimeout() を呼ばない (呼ぶなら一覧に足す)", () => {
    const callers = SCAN_ROOTS.flatMap(walkTestFiles).filter((rel) => rel !== SELF && CALL_LINE.test(read(rel)));
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.filter((rel) => !HEAVY_UNIT_TEST_FILES.includes(rel))).toEqual([]);
    expect([...HEAVY_UNIT_TEST_FILES].sort()).toEqual([...callers].sort());
  });

  it("scripts/local-ci.sh は、時間切れを上書きする環境変数を子プロセスに持ち込む", () => {
    const m = /^readonly ENV_ALLOWLIST="([^"]*)"$/m.exec(read(LOCAL_CI));
    expect(m, "ENV_ALLOWLIST が無い").not.toBeNull();
    const names = (m?.[1] ?? "").split(/\s+/);
    expect(names).toContain(UNIT_HEAVY_TEST_TIMEOUT_ENV);
    expect(names).toContain(UNIT_HEAVY_HOOK_TIMEOUT_ENV);
  });

  it("CONTRIBUTING.md の環境変数の表に載っている", () => {
    const rows = read(CONTRIBUTING)
      .split("\n")
      .filter((line) => line.startsWith("| `"));
    for (const name of [UNIT_HEAVY_TEST_TIMEOUT_ENV, UNIT_HEAVY_HOOK_TIMEOUT_ENV]) {
      expect(rows.some((row) => row.includes(`\`${name}\``)), name).toBe(true);
    }
  });
});

describe("同じ型のファイルは時間切れを延ばしている (#1605)", () => {
  const files = SAME_TYPE_SCAN_ROOTS.flatMap(walkUnitTestFiles);
  const sameType = files.filter((rel) => sameTypeReasons(read(rel)).length > 0);

  it("走査が空振りしていない (#1605 で落ちた 3 本と、既知の同じ型を拾う)", () => {
    expect(files.length).toBeGreaterThan(HEAVY_UNIT_TEST_FILES.length);
    expect(sameType).toEqual(
      expect.arrayContaining([
        "tests/consultation-action-raw-error-text.test.ts",
        "tests/mobile-easignore-bundle-inputs.test.ts",
        "tests/local-ci-slot-consumers.test.ts",
        "tests/ai-consent-enforcement-routes.test.ts",
        "tests/edge-function-cors.test.ts",
        // 読み込みを関数に任せる書き方 (importHandler("../supabase/functions/x/index.ts")。#1605 の R1 で取りこぼした)
        "tests/edge-missing-env-response.test.ts",
        // 子プロセスを起こし、自分の時間切れの定数をテストに渡す (例外の一覧に載せる。#1605 で main の取り込みのときに見つけた)
        "tests/next-swc-styled-jsx-transform.test.ts",
      ]),
    );
    expect(files.some((rel) => SAME_TYPE_SKIP_PREFIXES.some((p) => rel.startsWith(p)))).toBe(false);
  });

  it("同じ型のファイルは、どれも時間切れを延ばしている (延ばしていないのは理由つきの例外だけ)", () => {
    const exceptions = new Set(SAME_TYPE_EXCEPTIONS.map((e) => e.file));
    const missing = sameType
      .filter((rel) => !exceptions.has(rel) && !extendsTimeout(read(rel)))
      .map((rel) => `${rel}: ${sameTypeReasons(read(rel)).join("・")}のに、既定の時間切れのまま`);
    expect(missing).toEqual([]);
  });

  it("フックやテストへ個別に延ばすファイルは、読み込み・子プロセスを含むフック・テストのどれにも時間切れを渡している", () => {
    const exceptions = new Set(SAME_TYPE_EXCEPTIONS.map((e) => e.file));
    const individual = sameType.filter((rel) => !exceptions.has(rel) && !extendsWholeFile(read(rel)));
    expect(individual).toEqual(expect.arrayContaining(["tests/edge-missing-env-response.test.ts", "tests/edge-function-cors.test.ts"]));
    expect(individual.flatMap((rel) => hooksAndTestsWithoutTimeout(rel, read(rel)))).toEqual([]);
  });

  it("例外の一覧は、今も同じ型で、延ばしておらず、理由の前提 (stillValid) が成り立つ", () => {
    for (const e of SAME_TYPE_EXCEPTIONS) {
      expect(fs.existsSync(path.join(ROOT, e.file)), e.file).toBe(true);
      const text = read(e.file);
      expect(sameTypeReasons(text), e.file).not.toEqual([]);
      expect(extendsTimeout(text), `${e.file}: 延ばしたなら例外から外す`).toBe(false);
      expect(e.stillValid.test(text), `${e.file}: ${e.reason} が成り立たない`).toBe(true);
      // 自分の時間切れを渡す例外は、読み込み・子プロセスを含むどのフック・テストにも渡している
      if (e.ownTimeout) expect(hooksAndTestsWithoutTimeout(e.file, text), e.file).toEqual([]);
    }
  });

  it("見分け方は、テスト・フックの中の読み込みと子プロセスを拾い、一番外側の読み込み・正規表現の .exec を拾わない", () => {
    expect(sameTypeReasons("it('a', async () => {\n  await import('@/app/api/x/route');\n});\n")).toEqual(["route / Edge Function を丸ごと読み込む"]);
    expect(sameTypeReasons("beforeAll(async () => {\n  await import('../supabase/functions/foo/index.ts');\n});\n")).toHaveLength(1);
    expect(sameTypeReasons("const { GET } = await import('@/app/api/x/route');\n")).toEqual([]);
    // 読み込みを関数に任せる書き方: パスを文字列で渡し、関数の中で変数を import する
    const loader = "async function load(p: string) {\n  await import(/* @vite-ignore */ p);\n}\n";
    expect(sameTypeReasons(`${loader}beforeAll(async () => {\n  await load('../supabase/functions/foo/index.ts');\n});\n`)).toEqual([
      "route / Edge Function を丸ごと読み込む",
    ]);
    expect(sameTypeReasons(`${loader}it('a', async () => {\n  await load('@/app/api/x/route');\n});\n`)).toHaveLength(1);
    // 変数の import が無ければ、パスの文字列をファイルとして読むだけ (拾わない)
    expect(sameTypeReasons("it('a', () => {\n  fs.readFileSync('supabase/functions/foo/index.ts', 'utf8');\n});\n")).toEqual([]);
    const cp = "import { execFileSync, spawnSync as run } from 'node:child_process';\n";
    expect(sameTypeReasons(`${cp}it('a', () => {\n  run('git', ['init']);\n});\n`)).toEqual(["子プロセスを起こす"]);
    expect(sameTypeReasons(`${cp}it('a', () => {\n  execFileSync('git', ['init']);\n});\n`)).toEqual(["子プロセスを起こす"]);
    expect(sameTypeReasons(`${cp}const out = execFileSync('git', ['init']);\nit('a', () => {\n  /x/.exec(out);\n});\n`)).toEqual([]);
    expect(extendsTimeout("applyHeavyUnitTestTimeout();\n")).toBe(true);
    expect(extendsTimeout("}, DEFAULT_UNIT_HEAVY_HOOK_TIMEOUT_MS);\n")).toBe(true);
    expect(extendsTimeout("const T = resolveHeavyUnitTimeouts(process.env).hookTimeout;\n")).toBe(true);
    expect(extendsTimeout("it('a', () => {});\n")).toBe(false);
  });

  it("フック・テストごとの見分け方は、時間切れを渡していないものだけを行番号つきで拾う", () => {
    const loader = "async function load(p: string) {\n  await import(/* @vite-ignore */ p);\n}\n";
    const hook = (timeout: string) => `beforeAll(async () => {\n  await load('../supabase/functions/foo/index.ts');\n}${timeout});\n`;
    expect(hooksAndTestsWithoutTimeout("a.test.ts", `${loader}${hook(", T")}`)).toEqual([]);
    expect(hooksAndTestsWithoutTimeout("a.test.ts", `${loader}${hook("")}`)).toEqual(["a.test.ts: beforeAll (4 行)"]);
    // 2 つのうち 1 つにだけ渡していれば、渡していない方を拾う
    expect(hooksAndTestsWithoutTimeout("a.test.ts", `${loader}${hook(", T")}${hook("")}`)).toEqual(["a.test.ts: beforeAll (7 行)"]);
    // describe の中のフック・文字列の import・テストの時間切れ (第 3 引数と { timeout })・子プロセス
    const nested = "describe('d', () => {\n  beforeAll(async () => {\n    await import('@/app/api/x/route');\n  });\n});\n";
    expect(hooksAndTestsWithoutTimeout("a.test.ts", nested)).toEqual(["a.test.ts: beforeAll (2 行)"]);
    const cp = "import { execFileSync } from 'node:child_process';\n";
    expect(hooksAndTestsWithoutTimeout("a.test.ts", `${cp}it('a', () => {\n  execFileSync('git', ['init']);\n});\n`)).toEqual([
      "a.test.ts: it (2 行)",
    ]);
    expect(hooksAndTestsWithoutTimeout("a.test.ts", `${cp}it('a', () => {\n  execFileSync('git', ['init']);\n}, T);\n`)).toEqual([]);
    expect(hooksAndTestsWithoutTimeout("a.test.ts", `${cp}it('a', { timeout: T }, () => {\n  execFileSync('git', ['init']);\n});\n`)).toEqual([]);
    // 重くないフック・テストは見ない
    expect(hooksAndTestsWithoutTimeout("a.test.ts", `${cp}beforeEach(() => {\n  h.env = {};\n});\n`)).toEqual([]);
  });

  it("自分の時間切れの定数をテストに渡す形は、同じ型として拾い、延ばした印とは見なさない (例外の一覧に理由つきで載せる)", () => {
    // tests/next-swc-styled-jsx-transform.test.ts の形: 値は式で、字面から既定の 5 秒より長いかを決められない
    const own =
      "import { spawnSync } from 'node:child_process';\nconst CHILD_TIMEOUT_MS = 60_000;\nconst TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 30_000;\n" +
      "it(\n  'a',\n  () => {\n    spawnSync(process.execPath, ['-e', '']);\n  },\n  TEST_TIMEOUT_MS,\n);\n";
    expect(sameTypeReasons(own)).toEqual(["子プロセスを起こす"]);
    expect(extendsTimeout(own)).toBe(false);
    // どのテストにも渡していれば、フック・テストごとの見分け方は何も拾わない (例外の一覧の ownTimeout が見る形)
    expect(hooksAndTestsWithoutTimeout("a.test.ts", own)).toEqual([]);
    // 同じファイルに、子プロセスを起こすのに時間切れを渡さないテストを足すと拾う
    expect(hooksAndTestsWithoutTimeout("a.test.ts", `${own}it('b', () => {\n  spawnSync('git', ['init']);\n});\n`)).toEqual([
      "a.test.ts: it (11 行)",
    ]);
  });
});
