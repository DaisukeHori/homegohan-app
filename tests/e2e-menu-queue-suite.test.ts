// @vitest-environment node
/**
 * 週の献立の生成 (キュー・進捗・失敗の表示) の e2e 2 本が、常設のスイートから外れないことを確かめる (#1622)。
 *
 * 背景: tests/e2e/w5-3-menu-gen-adversarial.spec.ts と tests/e2e/wave2-f2-queue-reliability.spec.ts は、
 * 以前は PR の CI (e2e-local.yml) にもローカル CI (scripts/local-ci.sh) にも入っておらず、手で流したときにしか動かなかった。
 * そのあいだに、テストの前提が古くなった赤 (F-22 / E-18 / B-6) や、製品の 500 (C-12 の NULL 文字) が見つからないまま残っていた。
 * #1622 で 2 本を常設のスイート (e2e-local.yml の Playwright の実行と、それを写した local-ci.sh の PW_ARGS) に入れた。
 * 一覧から黙って抜けると、また誰も流さなくなるので見張る。
 *
 * yml と PW_ARGS が同じ並びであることは tests/local-ci-workflow-sync.test.ts が確かめる。ここでは 2 本が両方に入っていることだけを見る。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, ".github/workflows/e2e-local.yml");
const LOCAL_CI = path.join(ROOT, "scripts/local-ci.sh");

/** 常設のスイートに入れた、週の献立の生成の spec (リポジトリの直下からのパス) */
const MENU_QUEUE_SPECS = [
  "tests/e2e/w5-3-menu-gen-adversarial.spec.ts",
  "tests/e2e/wave2-f2-queue-reliability.spec.ts",
] as const;

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

describe("#1622: 週の献立の生成の e2e は PR の CI とローカルの CI で流れる", () => {
  it.each(MENU_QUEUE_SPECS)("%s: spec が実在する (名前を変えたのに一覧だけ残ることを防ぐ)", (spec) => {
    expect(fs.existsSync(path.join(ROOT, spec))).toBe(true);
  });

  it.each(MENU_QUEUE_SPECS)("%s: e2e-local.yml の Playwright の実行に入っている", (spec) => {
    const step = mainPlaywrightStep(read(WORKFLOW));
    expect(step, "tests/e2e/01-login.spec.ts を流す npx playwright test の step が見つからない").toBeDefined();
    expect(step?.split(/\s+/)).toContain(spec);
  });

  it.each(MENU_QUEUE_SPECS)("%s: scripts/local-ci.sh の PW_ARGS に入っている", (spec) => {
    const args = pwArgs(read(LOCAL_CI));
    expect(args, "PW_ARGS=(...) が見つからない").toBeDefined();
    expect(args).toContain(spec);
  });
});
