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
// - 許可リストの id は、集め方 (addTestIdsFromSource) と独立の素朴な方法 (ソースの中の引用符で囲んだ文字列) でも無いことを確かめる。
//   集め方が読めない書き方で testID を作っていると、ソースにある testID が「無い」ことになって許可リストに残るため
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
  listSourceFiles,
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

  it("フローの書き方 ({ id: \"x\" }・入れ子の below: { id: … }・複数行の { … }) の id も抜き出す。引用符の中・コメント・ブロックスカラーの中は拾わない", () => {
    const yaml = [
      '- tapOn: { id: "flow-quoted" }',
      "- assertVisible: { id: 'flow-single', index: 0 }",
      "- tapOn: { index: 1, id: flow-plain }",
      '- assertVisible: { text: "x, id: not-an-id", below: { id: "flow-nested" } }',
      "- tapOn: {",
      '    id: "flow-multiline",',
      "    index: 0 }",
      '- tapOn: { id: "flow-with-comment" }  # 昼食を外す',
      '# - tapOn: { id: "commented-out" }',
      "- evalScript: |",
      '    const o = { id: "in-block-scalar" }',
      "    id: also-in-block-scalar",
      "- tapOn: Hello {name}",
      "- tapOn:",
      "    id: block-after-scalar",
    ].join("\n");
    expect(extractFlowIds(yaml)).toEqual([
      "flow-quoted",
      "flow-single",
      "flow-plain",
      "flow-nested",
      "flow-multiline",
      "flow-with-comment",
      "block-after-scalar",
    ]);
  });

  it("実際の flow の id: は、書き方によらずすべて抜き出せている (読めない書き方の id があれば落ちる)", () => {
    // 数えるだけの素朴な方法 (コメントを外した行の、行頭・空白・{ ・ , のあとの id:) と、抜き出した件数を突き合わせる
    const crudeCount = (yaml: string) =>
      yaml
        .split("\n")
        .map((line) => line.replace(/(^|\s)#.*$/, ""))
        .reduce((n, line) => n + (line.match(/(?:^|[\s{,])id:(?=\s|$)/g)?.length ?? 0), 0);
    for (const flow of listMaestroFlowFiles()) {
      const yaml = fs.readFileSync(path.join(REPO_ROOT, flow), "utf8");
      expect(extractFlowIds(yaml).length, flow).toBe(crudeCount(yaml));
    }
    // フローの書き方だけで書かれた実物の flow (以前はここの id を 1 つも拾えていなかった)
    const servings = fs.readFileSync(path.join(REPO_ROOT, fromMaestro("flows/menus-weekly/17-servings-modal.yaml")), "utf8");
    expect(extractFlowIds(servings)).toContain("weekly-servings-btn");
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

  it("右辺が文字列でも { でもない式 (const testID = cond ? … ; ・ testID: cond ? … , ・ [ … ]・型注釈のあと) の文字列も、式の終わりまで読んで集める", () => {
    const ids = emptyIds();
    addTestIdsFromSource(
      [
        "const testID =",
        '  x ? "a-btn" : "b-btn";',
        'const label = "after-statement";',
        "const opts = { testID: isOn ? 'on-btn' : 'off-btn', title: 'title-text' };",
        'const targetTestIds = ["first-target", "second-target"];',
        'const typedTestID: string = mode === "cond-value" ? "typed-a" : "typed-b";',
        "  const noSemicolonTestID = done",
        '    ? "multi-line-a"',
        '    : "multi-line-b"',
        '  const nextLine = "next-statement"',
        // 式の中のコメントは読まない (コメントの括弧を数えると ; で止まれず、後ろの文の文字列まで拾う)
        "const commentTestID = done // 例 (閉じない括弧",
        '  ? "comment-a"',
        '  : "comment-b";',
        'const afterComment = "after-comment";',
        'const blockTestID = /* ) */ done ? "block-a" : "block-b";',
        // 式が次の行から始まり ; が無いとき、続いているかは名前の行の字下げと比べる
        "const wrapTestID =",
        "  done ?",
        '  "wrap-a" : "wrap-b"',
        'const afterWrap = "after-wrap"',
      ].join("\n"),
      ids,
    );
    for (const id of [
      "a-btn",
      "b-btn",
      "on-btn",
      "off-btn",
      "first-target",
      "second-target",
      "typed-a",
      "typed-b",
      "multi-line-a",
      "multi-line-b",
      "comment-a",
      "comment-b",
      "block-a",
      "block-b",
      "wrap-a",
      "wrap-b",
    ]) {
      expect(isFlowIdInSource(id, ids), id).toBe(true);
    }
    // 式の終わり (; ・ , ・ 字下げが戻った次の行) より後の文字列と、比べる演算子の片側 (条件) は集めない
    for (const id of ["after-statement", "title-text", "next-statement", "cond-value", "after-comment", "after-wrap"]) {
      expect(isFlowIdInSource(id, ids), id).toBe(false);
    }
  });

  it("比べる演算子 (=== !== == !=) の片側の文字列は、どの書き方でも testID として集めない (条件で、testID の値ではない)", () => {
    const ids = emptyIds();
    addTestIdsFromSource(
      [
        "const targetTestId = typeof target === 'string' ? target : null;",
        '<Row testID={opt.value === "newest" ? "sort-newest" : opt.value !== "oldest" ? "sort-name" : "sort-oldest"} />',
        "<Bubble data-testid={msg.role == 'assistant' ? 'ai-bubble' : undefined} />",
        "<Chip testID={'by-name' != sort ? 'chip-off' : 'chip-on'} />",
      ].join("\n"),
      ids,
    );
    for (const id of ["sort-newest", "sort-name", "sort-oldest", "ai-bubble", "chip-off", "chip-on"]) {
      expect(isFlowIdInSource(id, ids), id).toBe(true);
    }
    for (const id of ["string", "newest", "oldest", "assistant", "by-name"]) {
      expect(isFlowIdInSource(id, ids), id).toBe(false);
    }
  });

  it("コメント (// … と /* … */) の中は読まない。文字列の中の // と、正規表現の \\/ はコメントの始まりにしない", () => {
    const ids = emptyIds();
    addTestIdsFromSource(
      [
        '// Normalize testID: replace underscores with dashes, drop "select-" prefix',
        '// testID: "line-comment-id"',
        '{/* testID="jsx-comment-id" */}',
        "/**",
        ' * <View testID="doc-comment-id" />',
        " */",
        // コメントの中の文を式として読むと、閉じない括弧で式の終わりを見失い、後ろの文の文字列まで拾う
        "// testID: don't (閉じない括弧",
        'const afterApostrophe = "after-apostrophe";',
        '<Link href="https://example.com//x" testID="after-url" />',
        '<View onPress={() => s.split(/\\//)} testID="after-regex" />',
      ].join("\n"),
      ids,
    );
    for (const id of ["after-url", "after-regex"]) {
      expect(isFlowIdInSource(id, ids), id).toBe(true);
    }
    for (const id of ["select-", "line-comment-id", "jsx-comment-id", "doc-comment-id", "after-apostrophe"]) {
      expect(isFlowIdInSource(id, ids), id).toBe(false);
    }
  });

  it("JSX の testID={…} は、対応の取れた { … } だけを読む (中の正規表現の ( や [ で崩れて、後ろの属性の文字列を拾わない)", () => {
    const ids = emptyIds();
    addTestIdsFromSource('<View testID={label.replace(/\\(/g, "") ? "paren-a" : "paren-b"} style={{ title: "after-attr" }} />', ids);
    expect(isFlowIdInSource("paren-a", ids)).toBe(true);
    expect(isFlowIdInSource("paren-b", ids)).toBe(true);
    expect(isFlowIdInSource("after-attr", ids)).toBe(false);
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
    // apps/mobile/app/(tabs)/health.tsx のクイックアクション (const testID = a.href === … ? "health-graphs-button" : …;
    // 右辺が文字列でも { でもない式。以前は読めず、ソースにあるのに許可リストに載っていた)
    expect(isFlowIdInSource("health-graphs-button", ids)).toBe(true);
    expect(isFlowIdInSource("health-goals-button", ids)).toBe(true);
    // 比べる演算子の片側 ((tabs)/favorites.tsx の opt.value === "newest"・handson-tour の typeof target === 'string') は testID ではない
    for (const id of ["newest", "oldest", "string"]) {
      expect(isFlowIdInSource(id, ids), id).toBe(false);
    }
    // 以前の meals の flow が期待していた、ソースに無い testID
    for (const id of ["meals-screen", "meal-list", "home-meal-fab", "meals-add-button", "meal-name-error", "home-screen"]) {
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

  it("許可リストの id は、素朴な方法 (ソースの中の引用符で囲んだ文字列) でもソースに無い (集め方が書き方を取りこぼしていれば落ちる)", () => {
    // 集め方 (addTestIdsFromSource) と独立に、ソースのファイルの中身 (コメントも含む) から引用符で囲んだ文字列をすべて抜き出し、
    // 許可リストの id がそのどれか (正規表現の id は全体一致) になっていないかを見る。
    // 見つかるのは、集め方が読めない書き方で testID に使われているか、testID 以外に使われている文字列。どちらでも行を見直す
    const quotedStrings = emptyIds();
    for (const file of listSourceFiles()) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) quotedStrings.exact.add(m[1] ?? m[2] ?? m[3]);
      // 引用符のすぐ内側の "id" / 'id' / `id`。前の引用符の対応 (コメントの don't の ' など) がずれていても見つける
      for (const m of text.matchAll(/(["'`])([\w:-]+)\1/g)) quotedStrings.exact.add(m[2]);
    }
    const quotedInSource = (id: string) => isFlowIdInSource(id, quotedStrings);
    // 素朴な方法の検出力: 集め方が以前読めなかった書き方 ((tabs)/health.tsx の const testID = … ? "health-graphs-button" : …) を見つける
    expect(quotedInSource("health-graphs-button")).toBe(true);
    const found = MAESTRO_MISSING_TESTID_ALLOWLIST.filter((a) => quotedInSource(a.id)).map((a) => `${a.flow} ${a.id}`);
    expect(
      found,
      "許可リストの id がソースの文字列に現れます (集め方の取りこぼしなら集め方を直して行を消す。testID 以外の使い方なら、行の理由が事実か確かめ直す)",
    ).toEqual([]);
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
