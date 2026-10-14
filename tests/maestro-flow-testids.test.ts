// tests/maestro-flow-testids.test.ts
// #1552: maestro の flow (apps/mobile/maestro/**/*.yaml) が期待する testID (id:) が、ソース (apps/mobile と src) に実在すること。
//
// 以前は、食事のタブがネイティブの画面だったころの flow (meals-screen・meal-list・home-meal-fab など) が、
// 食事のタブが WebView (webview-meals) になったあとも残っていて、実機で流すまで誰も気づけなかった。
// ここでは実機を使わずに、flow の id: をソースの testID と突き合わせる (抜き出しと突き合わせ: tests/helpers/maestro-flow-testids.ts)。
//
// - ソースに無い testID を期待している flow があれば落ちる。#1552 の時点で既にあった meals 以外の食い違いだけは、
//   理由つきの許可リスト (tests/helpers/maestro-flow-testids-allowlist.ts) に載せてある
// - 許可リストの行が古くなったら (ソースに testID が出来た・flow が使わなくなった・flow が無くなった) 落ちる。行を消す
// - meals の flow と、すべての flow が使う共通のログイン (_shared/login.yaml・ensure-welcome.yaml) は、許可リストに載せられない

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAESTRO_DIR,
  REPO_ROOT,
  addTestIdsFromSource,
  collectSourceTestIds,
  extractFlowIds,
  findMissingFlowIds,
  isFlowIdInSource,
  listMaestroFlowFiles,
  type SourceTestIds,
} from "./helpers/maestro-flow-testids";
import { MAESTRO_MISSING_TESTID_ALLOWLIST, MISSING_TESTID_REASONS } from "./helpers/maestro-flow-testids-allowlist";

const keyOf = (flow: string, id: string) => `${flow}\u0000${id}`;
const fromMaestro = (flow: string) => `${MAESTRO_DIR}/${flow}`;

/** 許可リストに載せてはいけない flow (#1552 で直したもの) */
const MUST_BE_CLEAN_PREFIXES = ["flows/meals/", "flows/_shared/login.yaml", "flows/_shared/ensure-welcome.yaml"];

function emptyIds(): SourceTestIds {
  return { exact: new Set(), patterns: [], samples: new Set() };
}

describe("#1552 maestro の flow の testID の抜き出し (検査の道具そのもの)", () => {
  it("flow の id: を、引用符・行末のコメントを外して抜き出す。コメント行の id: は拾わない", () => {
    const yaml = [
      "- tapOn:",
      '    id: "tab-meals"',
      "- assertVisible:",
      "    id: 'webview-meals' # コメント",
      "- tapOn:",
      "    id: plain-id",
      "# - tapOn:",
      '#     id: "commented-out"',
      "- scrollUntilVisible:",
      "    element:",
      '      id: "settings-logout-button"',
      "- tapOn:",
      '    text: "id: ではない"',
    ].join("\n");
    expect(extractFlowIds(yaml)).toEqual(["tab-meals", "webview-meals", "plain-id", "settings-logout-button"]);
  });

  it("ソースの testID を、属性・オブジェクトの値・三項演算子・テンプレート・型注釈つきの対応表・接頭辞から集める", () => {
    const ids = emptyIds();
    addTestIdsFromSource(
      [
        '<View testID="plain-screen" />',
        "<Pressable testID={isLast ? 'submit-button' : \"next-button\"} />",
        "<Tabs.Screen options={{ tabBarButtonTestID: \"tab-x\" }} />",
        "const modes = [{ mode: 'a', testID: 'mode-a' }];",
        "<Text testID={`meal-mode-${mode}`} />",
        "const fieldTestIdMap: Partial<Record<Field, string>> = { weight: \"field-weight\" };",
        '<Choice testIDPrefix="gender" />',
        '<div data-testid="web-only" />',
        "<Row testID={`${testIDPrefix}-${opt.value}`} />",
        "const label = \"not-a-testid\";",
      ].join("\n"),
      ids,
    );
    for (const id of ["plain-screen", "submit-button", "next-button", "tab-x", "mode-a", "field-weight", "web-only"]) {
      expect(isFlowIdInSource(id, ids)).toBe(true);
    }
    expect(isFlowIdInSource("meal-mode-meal", ids)).toBe(true);
    expect(isFlowIdInSource("gender-male", ids)).toBe(true);
    // testID の文脈に無い文字列は testID ではない
    expect(isFlowIdInSource("not-a-testid", ids)).toBe(false);
    // 固定の部分が無いテンプレート (`${testIDPrefix}-${opt.value}`) は、何にでも一致させない
    expect(isFlowIdInSource("anything-at-all", ids)).toBe(false);
    // テンプレートの接頭辞だけ・違う接頭辞は一致しない
    expect(isFlowIdInSource("meal-mode-", ids)).toBe(false);
    expect(isFlowIdInSource("meal-type-meal", ids)).toBe(false);
  });

  it("正規表現の id (maestro は id を正規表現として全体一致で比べる) は、testID やテンプレートを埋めた文字列に全体一致すれば実在とする", () => {
    const ids = emptyIds();
    addTestIdsFromSource("<View testID={`weekly-meal-card-${m.id}`} />\n<View testID=\"webview-menus\" />", ids);
    expect(isFlowIdInSource("weekly-meal-card.*", ids)).toBe(true);
    expect(isFlowIdInSource("webview-.*", ids)).toBe(true);
    expect(isFlowIdInSource("toggle-.*", ids)).toBe(false);
    // 全体一致なので、途中だけの一致は数えない
    expect(isFlowIdInSource("meal-card", ids)).toBe(false);
  });

  it("実際のソースから、スキャンのタブ・ホーム・マイページの歯車の testID を見つける (集め方が実物で働いている)", () => {
    const ids = collectSourceTestIds();
    // apps/mobile/app/(tabs)/_layout.tsx の tabBarButtonTestID
    expect(isFlowIdInSource("tab-meals", ids)).toBe(true);
    // apps/mobile/app/(tabs)/meals.tsx の WebViewScreen testID
    expect(isFlowIdInSource("webview-meals", ids)).toBe(true);
    expect(isFlowIdInSource("webview-home", ids)).toBe(true);
    expect(isFlowIdInSource("profile-settings-button", ids)).toBe(true);
    // apps/mobile/app/meals/new.tsx のテンプレート `meal-mode-${…}`
    expect(isFlowIdInSource("meal-mode-meal", ids)).toBe(true);
    // 以前の meals の flow が期待していた、ソースに無い testID
    for (const id of ["meals-screen", "meal-list", "home-meal-fab", "meal-result-screen", "meals-add-button", "home-screen"]) {
      expect(isFlowIdInSource(id, ids)).toBe(false);
    }
  });
});

describe("#1552 maestro の flow が期待する testID は、ソースに実在する", () => {
  const missing = findMissingFlowIds();
  const allowed = new Map(MAESTRO_MISSING_TESTID_ALLOWLIST.map((a) => [keyOf(fromMaestro(a.flow), a.id), a]));

  it("flow が見つかる (検査の対象が空ではない)", () => {
    const flows = listMaestroFlowFiles();
    expect(flows).toContain(`${MAESTRO_DIR}/smoke.yaml`);
    expect(flows).toContain(`${MAESTRO_DIR}/flows/meals/01-scan-tab-opens-webview.yaml`);
    expect(flows).toContain(`${MAESTRO_DIR}/flows/_shared/login.yaml`);
  });

  it("ソースに無い testID を期待している flow は、許可リストに理由つきで載っているものだけ", () => {
    const notAllowed = missing.filter((m) => !allowed.has(keyOf(m.flow, m.id)));
    expect(notAllowed, "ソースに無い testID を期待している flow があります (flow を今の画面の testID に直す)").toEqual([]);
  });

  it("許可リストの行は、どれもまだ必要 (ソースに testID が出来た・flow が使わなくなった行は消す)", () => {
    const missingKeys = new Set(missing.map((m) => keyOf(m.flow, m.id)));
    const stale = MAESTRO_MISSING_TESTID_ALLOWLIST.filter((a) => !missingKeys.has(keyOf(fromMaestro(a.flow), a.id)));
    expect(stale, "許可リストに古い行があります (消す)").toEqual([]);
  });

  it("許可リストの行は重複せず、flow のファイルが実在し、理由が決められたもののどれか", () => {
    expect(allowed.size).toBe(MAESTRO_MISSING_TESTID_ALLOWLIST.length);
    const reasons = new Set<string>(Object.values(MISSING_TESTID_REASONS));
    for (const a of MAESTRO_MISSING_TESTID_ALLOWLIST) {
      expect(fs.existsSync(path.join(REPO_ROOT, fromMaestro(a.flow))), a.flow).toBe(true);
      expect(reasons.has(a.reason), `${a.flow} ${a.id}`).toBe(true);
    }
  });

  it("meals の flow と共通のログイン (#1552 で直したもの) は、許可リストに載っていない", () => {
    const listed = MAESTRO_MISSING_TESTID_ALLOWLIST.filter((a) =>
      MUST_BE_CLEAN_PREFIXES.some((p) => a.flow === p || a.flow.startsWith(p)),
    );
    expect(listed).toEqual([]);
    const stillMissing = missing.filter((m) =>
      MUST_BE_CLEAN_PREFIXES.some((p) => m.flow === fromMaestro(p) || m.flow.startsWith(fromMaestro(p))),
    );
    expect(stillMissing).toEqual([]);
  });
});
