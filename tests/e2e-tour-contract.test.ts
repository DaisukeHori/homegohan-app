// @vitest-environment node
/**
 * #846 ハンズオンツアーの E2E (tests/e2e/tour) が、静かに skip されたまま CI で何も確かめない状態に戻らないための検査
 *
 * 背景:
 *   tests/e2e/tour の 7 つの spec には test.skip が約 70 行あった。「API が未実装の可能性」「UI が見つからない」などを
 *   理由に、期待どおりに動かなければ skip で終わる書き方だったため、動いていなくても緑のままだった。
 *   さらに Playwright の `isVisible({ timeout })` は timeout を無視して「今この瞬間に見えているか」だけを返すので、
 *   画面がまだ出ていないだけで「UI が無い」と判断して skip に進んでいた。しかも PR の CI (e2e-local.yml) はこの
 *   ディレクトリを実行していなかった。
 *
 * この検査は、ブラウザも DB も使わずソースだけを見て、次を確かめる (通常の `npm test` = PR の CI に載る)。
 *   1. tests/e2e/tour のファイルに test.skip / describe.skip を書かない。動かせない理由があるときは test.fixme に
 *      理由を付ける (helpers.ts の provisioningGuard が例)。
 *   2. `isVisible({ timeout })` を使わない (timeout は無視される)。待つときは expect(...).toBeVisible({ timeout })。
 *   3. e2e-local.yml の Playwright 実行が tests/e2e/tour/ を含む (外れると、またどこの CI でも動かなくなる)。
 *
 * 落ちたとき:
 *   1. skip ではなく、原因を直す。環境が足りないだけなら test.fixme(条件, "足りないものと用意のしかた")。
 *   2. expect(locator).toBeVisible({ timeout }) に変える。
 *   3. e2e-local.yml の `npx playwright test` の引数に tests/e2e/tour/ を戻す。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TOUR_DIR = path.join(ROOT, "tests/e2e/tour");
const WORKFLOW = path.join(ROOT, ".github/workflows/e2e-local.yml");

/** コメントを除く (説明文に skip や isVisible と書いても検査に引っかからないように) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 「skip を呼んでいる」と見なすもの: test.skip(...) / test.describe.skip(...) / testInfo.skip(...) など `.skip(` と `.skip ` の呼び出し */
const SKIP_CALL = /\.skip\s*\(/;
/** Playwright は isVisible / isHidden / isEnabled などの timeout を無視する */
const STATE_CHECK_WITH_TIMEOUT = /\.is(?:Visible|Hidden|Enabled|Disabled|Checked|Editable)\(\s*\{[^}]*timeout/;

const tourFiles = fs
  .readdirSync(TOUR_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();

describe("#846: tests/e2e/tour が静かに skip されない", () => {
  it("検査の対象を読めている (空のままで全部通ることを防ぐ)", () => {
    expect(tourFiles).toContain("helpers.ts");
    expect(tourFiles.filter((name) => name.endsWith(".spec.ts")).length).toBeGreaterThanOrEqual(7);
  });

  it.each(tourFiles)("%s: test.skip を書いていない (動かせない理由は test.fixme に書く)", (name) => {
    const source = stripComments(fs.readFileSync(path.join(TOUR_DIR, name), "utf8"));
    expect(source).not.toMatch(SKIP_CALL);
  });

  it.each(tourFiles)("%s: isVisible({ timeout }) を使っていない (timeout は無視される。toBeVisible で待つ)", (name) => {
    const source = stripComments(fs.readFileSync(path.join(TOUR_DIR, name), "utf8"));
    expect(source).not.toMatch(STATE_CHECK_WITH_TIMEOUT);
  });

  it("e2e-local.yml の Playwright 実行が tests/e2e/tour/ を含む (PR の CI で動かす)", () => {
    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    const command = workflow.slice(workflow.indexOf("npx playwright test"));
    expect(command.length).toBeGreaterThan(0);
    // `npx playwright test` から次の step (空行) までが 1 つのコマンド
    const [playwrightCommand] = command.split(/\n\s*\n/);
    expect(playwrightCommand).toContain("tests/e2e/tour/");
  });
});

describe("検査ロジック自体 (過去の不具合の再現)", () => {
  it("#846: 以前の書き方 (isVisible に timeout を渡して、出ていなければ test.skip) を検出する", () => {
    const before = [
      'const isSaveVisible = await saveBtn.isVisible({ timeout: 10_000 }).catch(() => false);',
      'test.skip(true, "Step 1 完了に必要な UI が見つからない");',
    ].join("\n");
    expect(before).toMatch(STATE_CHECK_WITH_TIMEOUT);
    expect(before).toMatch(SKIP_CALL);
  });

  it("test.describe.skip・testInfo.skip も検出し、test.fixme や toBeVisible({ timeout }) は検出しない", () => {
    expect("test.describe.skip('x', () => {});").toMatch(SKIP_CALL);
    expect("testInfo.skip(cond, 'x');").toMatch(SKIP_CALL);
    expect("test.fixme(cond, 'x');").not.toMatch(SKIP_CALL);
    expect('await expect(page.getByTestId("a")).toBeVisible({ timeout: 10_000 });').not.toMatch(STATE_CHECK_WITH_TIMEOUT);
    // timeout を渡さない isVisible は、今の状態を見るだけの使い方なので対象にしない
    expect('const shown = await page.getByTestId("a").isVisible();').not.toMatch(STATE_CHECK_WITH_TIMEOUT);
  });

  it("コメントの中の説明は検査に引っかからない。URL の // で行の残りを切らない", () => {
    expect(stripComments("// test.skip(true) は使わない")).not.toMatch(SKIP_CALL);
    expect(stripComments("/* isVisible({ timeout: 1 }) */ const a = 1;")).not.toMatch(STATE_CHECK_WITH_TIMEOUT);
    expect(stripComments('const u = "http://localhost:3000"; test.skip(true);')).toMatch(SKIP_CALL);
  });
});
