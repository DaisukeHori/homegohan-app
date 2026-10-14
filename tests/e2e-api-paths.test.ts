/**
 * tests/e2e-api-paths.test.ts
 *
 * #847 回帰防止: 管理系 e2e spec が叩く API パスは、src/app/api/ に実在する route.ts に
 * 対応していなければならない。
 *
 * 背景: tests/e2e/w5-12-admin-adversarial.spec.ts は /api/admin/users/{id}/ban のような
 * 存在しないパス (実在するのは .../freeze) を叩いていた。存在しないパスは Next.js の 404 に
 * なるだけなので、期待値に 404 を含めたテストは偽陽性で通り、403 を期待したテストは
 * 実サーバでだけ落ちる。この spec は Playwright・ローカル DB・開発サーバーが要るため PR の CI では
 * 実行されず、気づかれないまま残っていた。
 *
 * そこで、ブラウザも DB も使わずソースだけを見る静的検査にして、通常の `npm test` (PR の CI) に載せる。
 * 見るのは「パスが実在する route.ts に当てはまるか」まで。HTTP メソッドや body は見ない。
 *
 * 検査対象の spec は SPEC_FILES に足す。ほかの spec にも存在しないパスの参照が残っている可能性があり、
 * 直したものから順に対象へ加える (わざと存在しないパスを叩く spec は対象にしない)。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const API_ROOT = path.join(ROOT, "src/app/api");

const SPEC_FILES = ["tests/e2e/w5-12-admin-adversarial.spec.ts"];

/**
 * route.ts を持つディレクトリを URL セグメントの配列で返す。
 * 例: src/app/api/admin/users/[id]/freeze/route.ts → ["admin", "users", "[id]", "freeze"]
 * (group) のディレクトリは URL に現れないので除く。
 */
function listRoutePatterns(dir: string, segments: string[] = []): string[][] {
  const patterns: string[][] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const isRouteGroup = /^\(.+\)$/.test(entry.name);
      patterns.push(
        ...listRoutePatterns(
          path.join(dir, entry.name),
          isRouteGroup ? segments : [...segments, entry.name],
        ),
      );
    } else if (/^route\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      patterns.push(segments);
    }
  }
  return patterns;
}

/** URL セグメント (先頭の "api" は除いたもの) が route のパターンに当てはまるか */
function matchesRoute(pattern: string[], urlSegments: string[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const segment = pattern[i];
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) return true; // [[...slug]]: 0 個以上
    if (/^\[\.\.\..+\]$/.test(segment)) return urlSegments.length > i; // [...slug]: 1 個以上
    if (i >= urlSegments.length) return false;
    if (/^\[.+\]$/.test(segment)) continue; // [id]: 任意の 1 セグメント
    if (segment !== urlSegments[i]) return false;
  }
  return pattern.length === urlSegments.length;
}

type ApiPathRef = { line: number; raw: string; urlSegments: string[] };

/**
 * ソースから "/api/..." で始まる文字列リテラル (" ' `) を取り出す。
 * クエリ文字列は除き、${...} は動的セグメントとして "x" に置き換える。
 */
function extractApiPaths(source: string): ApiPathRef[] {
  const literal = /"(\/api\/[^"\n]*)"|'(\/api\/[^'\n]*)'|`(\/api\/[^`\n]*)`/g;
  const refs: ApiPathRef[] = [];
  let match: RegExpExecArray | null;
  while ((match = literal.exec(source)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3];
    const pathOnly = raw.split("?")[0].replace(/\$\{[^}]*\}/g, "x");
    refs.push({
      line: source.slice(0, match.index).split("\n").length,
      raw,
      urlSegments: pathOnly.split("/").filter(Boolean).slice(1), // 先頭の "api" を除く
    });
  }
  return refs;
}

function findMissing(refs: ApiPathRef[], routes: string[][]): string[] {
  return refs
    .filter((ref) => !routes.some((pattern) => matchesRoute(pattern, ref.urlSegments)))
    .map((ref) => `L${ref.line}: ${ref.raw}`);
}

describe("#847: 管理系 e2e spec が叩く API パスの実在確認", () => {
  const routes = listRoutePatterns(API_ROOT);

  it("src/app/api の route.ts を読み取れている (空のままで全部通ることを防ぐ)", () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(routes).toContainEqual(["admin", "users", "[id]", "freeze"]);
  });

  for (const specFile of SPEC_FILES) {
    it(`${specFile}: 参照する /api/... パスはすべて実在する route.ts に対応する`, () => {
      const source = fs.readFileSync(path.join(ROOT, specFile), "utf8");
      const refs = extractApiPaths(source);
      // 抽出に失敗して 0 件のまま通ることを防ぐ
      expect(refs.length).toBeGreaterThan(20);
      expect(findMissing(refs, routes)).toEqual([]);
    });
  }
});

describe("検査ロジック自体 (過去の不具合の再現。実際の route 一覧には依存しない)", () => {
  const fakeRoutes = [
    ["admin", "users"],
    ["admin", "users", "[id]", "freeze"],
    ["admin", "moderation", "[type]", "[id]"],
    ["docs", "[...slug]"],
    ["opt", "[[...slug]]"],
  ];

  it("#847: 存在しない /ban のパスを検出する (実在するのは freeze)", () => {
    const source = [
      "await apiFetch(page, `/api/admin/users/${NON_EXISTING_UUID}/ban`, { method: 'POST' });",
      'await apiFetch(page, "/api/admin/users/00000000-0000-0000-0000-000000000000/freeze");',
    ].join("\n");
    expect(findMissing(extractApiPaths(source), fakeRoutes)).toEqual([
      "L1: /api/admin/users/${NON_EXISTING_UUID}/ban",
    ]);
  });

  it("動的セグメント・クエリ文字列・3 種類の引用符を扱える", () => {
    const source = [
      'apiFetch(page, "/api/admin/users?q=%25");',
      "apiFetch(page, '/api/admin/users?q=\\'; DROP TABLE x;--');",
      "apiFetch(page, `/api/admin/users?q=${encodeURIComponent(payload)}`);",
      "apiFetch(page, `/api/admin/moderation/food/${id}`);",
    ].join("\n");
    const refs = extractApiPaths(source);
    expect(refs).toHaveLength(4);
    expect(findMissing(refs, fakeRoutes)).toEqual([]);
  });

  it("[...slug] は 1 個以上、[[...slug]] は 0 個以上のセグメントに当てはまる", () => {
    expect(matchesRoute(["docs", "[...slug]"], ["docs"])).toBe(false);
    expect(matchesRoute(["docs", "[...slug]"], ["docs", "a", "b"])).toBe(true);
    expect(matchesRoute(["opt", "[[...slug]]"], ["opt"])).toBe(true);
    expect(matchesRoute(["opt", "[[...slug]]"], ["opt", "a", "b"])).toBe(true);
  });

  it("セグメント数が違うパスは当てはまらない", () => {
    expect(matchesRoute(["admin", "users", "[id]"], ["admin", "users"])).toBe(false);
    expect(matchesRoute(["admin", "users"], ["admin", "users", "x"])).toBe(false);
  });

  it("/api/ で始まらない文字列 (テスト名・コメント) は拾わない", () => {
    const source = [
      'test("[admin] J-41: /api/admin/catalog/import に通常 user → 403", () => {});',
      "// /api/admin/users/{id}/ban は無い",
    ].join("\n");
    expect(extractApiPaths(source)).toEqual([]);
  });
});
