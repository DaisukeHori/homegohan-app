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
import os from "node:os";
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

  it("YAML の書き方の違い (先頭の appId の文書と --- のあとの文書・引用符つきのキー \"id\"・数に見える id) でも、id を文字列として抜き出す", () => {
    // 引用符つきのキーは、以前の読み方 (行の文字を数える) では id と読めなかった。
    // 数に見える id は YAML の既定の型では数になるが、maestro は id を文字列として比べるので、文字列として抜き出す
    const yaml = [
      "appId: com.example.app",
      "---",
      '- tapOn: { "id": "quoted-key-flow" }',
      "- tapOn:",
      "    'id': quoted-key-block",
      "- assertVisible:",
      "    id: 2024",
      "- tapOn: { id: true }",
      // 値の無い id: と、値が対応表の id: は文字列ではないので抜き出さない (実物の flow なら、素朴に数えた件数との突き合わせで落ちる)。
      // 対応表の中はたどる
      "- tapOn:",
      "    id:",
      "- tapOn:",
      "    id:",
      "      id: inside-mapping-id",
    ].join("\n");
    expect(extractFlowIds(yaml)).toEqual(["quoted-key-flow", "quoted-key-block", "2024", "true", "inside-mapping-id"]);
  });

  it("YAML として読めない flow は、黙って id を 0 件にせず例外にする (maestro も読めない)。突き合わせでは、どの flow かを添える", () => {
    expect(() => extractFlowIds('- tapOn: { id: "unclosed"')).toThrow();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-flow-testids-"));
    try {
      const flowDir = path.join(root, MAESTRO_DIR, "flows");
      fs.mkdirSync(flowDir, { recursive: true });
      fs.writeFileSync(path.join(flowDir, "broken.yaml"), '- tapOn: { id: "unclosed"');
      expect(() => findMissingFlowIds(root)).toThrow(`${MAESTRO_DIR}/flows/broken.yaml`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    // (以前ここで見ていた flows/menus-weekly/17-servings-modal.yaml は、週の献立のネイティブの画面と一緒に消した。#1598)
    const tabDirect = fs.readFileSync(path.join(REPO_ROOT, fromMaestro("flows/menus-weekly/03-tab-direct-navigation.yaml")), "utf8");
    expect(extractFlowIds(tabDirect)).toContain("tab-menus");
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
        "<View testID={`no-sub-template`} />",
        '<Link testID="https://example.com/not-an-id" />',
        "<Row testID={`${testIDPrefix}-${opt.value}`} />",
        "const label = \"not-a-testid\";",
      ].join("\n"),
      ids,
    );
    for (const id of ["plain-screen", "submit-button", "next-button", "tab-x", "mode-a", "field-weight", "web-only", "no-sub-template"]) {
      expect(isFlowIdInSource(id, ids)).toBe(true);
    }
    expect(isFlowIdInSource("meal-mode-meal", ids)).toBe(true);
    expect(isFlowIdInSource("gender-male", ids)).toBe(true);
    // 接頭辞は、正規表現の id (gender-.*) にも全体一致する
    expect(isFlowIdInSource("gender-.*", ids)).toBe(true);
    // testID の形でない値 (URL・文) は集めない
    expect(isFlowIdInSource("https://example.com/not-an-id", ids)).toBe(false);
    // testID の文脈に無い文字列は testID ではない
    expect(isFlowIdInSource("not-a-testid", ids)).toBe(false);
    // 固定の部分が無いテンプレート (`${testIDPrefix}-${opt.value}`) は、何にでも一致させない
    expect(isFlowIdInSource("anything-at-all", ids)).toBe(false);
    // テンプレートの接頭辞だけ・違う接頭辞は一致しない
    expect(isFlowIdInSource("meal-mode-", ids)).toBe(false);
    expect(isFlowIdInSource("meal-type-meal", ids)).toBe(false);
  });

  it("右辺が式 (const testID = cond ? … ・ testID: cond ? … ・ [ … ]・型注釈のあと・複数行・?? || &&) の文字列を集め、同じ文の外や testID でない名前の文字列は集めない", () => {
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
        'const fallbackTestID = props.testID ?? ("fallback-id" as const);',
        'const orTestID = custom || "or-id";',
        'const andTestID = visible && "and-id";',
        'const nonNullTestID = (flag ? "non-null-a" : "non-null-b")!;',
        'const satisfiesTestID = "satisfies-id" satisfies string;',
        'const mixedTestID = (cond && "mixed-a") || "mixed-b";',
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
      "fallback-id",
      "or-id",
      "and-id",
      "non-null-a",
      "non-null-b",
      "satisfies-id",
      "mixed-a",
      "mixed-b",
    ]) {
      expect(isFlowIdInSource(id, ids), id).toBe(true);
    }
    // 名前が testID でない文の文字列・同じオブジェクトの別のプロパティ・比べる演算子の片側 (条件) は集めない
    for (const id of ["after-statement", "title-text", "next-statement", "cond-value"]) {
      expect(isFlowIdInSource(id, ids), id).toBe(false);
    }
  });

  it("引数・分割代入の既定値、クラスのフィールド、代入 (testID = … ・ x.testID = …)、引用符つきの名前・JSX の a:b の testID も集める", () => {
    const ids = emptyIds();
    addTestIdsFromSource(
      [
        'function Row({ testID = "default-row", label = "default-label" }: Props) {}',
        'function Cell({ testID: id = "renamed-cell" }: Props) {}',
        'const Item = (testID = "param-item") => null;',
        'class Screen { testID = "class-field"; #testID = "private-field"; title = "class-title"; }',
        'let assignedTestID; assignedTestID = "assigned-id";',
        'el.testID = "member-assigned";',
        'el.label = "member-label";',
        'const attrs = { "data-testid": "quoted-name", "aria-label": "quoted-label" };',
        '<View ns:testid="namespaced-attr" />',
        'const snake = { test_id: "snake-case-id" };',
      ].join("\n"),
      ids,
    );
    for (const id of [
      "default-row",
      "renamed-cell",
      "param-item",
      "class-field",
      "private-field",
      "assigned-id",
      "member-assigned",
      "quoted-name",
      "namespaced-attr",
      "snake-case-id",
    ]) {
      expect(isFlowIdInSource(id, ids), id).toBe(true);
    }
    for (const id of ["default-label", "class-title", "member-label", "quoted-label"]) {
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
        'if (props.testID === "compared-testid") {}',
        'const isDefaultTestId = testID === "compared-direct";',
      ].join("\n"),
      ids,
    );
    for (const id of ["sort-newest", "sort-name", "sort-oldest", "ai-bubble", "chip-off", "chip-on"]) {
      expect(isFlowIdInSource(id, ids), id).toBe(true);
    }
    for (const id of ["string", "newest", "oldest", "assistant", "by-name", "compared-testid", "compared-direct"]) {
      expect(isFlowIdInSource(id, ids), id).toBe(false);
    }
  });

  it("コメント (// … と /* … */) の中の testID は集めない。前に正規表現・URL・文字列の中の // や引用符があっても同じ", () => {
    const ids = emptyIds();
    addTestIdsFromSource(
      [
        '// Normalize testID: replace underscores with dashes, drop "select-" prefix',
        '// testID: "line-comment-id"',
        '{/* testID="jsx-comment-id" */}',
        "/**",
        ' * <View testID="doc-comment-id" />',
        " */",
        "// testID: don't (閉じない括弧",
        'const afterApostrophe = "after-apostrophe";',
        // 正規表現の中の " のあとのコメント (以前の読み方は " を文字列の始まりと読み、コメントの中の文字列を testID として集めた)
        's.replace(/"/g, ""); // testID: "after-regex-quote-comment"',
        '<Link href="https://example.com//x" testID="after-url" />',
        '<View onPress={() => s.split(/\\//)} testID="after-regex" />',
        'const quoteRegexTestID = /"/.test(s) ? "after-quote-regex" : "after-quote-regex-else";',
      ].join("\n"),
      ids,
    );
    for (const id of ["after-url", "after-regex", "after-quote-regex", "after-quote-regex-else"]) {
      expect(isFlowIdInSource(id, ids), id).toBe(true);
    }
    for (const id of [
      "select-",
      "line-comment-id",
      "jsx-comment-id",
      "doc-comment-id",
      "after-apostrophe",
      "after-regex-quote-comment",
    ]) {
      expect(isFlowIdInSource(id, ids), id).toBe(false);
    }
  });

  it("JSX の testID={…} の値だけを見る (中に正規表現の ( や [ があっても、後ろの属性の文字列は集めない)", () => {
    const ids = emptyIds();
    addTestIdsFromSource('<View testID={label.replace(/\\(/g, "") ? "paren-a" : "paren-b"} style={{ title: "after-attr" }} />', ids);
    expect(isFlowIdInSource("paren-a", ids)).toBe(true);
    expect(isFlowIdInSource("paren-b", ids)).toBe(true);
    expect(isFlowIdInSource("after-attr", ids)).toBe(false);
  });

  it("テンプレートの ${…} の中に { } があっても、固定の部分 (前後の文字) だけで正規表現を作る", () => {
    // 以前の読み方 (${ から最初の } まで) は `row-${fn({ a: 1 })}` を row- と )} に分け、row-5 に一致しなかった
    const ids = emptyIds();
    addTestIdsFromSource("<View testID={`row-${fn({ a: 1 })}`} />\n<View testID={`cell-${obj[`k${i}`]}-end`} />", ids);
    expect(isFlowIdInSource("row-5", ids)).toBe(true);
    expect(isFlowIdInSource("cell-7-end", ids)).toBe(true);
    expect(isFlowIdInSource("cell-7", ids)).toBe(false);
  });

  it("ファイルの拡張子で読み方を変える (.ts の <T>x は型の指定。.tsx・.jsx・拡張子なしは JSX を読む)", () => {
    const fromTs = emptyIds();
    addTestIdsFromSource('const testID = <const>"ts-assertion";', fromTs, "screen.ts");
    expect(isFlowIdInSource("ts-assertion", fromTs)).toBe(true);
    // .tsx で同じ書き方は JSX の <const> になり、文字列ではない
    const fromTsx = emptyIds();
    addTestIdsFromSource('const testID = <const>"ts-assertion";', fromTsx, "screen.tsx");
    expect(isFlowIdInSource("ts-assertion", fromTsx)).toBe(false);
    for (const fileName of ["legacy.jsx", undefined]) {
      const ids = emptyIds();
      addTestIdsFromSource('<View testID="jsx-attr" />', ids, fileName);
      expect(isFlowIdInSource("jsx-attr", ids), String(fileName)).toBe(true);
    }
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
    // apps/mobile/app/onboarding/questions.tsx のテンプレート `onboarding-choice-option-${…}`
    // (以前ここで見ていた apps/mobile/app/meals/new.tsx の `meal-mode-${…}` は、届かない画面として消した。#1598)
    expect(isFlowIdInSource("onboarding-choice-option-male", ids)).toBe(true);
    expect(isFlowIdInSource("meal-mode-meal", ids)).toBe(false);
    // apps/mobile/app/onboarding/questions.tsx の testID={isLastStep ? "onboarding-submit-button" : "onboarding-next-button"}
    // (JSX の値が三項の式。以前ここで見ていた (tabs)/health.tsx の `const testID = … ? "health-graphs-button" : …` は、
    // 届かない画面として消した。#1598。消した画面の testID はもう見つからない)
    expect(isFlowIdInSource("onboarding-submit-button", ids)).toBe(true);
    expect(isFlowIdInSource("onboarding-next-button", ids)).toBe(true);
    expect(isFlowIdInSource("health-graphs-button", ids)).toBe(false);
    // 比べる演算子の片側 (handson-tour の typeof target === 'string' など) は testID ではない
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
    // 素朴な方法の検出力: 三項の式の中の testID (onboarding/questions.tsx の testID={isLastStep ? "onboarding-submit-button" : …}) を見つける
    // (以前ここで見ていた (tabs)/health.tsx の "health-graphs-button" は、届かない画面として消した。#1598)
    expect(quotedInSource("onboarding-submit-button")).toBe(true);
    expect(quotedInSource("health-graphs-button")).toBe(false);
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
