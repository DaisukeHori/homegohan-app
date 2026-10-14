// @vitest-environment node
/**
 * tests/e2e-tour-contract.test.ts
 *
 * #846 回帰防止: ハンズオンツアーの E2E (tests/e2e/tour) が、静かに skip されたまま CI で何も確かめない状態に戻らないための検査。
 *
 * 背景:
 *   tests/e2e/tour の 7 つの spec には test.skip が約 70 行あった。「API が未実装の可能性」「UI が見つからない」などを理由に、
 *   期待どおりに動かなければ skip で終わる書き方だったため、動いていなくても緑のままだった。
 *   Playwright の `isVisible({ timeout })` は timeout を無視して「今この瞬間に見えているか」だけを返すので、
 *   画面がまだ出ていないだけで「UI が無い」と判断して skip に進んでいた。しかも PR の CI (e2e-local.yml) も
 *   ローカルの CI (scripts/local-ci.sh) も、このディレクトリを実行していなかった。
 *
 * この検査は、ブラウザも DB も使わずソースだけを見て、次を確かめる (通常の `npm test` = PR の CI に載る)。
 *   1. tests/e2e/tour のファイルに .skip( を書かない (test.skip / test.describe.skip / testInfo.skip)。
 *   2. 動かせない理由があるテストは test.fixme にし、annotation の description に理由を書く。fixme の数は
 *      KNOWN_FIXMES に書いた数を超えない (黙って増やせない。直したら数を減らす)。
 *   3. `isVisible({ timeout })` などの、timeout が無視される状態の読み取りを使わない。待つときは expect(...).toBeVisible({ timeout })。
 *   4. tests/e2e/tour の spec はすべて、e2e-local.yml の Playwright の実行と、scripts/local-ci.sh の PW_ARGS に入っている
 *      (PW_ARGS と yml が同じ並びであることは tests/local-ci-workflow-sync.test.ts が確かめる)。
 *   5. spec が getByTestId などで指す testID は、Web の実装 (src/) に実在する (spec だけが知っている名前で、何も無い要素を待たない)。
 *
 * 落ちたとき:
 *   1・2. skip ではなく原因を直す。製品の欠陥で直せないなら、理由付きの test.fixme にして KNOWN_FIXMES の数を足す。
 *   3. expect(locator).toBeVisible({ timeout }) に変える。
 *   4. e2e-local.yml の Playwright の引数と、local-ci.sh の PW_ARGS に spec を足す。
 *   5. 実装に testID (data-testid) を付けるか、spec の名前を実装に合わせる。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TOUR_DIR_REL = "tests/e2e/tour";
const TOUR_DIR = path.join(ROOT, TOUR_DIR_REL);
const WORKFLOW = path.join(ROOT, ".github/workflows/e2e-local.yml");
const LOCAL_CI = path.join(ROOT, "scripts/local-ci.sh");
const SRC_DIR = path.join(ROOT, "src");

/** tests/e2e/tour の spec の数 (01-eligibility 〜 07-skip-and-replay)。読めていないまま全部通ることを防ぐ */
const EXPECTED_SPEC_COUNT = 7;

/**
 * 製品の既知の不具合で動かせず、理由付きの test.fixme にしているテストの数 (ファイルごと)。
 * 03-step1-photo: ツアーの Step 1 の保存 (POST /api/meal-plans/add-from-photo) が、本文に dayDate / mealType が無く 400 になる (#846 で発見)。
 * 05-step3-badges: Step 3 の画面が /api/badges の earned / obtainedAt ではなく obtained_at を見ていて、「獲得済」が付かない (#846 で発見)。
 */
const KNOWN_FIXMES: Readonly<Record<string, number>> = {
  "03-step1-photo.spec.ts": 1,
  "05-step3-badges.spec.ts": 1,
};

/** コメントを除く (説明文に skip や isVisible と書いても検査に引っかからないように。URL の // では切らない) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** skip の呼び出し: test.skip(...) / test.describe.skip(...) / testInfo.skip(...) */
const SKIP_CALL = /\.skip\s*\(/;
/** fixme の呼び出し: test.fixme(...) / test.describe.fixme(...) / testInfo.fixme(...) */
const FIXME_CALL = /\.fixme\s*\(/g;
/** fixme の理由: annotation の description (test.fixme(title, { annotation: { type: "fixme", description } }, body)) */
const FIXME_REASON = /annotation:\s*\{\s*type:\s*["']fixme["'],\s*description:/g;
/** Playwright は isVisible / isHidden / isEnabled などの timeout を無視する */
const STATE_CHECK_WITH_TIMEOUT = /\.is(?:Visible|Hidden|Enabled|Disabled|Checked|Editable)\(\s*\{[^}]*timeout/;
/** spec が testID を指す書き方: getByTestId("x") と、helpers の waitForReactHandlers(page, "x") */
const TEST_ID_REF = /(?:getByTestId|waitForReactHandlers)\(\s*(?:page\s*,\s*)?["']([\w-]+)["']\s*\)/g;

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

const tourFiles = fs
  .readdirSync(TOUR_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();
const specFiles = tourFiles.filter((name) => name.endsWith(".spec.ts"));

/** ワークフローの step (`      - name: ...` から次の step の直前まで) のうち、tests/e2e/01-login.spec.ts を流す Playwright の実行 */
function mainPlaywrightStep(workflow: string): string | undefined {
  return workflow
    .split(/\n\s{6}- /)
    .find((step) => step.includes("npx playwright test") && step.includes("tests/e2e/01-login.spec.ts"));
}

/** local-ci.sh の PW_ARGS=(...) の中身 (語の並び) */
function pwArgs(script: string): string[] | undefined {
  const m = script.match(/^PW_ARGS=\(([^)]*)\)/m);
  return m ? m[1].trim().split(/\s+/) : undefined;
}

/** src/ の .ts / .tsx を再帰的に集める */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 実装に testID が実在するか。文字列リテラル ("x" / 'x' / `x`) か、テンプレートの固定部 (`badge-card-${...}` の badge-card-) で当てる */
function testIdExists(id: string, sources: string[], templatePrefixes: string[]): boolean {
  const literal = new RegExp(`["'\`]${id}["'\`]`);
  if (sources.some((s) => literal.test(s))) return true;
  return templatePrefixes.some((prefix) => id.startsWith(prefix) && id.length > prefix.length);
}

/** テンプレートリテラルの testID の固定部 (data-testid={`badge-card-${badge.code}`} の "badge-card-") を集める */
function collectTemplatePrefixes(sources: string[]): string[] {
  const prefixes = new Set<string>();
  const pattern = /(?:data-testid|testID|testId)=\{\s*(?:[^`}]*\?\s*)?`([\w-]+)\$\{/g;
  for (const s of sources) {
    for (const m of s.matchAll(pattern)) prefixes.add(m[1]);
  }
  return [...prefixes];
}

describe("#846: tests/e2e/tour が静かに skip されない", () => {
  it("検査の対象を読めている (空のままで全部通ることを防ぐ)", () => {
    expect(tourFiles).toContain("helpers.ts");
    expect(specFiles).toHaveLength(EXPECTED_SPEC_COUNT);
  });

  it.each(tourFiles)("%s: .skip( を書いていない (動かせない理由は test.fixme に書く)", (name) => {
    const source = stripComments(read(path.join(TOUR_DIR, name)));
    expect(source).not.toMatch(SKIP_CALL);
  });

  it.each(tourFiles)("%s: test.fixme は KNOWN_FIXMES の数まで、どれも annotation の description に理由がある", (name) => {
    const source = stripComments(read(path.join(TOUR_DIR, name)));
    const fixmes = source.match(FIXME_CALL)?.length ?? 0;
    const reasons = source.match(FIXME_REASON)?.length ?? 0;
    expect(fixmes, "fixme の数が KNOWN_FIXMES と違う (直したら減らす・増やすなら理由を書く)").toBe(KNOWN_FIXMES[name] ?? 0);
    expect(reasons, "理由 (annotation の description) の無い fixme がある").toBe(fixmes);
  });

  it.each(tourFiles)("%s: isVisible({ timeout }) を使っていない (timeout は無視される。toBeVisible で待つ)", (name) => {
    const source = stripComments(read(path.join(TOUR_DIR, name)));
    expect(source).not.toMatch(STATE_CHECK_WITH_TIMEOUT);
  });

  it("KNOWN_FIXMES に書いたファイルは実在する (直して消したのに数だけ残ることを防ぐ)", () => {
    for (const name of Object.keys(KNOWN_FIXMES)) expect(specFiles).toContain(name);
  });
});

describe("#846: tests/e2e/tour の spec は PR の CI とローカルの CI で流れる", () => {
  it.each(specFiles)("%s: e2e-local.yml の Playwright の実行に入っている", (name) => {
    const step = mainPlaywrightStep(read(WORKFLOW));
    expect(step, "tests/e2e/01-login.spec.ts を流す npx playwright test の step が見つからない").toBeDefined();
    expect(step?.split(/\s+/)).toContain(`${TOUR_DIR_REL}/${name}`);
  });

  it.each(specFiles)("%s: scripts/local-ci.sh の PW_ARGS に入っている", (name) => {
    const args = pwArgs(read(LOCAL_CI));
    expect(args, "PW_ARGS=(...) が見つからない").toBeDefined();
    expect(args).toContain(`${TOUR_DIR_REL}/${name}`);
  });
});

describe("#846: spec が指す testID は Web の実装に実在する", () => {
  const sources = listSourceFiles(SRC_DIR).map(read);
  const templatePrefixes = collectTemplatePrefixes(sources);
  const ids = [
    ...new Set(tourFiles.flatMap((name) => [...stripComments(read(path.join(TOUR_DIR, name))).matchAll(TEST_ID_REF)].map((m) => m[1]))),
  ].sort();

  it("testID を読めている (抽出に失敗して 0 件のまま通ることを防ぐ)", () => {
    // Step 1/2/3 の intro 吹き出しは #846 で実装に付けた名前
    expect(ids).toEqual(expect.arrayContaining(["tour-step-1-intro", "tour-step-2-intro", "tour-step-3-intro", "tour-next-button"]));
  });

  it.each(ids)("%s が src/ に実在する", (id) => {
    expect(testIdExists(id, sources, templatePrefixes)).toBe(true);
  });
});

/**
 * モバイルの各 Step の画面と、そこで最初の intro 吹き出しに付ける testID (#846。Maestro が見分ける名前)。
 * モバイルの E2E (Maestro) は PR の CI で流れないので、画面が testId を渡していることはここで見る
 * (吹き出しが testId を中身に付けることは apps/mobile/__tests__/components/TourBubble.testid.test.tsx が確かめる)。
 */
const MOBILE_INTRO_TEST_IDS: ReadonlyArray<{ file: string; testId: string }> = [
  { file: "apps/mobile/app/handson-tour/photo.tsx", testId: "tour-step-1-intro" },
  { file: "apps/mobile/app/handson-tour/menu.tsx", testId: "tour-step-2-intro" },
  { file: "apps/mobile/app/handson-tour/badges.tsx", testId: "tour-step-3-intro" },
];

describe("#846: モバイルの各 Step の画面は、最初の intro 吹き出しに testID を渡す", () => {
  it.each(MOBILE_INTRO_TEST_IDS)("$file が testId: '$testId' を吹き出しに渡す", ({ file, testId }) => {
    const code = stripComments(read(path.join(ROOT, file)));
    expect(code).toMatch(new RegExp(`testId:\\s*["']${testId}["']`));
  });
});

describe("検査ロジック自体 (過去の不具合の再現)", () => {
  it("以前の書き方 (isVisible に timeout を渡して、出ていなければ test.skip) を検出する", () => {
    const before = [
      "const isSaveVisible = await saveBtn.isVisible({ timeout: 10_000 }).catch(() => false);",
      'test.skip(true, "Step 1 完了に必要な UI が見つからない");',
    ].join("\n");
    expect(before).toMatch(STATE_CHECK_WITH_TIMEOUT);
    expect(before).toMatch(SKIP_CALL);
  });

  it("test.describe.skip・testInfo.skip も検出し、test.fixme や toBeVisible({ timeout }) は検出しない", () => {
    expect("test.describe.skip('x', () => {});").toMatch(SKIP_CALL);
    expect("testInfo.skip(cond, 'x');").toMatch(SKIP_CALL);
    expect("test.fixme('x', async () => {});").not.toMatch(SKIP_CALL);
    expect('await expect(page.getByTestId("a")).toBeVisible({ timeout: 10_000 });').not.toMatch(STATE_CHECK_WITH_TIMEOUT);
    expect('const shown = await page.getByTestId("a").isVisible();').not.toMatch(STATE_CHECK_WITH_TIMEOUT);
  });

  it("理由の無い fixme と、理由のある fixme を数え分ける", () => {
    const withReason = 'test.fixme("t", { annotation: { type: "fixme", description: "理由" } }, async () => {});';
    const withoutReason = 'test.fixme("t", async () => {});';
    expect(withReason.match(FIXME_CALL)).toHaveLength(1);
    expect(withReason.match(FIXME_REASON)).toHaveLength(1);
    expect(withoutReason.match(FIXME_CALL)).toHaveLength(1);
    expect(withoutReason.match(FIXME_REASON)).toBeNull();
  });

  it("コメントの中の説明は検査に引っかからない。URL の // で行の残りを切らない", () => {
    expect(stripComments("// test.skip(true) は使わない")).not.toMatch(SKIP_CALL);
    expect(stripComments("/* isVisible({ timeout: 1 }) */ const a = 1;")).not.toMatch(STATE_CHECK_WITH_TIMEOUT);
    expect(stripComments('const u = "http://localhost:3000"; test.skip(true);')).toMatch(SKIP_CALL);
  });

  it("tests/e2e/01-login.spec.ts を流す Playwright の step だけを取り出す (別の step の引数に引きずられない)", () => {
    const workflow = [
      "    steps:",
      "      - name: Other",
      "        run: npx playwright test tests/e2e/tour/01-eligibility.spec.ts",
      "      - name: Playwright",
      "        run: npx playwright test tests/e2e/01-login.spec.ts",
      "      - name: Later",
      "        run: echo after",
    ].join("\n");
    const step = mainPlaywrightStep(workflow);
    expect(step).toContain("tests/e2e/01-login.spec.ts");
    expect(step).not.toContain("tests/e2e/tour/");
    expect(step).not.toContain("echo after");
  });

  it("testID は、文字列リテラルかテンプレートの固定部で当て、無い名前は当てない", () => {
    const sources = [
      '<div data-testid="tour-step-0">',
      "<div data-testid={tutorialMode ? `badge-card-${badge.code}` : 'badge-card'}>",
    ];
    const prefixes = collectTemplatePrefixes(sources);
    expect(prefixes).toEqual(["badge-card-"]);
    expect(testIdExists("tour-step-0", sources, prefixes)).toBe(true);
    expect(testIdExists("badge-card-planner", sources, prefixes)).toBe(true);
    expect(testIdExists("tour-step-9-intro", sources, prefixes)).toBe(false);
    // 前方一致で別名を拾わない (tour-step-0 があっても tour-step-0-title は別)
    expect(testIdExists("tour-step-0-title", sources, prefixes)).toBe(false);
  });

  it("PW_ARGS=(...) の語の並びを取り出す", () => {
    expect(pwArgs("X=1\nPW_ARGS=(--trace off tests/e2e/a.spec.ts tests/e2e/tour/b.spec.ts)\nY=2")).toEqual([
      "--trace",
      "off",
      "tests/e2e/a.spec.ts",
      "tests/e2e/tour/b.spec.ts",
    ]);
  });
});
