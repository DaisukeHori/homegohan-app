// @vitest-environment node
/**
 * CSP の nonce 方式と違反の報告の受け口の e2e (tests/e2e/csp-nonce.spec.ts) が、PR の e2e の門から外れないことを確かめる (#1169)。
 *
 * 応答のヘッダー (CSP が 1 つだけ・nonce・'unsafe-inline' が無い) と、ブラウザでの違反 0 件は、本番ビルドを本物のブラウザで
 * 開かないと確かめられない。e2e の実行対象は一覧で明示されているので、一覧 (e2e-local.yml の Playwright の実行と、
 * それを写した local-ci.sh の PW_ARGS) から黙って抜けると、誰も流さなくなる (docs/design/cross/18-csp-nonce.md §8.2・§21)。
 *
 * yml と PW_ARGS が同じ並びであることは tests/local-ci-workflow-sync.test.ts が確かめる。ここでは spec が両方に入っていることだけを見る
 * (作りは tests/e2e-menu-queue-suite.test.ts と同じ)。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, ".github/workflows/e2e-local.yml");
const LOCAL_CI = path.join(ROOT, "scripts/local-ci.sh");

/** 常設のスイートに入れた、CSP の nonce 方式の spec (リポジトリの直下からのパス) */
const CSP_NONCE_SPEC = "tests/e2e/csp-nonce.spec.ts";

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

describe("#1169: CSP の nonce 方式の e2e は PR の CI とローカルの CI で流れる", () => {
  it(`${CSP_NONCE_SPEC}: spec が実在する (名前を変えたのに一覧だけ残ることを防ぐ)`, () => {
    expect(fs.existsSync(path.join(ROOT, CSP_NONCE_SPEC))).toBe(true);
  });

  it(`${CSP_NONCE_SPEC}: e2e-local.yml の Playwright の実行に入っている`, () => {
    const step = mainPlaywrightStep(read(WORKFLOW));
    expect(step, "tests/e2e/01-login.spec.ts を流す npx playwright test の step が見つからない").toBeDefined();
    expect(step?.split(/\s+/)).toContain(CSP_NONCE_SPEC);
  });

  it(`${CSP_NONCE_SPEC}: scripts/local-ci.sh の PW_ARGS に入っている`, () => {
    const args = pwArgs(read(LOCAL_CI));
    expect(args, "PW_ARGS=(...) が見つからない").toBeDefined();
    expect(args).toContain(CSP_NONCE_SPEC);
  });
});
