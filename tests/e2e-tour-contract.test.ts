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
 *      理由を付ける (既知の不具合の 2 件と、テスト用ユーザーを作る環境が無いときの provisioningGuard が例)。
 *   2. `isVisible({ timeout })` を使わない (timeout は無視される)。待つときは expect(...).toBeVisible({ timeout })。
 *   3. e2e-local.yml の Playwright 実行が tests/e2e/tour/ を含み、E2E_REQUIRE_LOGIN=1 を渡す
 *      (外れると、またどこの CI でも動かない。後者が外れると、環境が足りないときに fixme で緑のまま終わる)。
 *   4. テスト用ユーザーを作る環境が足りないとき、CI (E2E_REQUIRE_LOGIN=1) では fixme ではなく失敗にする。
 *
 * 落ちたとき:
 *   1. skip ではなく、原因を直す。環境が足りないだけなら test.fixme(条件, "足りないものと用意のしかた")。
 *   2. expect(locator).toBeVisible({ timeout }) に変える。
 *   3. e2e-local.yml の `npx playwright test` の引数に tests/e2e/tour/ を、その step の env に E2E_REQUIRE_LOGIN: "1" を戻す。
 *   4. tests/e2e/tour/provisioning.ts の decideProvisioning を直す。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { decideProvisioning, missingProvisioningEnv } from "./e2e/tour/provisioning";

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

/** ワークフローの step (`      - name: ...` から次の step の直前まで) のうち、Playwright を実行するもの */
function playwrightStep(workflow: string): string | undefined {
  return workflow.split(/\n\s{6}- /).find((step) => step.includes("npx playwright test"));
}

const tourFiles = fs
  .readdirSync(TOUR_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();

describe("#846: tests/e2e/tour が静かに skip されない", () => {
  it("検査の対象を読めている (空のままで全部通ることを防ぐ)", () => {
    expect(tourFiles).toContain("helpers.ts");
    expect(tourFiles).toContain("provisioning.ts");
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
    const step = playwrightStep(fs.readFileSync(WORKFLOW, "utf8"));
    expect(step, "npx playwright test を実行する step が見つからない").toBeDefined();
    expect(step).toContain("tests/e2e/tour/");
  });

  it('e2e-local.yml の Playwright 実行が E2E_REQUIRE_LOGIN: "1" を渡す (環境が足りないとき、fixme ではなく失敗にする)', () => {
    const step = playwrightStep(fs.readFileSync(WORKFLOW, "utf8"));
    expect(step, "npx playwright test を実行する step が見つからない").toBeDefined();
    expect(step).toMatch(/E2E_REQUIRE_LOGIN:\s*"1"/);
  });
});

describe("#846: テスト用ユーザーを作る環境が足りないときの扱い (tests/e2e/tour/provisioning.ts)", () => {
  const complete = {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  };

  it("そろっていれば、そのまま走らせる (CI かどうかに関係なく)", () => {
    expect(decideProvisioning(complete)).toEqual({ action: "run" });
    expect(decideProvisioning({ ...complete, E2E_REQUIRE_LOGIN: "1" })).toEqual({ action: "run" });
  });

  it("足りないときは、足りない変数の名前と用意のしかたを理由に付けて fixme にする (CI 以外)", () => {
    const { SUPABASE_SERVICE_ROLE_KEY: _removed, ...withoutServiceRole } = complete;

    const decision = decideProvisioning(withoutServiceRole);

    expect(decision.action).toBe("fixme");
    if (decision.action === "run") throw new Error("unreachable");
    expect(decision.reason).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(decision.reason).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(decision.reason).toContain("scripts/supabase-local.sh env .env.local");
  });

  it("CI (E2E_REQUIRE_LOGIN=1) で足りないときは、fixme にせず失敗にする (緑のまま何も確かめない状態に戻さない)", () => {
    const decision = decideProvisioning({ E2E_REQUIRE_LOGIN: "1" });

    expect(decision.action).toBe("fail");
    if (decision.action === "run") throw new Error("unreachable");
    // 3 つとも足りないので、3 つの名前が理由に出る
    expect(decision.reason).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(decision.reason).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(decision.reason).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });

  it("E2E_REQUIRE_LOGIN が 1 以外 (空文字・0) のときは CI 扱いにしない", () => {
    expect(decideProvisioning({ E2E_REQUIRE_LOGIN: "" }).action).toBe("fixme");
    expect(decideProvisioning({ E2E_REQUIRE_LOGIN: "0" }).action).toBe("fixme");
  });

  it("空文字の変数は、無いものとして数える", () => {
    expect(missingProvisioningEnv({ ...complete, SUPABASE_SERVICE_ROLE_KEY: "" })).toEqual(["SUPABASE_SERVICE_ROLE_KEY"]);
    expect(missingProvisioningEnv(complete)).toEqual([]);
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

  it("Playwright を実行する step だけを取り出す (別の step の env や引数に引きずられない)", () => {
    const workflow = [
      "    steps:",
      "      - name: Other",
      '        env: { E2E_REQUIRE_LOGIN: "1" }',
      "        run: echo tests/e2e/tour/",
      "      - name: Playwright",
      "        run: npx playwright test tests/e2e/01-login.spec.ts",
      "      - name: Later",
      "        run: echo after",
    ].join("\n");

    const step = playwrightStep(workflow);

    expect(step).toContain("tests/e2e/01-login.spec.ts");
    expect(step).not.toContain("tests/e2e/tour/");
    expect(step).not.toMatch(/E2E_REQUIRE_LOGIN/);
    expect(step).not.toContain("echo after");
  });
});
