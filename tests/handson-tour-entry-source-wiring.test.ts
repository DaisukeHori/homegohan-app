/**
 * tests/handson-tour-entry-source-wiring.test.ts
 *
 * Issue #1045 round-2 (Fable Warning): force フローが /handson-tour/replay 経由の
 * HttpOnly Cookie に移った (F6-05) にもかかわらず、src/app/handson-tour/page.tsx
 * (Step0 ようこそ画面) は依然 searchParams.get('force') === '1' で entrySource を
 * 算出していた。force cookie は HttpOnly のため client からは読めず、常に
 * entry_source: 'auto' になっていたため、設定画面からの「もう一度見る」でも
 * handson_tour_eligible / handson_tour_started の settings_force 計測が
 * 計上されなくなっていた。
 *
 * 修正: page.tsx は layout.tsx がサーバー側で cookie を判定して TourProvider に
 * 渡した entrySource を useTour() 経由で参照するようにした。
 *
 * @testing-library/react が本リポジトリにインストールされていないため、
 * コンポーネントの実レンダリングによる検証はできない
 * (TourProvider は useState/useCallback を使うため、レンダラー無しに直接
 * 呼び出すと Invalid hook call になる)。
 * tests/embedding-contracts.test.ts と同じ手法 (ソーステキストの contract テスト) で、
 * 配線が正しいこと・退行していないことを検証する。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const pagePath = path.join(process.cwd(), "src/app/handson-tour/page.tsx");
const layoutPath = path.join(process.cwd(), "src/app/handson-tour/layout.tsx");
const contextPath = path.join(process.cwd(), "src/contexts/TourContext.tsx");

describe("#1045 round-2: handson-tour/page.tsx の entrySource 配線", () => {
  it("page.tsx は useTour() から entrySource を取得する", () => {
    const source = fs.readFileSync(pagePath, "utf8");
    expect(source).toMatch(/const\s*\{\s*entrySource\s*\}\s*=\s*useTour\(\)/);
  });

  it("page.tsx は searchParams.get('force') で entrySource を再計算しない (regression guard)", () => {
    const source = fs.readFileSync(pagePath, "utf8");
    expect(source).not.toMatch(/searchParams\.get\(\s*['"]force['"]\s*\)/);
  });
});

describe("#1045 round-2: layout.tsx は cookie 経由で entrySource を判定し TourProvider に渡す (既存 F6-05 の前提)", () => {
  it("HANDSON_TOUR_FORCE_COOKIE を参照し、isForce に応じて entrySource を決定する", () => {
    const source = fs.readFileSync(layoutPath, "utf8");
    expect(source).toContain("HANDSON_TOUR_FORCE_COOKIE");
    expect(source).toMatch(/entrySource[^=]*=\s*isForce\s*\?\s*'settings_force'\s*:\s*'auto'/);
  });

  it("TourProvider に entrySource を渡している", () => {
    const source = fs.readFileSync(layoutPath, "utf8");
    expect(source).toMatch(/<TourProvider\s+entrySource=\{entrySource\}/);
  });
});

describe("#1045 round-2: TourContext (useTour) は entrySource を value として公開する", () => {
  it("TourProvider の value オブジェクトに entrySource が含まれる", () => {
    const source = fs.readFileSync(contextPath, "utf8");
    expect(source).toMatch(/entrySource,/);
  });
});
