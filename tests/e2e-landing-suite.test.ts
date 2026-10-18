// @vitest-environment node
/**
 * 紹介ページ (/) の e2e (tests/e2e/landing-page.spec.ts) が、PR の e2e の門から外れないことを確かめる (#1867。docs/design/marketing/01-landing-site.md §16.4)。
 *
 * 構造・操作・動きを減らす設定・拡大と幅・速さの予算・CSP 違反 0・axe の違反 0 は、本番ビルドを本物のブラウザで開かないと確かめられない。
 * e2e の実行対象は一覧で明示されているので、一覧 (e2e-local.yml の Playwright の実行と、それを写した local-ci.sh の PW_ARGS) から黙って抜けると、
 * 誰も流さなくなる。yml と PW_ARGS が同じ並びであることは tests/local-ci-workflow-sync.test.ts が確かめる。ここでは spec が両方に入っていることだけを見る
 * (作りは tests/e2e-csp-nonce-suite.test.ts と同じ)。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, ".github/workflows/e2e-local.yml");
const LOCAL_CI = path.join(ROOT, "scripts/local-ci.sh");

/** 常設のスイートに入れた、紹介ページの spec (リポジトリの直下からのパス) */
const LANDING_SPEC = "tests/e2e/landing-page.spec.ts";

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

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

describe("#1867: 紹介ページの e2e は PR の CI とローカルの CI で流れる", () => {
  it(`${LANDING_SPEC}: spec が実在する (名前を変えたのに一覧だけ残ることを防ぐ)`, () => {
    expect(fs.existsSync(path.join(ROOT, LANDING_SPEC))).toBe(true);
  });

  it(`${LANDING_SPEC}: e2e-local.yml の Playwright の実行に入っている`, () => {
    const step = mainPlaywrightStep(read(WORKFLOW));
    expect(step, "tests/e2e/01-login.spec.ts を流す npx playwright test の step が見つからない").toBeDefined();
    expect(step?.split(/\s+/)).toContain(LANDING_SPEC);
  });

  it(`${LANDING_SPEC}: scripts/local-ci.sh の PW_ARGS に入っている`, () => {
    const args = pwArgs(read(LOCAL_CI));
    expect(args, "PW_ARGS=(...) が見つからない").toBeDefined();
    expect(args).toContain(LANDING_SPEC);
  });
});
