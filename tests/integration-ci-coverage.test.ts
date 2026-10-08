/**
 * tests/integration-ci-coverage.test.ts
 *
 * #1313 / #850 回帰防止: tests/integration/ の結合テストは、すべて CI の実行対象に入っていなければならない。
 *
 * 背景: 結合テスト (ローカルの Supabase と Next の開発サーバーが要る) は、PR の通常の `npm test` では動かない。
 * .github/workflows/security-regression.yml が、vitest にパスの文字列を渡して選んで実行している。
 * vitest は「渡された文字列を、テストファイルの相対パスが含んでいれば対象にする」(部分一致。大文字小文字は区別しない)。
 * そのため、ファイルを足しても、どの文字列にも当たらなければ、CI では動かないまま残り、落ちていても誰も気づけない。
 * 実際に tests/integration/operator/super-admin-*.test.ts (12 本) は、`operator/admin-` の指定に当たらず、
 * しばらく CI で動いていなかった (#850)。handson-tour と operator も同じ状態だった (#1313)。
 *
 * そこで、DB も開発サーバーも使わずソースだけを見る静的検査にして、通常の `npm test` (PR の CI) に載せる。
 *   - tests/integration/ の *.test.ts は、すべてワークフローの指定のどれかに当たる
 *   - ワークフローの指定は、どれも 1 本以上のテストに当たる
 *     (ファイル名を変えたあとに指定だけが残り、何も動かないまま気づけないことを防ぐ)
 *   - CI で動かしていないと承知しているファイルは、NOT_RUN_IN_CI に理由を付けて列挙する。
 *     動かすようにしたら、ここから外す (外し忘れも、このテストが検出する)
 *
 * 新しい結合テストを足すときは、ファイル名を既存の指定に合わせるか、ワークフローの指定を足すこと。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const INTEGRATION_DIR = "tests/integration";
const WORKFLOW = ".github/workflows/security-regression.yml";

/** vitest の結合テスト用の設定ファイル。ワークフローの中で、この文字列を含む行から先が vitest へ渡す引数 */
const INTEGRATION_CONFIG = "vitest.integration.config.ts";

/** CI では動かしていない結合テスト。理由を書く。動かすようにしたら、ここから外す */
const NOT_RUN_IN_CI: Record<string, string> = {
  "tests/integration/edge-functions/smoke.test.ts":
    "デプロイ済みの Edge Function (/functions/v1/*) を呼ぶスモークテスト。このワークフローは Edge Function を起動しない",
};

/** ディレクトリ以下の *.test.ts を、ROOT からの相対パス (区切りは /) で返す */
function listIntegrationTests(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listIntegrationTests(rel));
    else if (entry.name.endsWith(".test.ts")) files.push(rel);
  }
  return files.sort();
}

/**
 * ワークフローから、結合テスト用の vitest に渡すパスの指定 (tests/integration/... で始まる文字列) を取り出す。
 * YAML のコメント行は読まない。vitest の引数は `run: >` で複数行に折り返してあるため、
 * 設定ファイルを指す行から、空行か次の YAML の項目 (`- name:` / `if:` など) までを 1 つの引数列として読む。
 */
function extractCiFilters(workflowText: string): string[] {
  const filters = new Set<string>();
  let inCommand = false;
  for (const line of workflowText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    if (trimmed.includes(INTEGRATION_CONFIG)) inCommand = true;
    else if (trimmed === "" || trimmed.startsWith("- ") || /^[A-Za-z_-]+:/.test(trimmed)) inCommand = false;
    if (!inCommand) continue;
    for (const match of trimmed.matchAll(/(?<![\w./-])tests\/integration\/[^\s"'\\]*/g)) {
      filters.add(match[0]);
    }
  }
  return [...filters];
}

/** vitest のファイル指定と同じ判定: 相対パスが指定の文字列を含んでいれば対象 (大文字小文字は区別しない) */
function isSelectedByFilters(file: string, filters: string[]): boolean {
  const lower = file.toLowerCase();
  return filters.some((filter) => lower.includes(filter.toLowerCase()));
}

describe("#1313 / #850: tests/integration/ の結合テストが CI の実行対象に入っている", () => {
  const workflowText = fs.readFileSync(path.join(ROOT, WORKFLOW), "utf8");
  const filters = extractCiFilters(workflowText);
  const files = listIntegrationTests(INTEGRATION_DIR);

  it("ワークフローの指定と、テストファイルの一覧を読み取れている (空のままで全部通ることを防ぐ)", () => {
    expect(filters).toEqual(expect.arrayContaining(["tests/integration/rls", "tests/integration/security"]));
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("tests/integration/operator/super-admin-plans.test.ts");
  });

  it("tests/integration/ の *.test.ts は、すべて security-regression.yml の指定のどれかに当たる", () => {
    const notRun = files.filter((file) => !isSelectedByFilters(file, filters) && !(file in NOT_RUN_IN_CI));
    expect(
      notRun,
      `CI で動かないテストファイルがあります。ファイル名を既存の指定 (${filters.join(" / ")}) に合わせるか、` +
        `${WORKFLOW} の vitest の指定を足してください。`,
    ).toEqual([]);
  });

  it("ワークフローの指定は、どれも 1 本以上のテストファイルに当たる (何も動かない指定を残さない)", () => {
    const dead = filters.filter((filter) => !files.some((file) => isSelectedByFilters(file, [filter])));
    expect(dead, `どのテストファイルにも当たらない指定があります。不要なら ${WORKFLOW} から外してください。`).toEqual([]);
  });

  it("NOT_RUN_IN_CI のファイルは実在し、本当に CI の対象外である (動かすようにしたら一覧から外す)", () => {
    for (const file of Object.keys(NOT_RUN_IN_CI)) {
      expect(files, `${file} が見つかりません。移動・削除したなら NOT_RUN_IN_CI から外してください。`).toContain(file);
      expect(
        isSelectedByFilters(file, filters),
        `${file} は CI の対象に入っています。NOT_RUN_IN_CI から外してください。`,
      ).toBe(false);
    }
  });
});

describe("検査ロジック自体 (過去の不具合の再現。実際のワークフローには依存しない)", () => {
  // #1313 の時点の security-regression.yml の vitest の指定と同じ形
  const beforeWorkflow = [
    "      # tests/integration/operator/super-admin- は #850 で追加する (コメントなので読まない)",
    "      - name: Run security regression + handson-tour integration tests",
    "        run: >",
    "          npx vitest run --config vitest.integration.config.ts --passWithNoTests",
    "          tests/integration/rls tests/integration/security tests/integration/handson-tour",
    "",
    "      - name: Run operator (admin) integration tests",
    "        if: ${{ !cancelled() }}",
    "        run: >",
    "          npx vitest run --config vitest.integration.config.ts",
    "          tests/integration/operator/admin-",
    "          tests/integration/operator/auth-boundary",
    "",
    "      - name: Show logs on failure",
    "        if: failure()",
    "        run: |",
    "          echo tests/integration/not-a-vitest-argument",
  ].join("\n");

  it("折り返した vitest の引数を読み取り、コメント行や別の run の中の文字列は読まない", () => {
    expect(extractCiFilters(beforeWorkflow)).toEqual([
      "tests/integration/rls",
      "tests/integration/security",
      "tests/integration/handson-tour",
      "tests/integration/operator/admin-",
      "tests/integration/operator/auth-boundary",
    ]);
  });

  it("#850: super-admin-*.test.ts は `operator/admin-` の指定に当たらない (部分一致の落とし穴)", () => {
    const filters = extractCiFilters(beforeWorkflow);
    expect(isSelectedByFilters("tests/integration/operator/admin-users.test.ts", filters)).toBe(true);
    expect(isSelectedByFilters("tests/integration/operator/super-admin-plans.test.ts", filters)).toBe(false);
  });

  it("部分一致は大文字小文字を区別せず、vitest と同じく相対パスの一部に当たれば対象", () => {
    expect(isSelectedByFilters("tests/integration/RLS/foo.test.ts", ["tests/integration/rls"])).toBe(true);
    expect(isSelectedByFilters("tests/integration/rlsx/foo.test.ts", ["tests/integration/rls"])).toBe(true);
    expect(isSelectedByFilters("tests/integration/security/foo.test.ts", ["tests/integration/rls"])).toBe(false);
  });
});
