// @vitest-environment node
/**
 * tests/shell-multibyte-var-expansion.test.ts
 *
 * macOS の /bin/bash 3.2 は、日本語のロケールのもとで `$名前` の直後のマルチバイトの文字の 1 バイト目を変数名の一部として読む
 * (`"$reasons。"` が `reasons\xe3` の展開になり、set -u のもとで unbound variable・exit 127)。scripts/local-ci.sh の
 * gateway_check の赤の文 (`理由: $reasons。ログ: $kong_log。`) がこれで落ち、m1 (macOS) に回った検証で
 * tests/local-ci-gateway-502.test.ts が毎回赤になっていた (Linux の bash 5 では起きない)。
 *
 * ここでは次を固定する:
 *   1. 走査 (tests/helpers/shell-multibyte-var.ts) が、壊れる形を見つけ、壊れない形 (コメント・単一引用符・$'…'・
 *      区切りに引用符のあるヒアドキュメント・`${名前}`・逃がした `\$`・位置パラメータ) を見つけないこと (fixture)
 *   2. 字句の追跡が崩れたら (閉じていない引用符・終わりの無いヒアドキュメント) 黙らずに problems に出すこと
 *   3. workflow の run: の中身の取り出し
 *   4. リポジトリのシェルスクリプト (*.sh・*.bash・シェルの shebang のある拡張子の無いファイル) と workflow の run: に、
 *      該当する箇所が 0 件であること
 *   5. bash 3.2 の機械 (m1 など) では、fixture を実際の /bin/bash 3.2 で動かし、走査の判定と実際の壊れ方が一致すること
 *      (Linux では飛ばす)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyHeavyUnitTestTimeout } from "./helpers/heavy-unit-test-timeout";
import { ASCII_MAX_CODE, extractWorkflowRunBlocks, scanShellMultibyteVars } from "./helpers/shell-multibyte-var";

// bash 3.2 の機械では fixture ごとに bash を起こす (#1605 の同じ型)。テストを定義する前に置く
applyHeavyUnitTestTimeout();

const ROOT = process.cwd();

/** 走査で見つけてほしい形 (bash 3.2 + 日本語のロケールで、x=1 を定義していても unbound variable で落ちる) */
const BAD_CASES: ReadonlyArray<{ title: string; script: string; names: string[] }> = [
  { title: "二重引用符の中", script: 'echo "a $x。"', names: ["x"] },
  { title: "引用符の外", script: "echo a $x。", names: ["x"] },
  { title: "区切りに引用符の無いヒアドキュメントの本文", script: "cat <<EOF\n$x。\nEOF", names: ["x"] },
  { title: "<<- のヒアドキュメント (本文と区切りの行の先頭がタブ)", script: "cat <<-EOF\n\t$x。\n\tEOF", names: ["x"] },
  { title: "二重引用符の中の ' は文字そのもの (引用を始めない)", script: `echo "it's $x。"`, names: ["x"] },
  { title: "二重引用符の中の $( … ) の中", script: 'echo "$(echo "$x。")"', names: ["x"] },
  { title: "バッククォートの中", script: "echo `echo $x。`", names: ["x"] },
  {
    title: "区切りに引用符のあるヒアドキュメントの後は、また見る",
    script: "cat <<'EOF'\n$x。\nEOF\necho \"$x。\"",
    names: ["x"],
  },
  { title: "ヒアドキュメントの本文の ' は文字そのもの", script: "cat <<EOF\nit's $x。\nEOF", names: ["x"] },
  { title: "閉じた単一引用符の後", script: "echo 'a' \"$x。\"", names: ["x"] },
  { title: "語の途中の # はコメントではない", script: "echo a#$x。", names: ["x"] },
  { title: "「。」以外のマルチバイトの文字 (」と全角の空白)", script: 'echo "$x」" "$x　"', names: ["x", "x"] },
  { title: "算術の << はヒアドキュメントではない", script: 'echo $((1<<2)) "$x。"', names: ["x"] },
  { title: "ヒアストリング", script: 'cat <<< "$x。"', names: ["x"] },
  { title: "ヒアドキュメントの演算子のある行の残りも見る", script: 'cat <<EOF; echo "$x。"\nbody\nEOF', names: ["x"] },
  {
    title: "直す前の scripts/local-ci.sh の gateway_check の赤の文 (2 か所)",
    script: 'reasons=a; kong_log=b; echo "Kong の 502: 1 件 (理由: $reasons。ログ: $kong_log。#1779)"',
    names: ["reasons", "kong_log"],
  },
];

/** 走査で見つけてはいけない形 (bash 3.2 + 日本語のロケールでも落ちない) */
const GOOD_CASES: ReadonlyArray<{ title: string; script: string }> = [
  { title: "${名前}", script: 'echo "${x}。"' },
  { title: "引用符を閉じた後", script: 'echo "$x"。' },
  { title: "単一引用符の中", script: "echo '$x。'" },
  { title: "$'…' の中", script: "echo $'$x。'" },
  { title: "コメントの行", script: '# echo "$x。"\necho ok' },
  { title: "行の後ろのコメント", script: "echo ok # $x。" },
  { title: "区切りを単一引用符で囲んだヒアドキュメント", script: "cat <<'EOF'\n$x。\nEOF" },
  { title: "区切りを二重引用符で囲んだヒアドキュメント", script: 'cat <<"EOF"\n$x。\nEOF' },
  { title: "区切りをバックスラッシュで逃がしたヒアドキュメント", script: "cat <<\\EOF\n$x。\nEOF" },
  { title: "逃がした \\$", script: 'echo "\\$x。"' },
  { title: "位置パラメータ・特殊パラメータ", script: 'set -- 1; echo "$1。$#。$?。"' },
  { title: "直後が ASCII", script: 'echo "$x." "$x 。"' },
];

/** 字句の追跡が崩れる形 (problems に出す) */
const BROKEN_CASES: ReadonlyArray<{ title: string; script: string; problem: RegExp }> = [
  { title: "閉じていない単一引用符", script: "echo 'abc\necho \"$x。\"", problem: /単一引用符が閉じていない/ },
  { title: "終わりの行の無いヒアドキュメント", script: "cat <<EOF\nabc\n", problem: /ヒアドキュメント \(区切り EOF\) の終わりの行が見つからない/ },
  { title: "閉じていない二重引用符", script: 'echo "abc', problem: /dq が閉じていない/ },
  { title: "閉じていない $'…'", script: "echo $'abc", problem: /\$'…' が閉じていない/ },
];

describe("走査: 壊れる形を見つける", () => {
  it.each(BAD_CASES)("$title", ({ script, names }) => {
    const { findings, problems } = scanShellMultibyteVars(script);
    expect(problems).toEqual([]);
    expect(findings.map((f) => f.name)).toEqual(names);
    for (const f of findings) expect(f.next.charCodeAt(0)).toBeGreaterThan(ASCII_MAX_CODE);
  });

  it("行番号・変数名・直後の文字・行の中身を返す", () => {
    const script = ['#!/usr/bin/env bash', "set -u", "echo ok", '  log "終了コード $status。$attempt 回"'].join("\n");
    expect(scanShellMultibyteVars(script)).toEqual({
      findings: [{ line: 4, name: "status", next: "。", text: 'log "終了コード $status。$attempt 回"' }],
      problems: [],
    });
  });

  it("ヒアドキュメントの本文の行番号を数え違えない", () => {
    const script = ["cat <<EOF", "a", "b $x。", "EOF", 'echo "$y。"'].join("\n");
    expect(scanShellMultibyteVars(script).findings.map((f) => [f.line, f.name])).toEqual([
      [3, "x"],
      [5, "y"],
    ]);
  });
});

describe("走査: 壊れない形を見つけない", () => {
  it.each(GOOD_CASES)("$title", ({ script }) => {
    expect(scanShellMultibyteVars(script)).toEqual({ findings: [], problems: [] });
  });
});

describe("走査: 字句の追跡が崩れたら黙らない", () => {
  it.each(BROKEN_CASES)("$title", ({ script, problem }) => {
    const { problems } = scanShellMultibyteVars(script);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(problem);
  });
});

describe("workflow の run: の取り出し", () => {
  const yaml = [
    "jobs:",
    "  a:",
    "    steps:",
    "      - name: block",
    "        run: |",
    "          echo ok",
    '          echo "$x。"',
    "",
    "          echo tail",
    "        shell: bash",
    "      - run: |-",
    '          echo "$y。"',
    "      - name: one line",
    "        run: echo $z。",
    "      - name: yaml single quoted",
    "        run: 'echo $w。 it''s'",
    "      - name: not run",
    "        env:",
    "          MSG: $v。",
  ].join("\n");

  it("ブロックは run の字より深い行と空行だけを取り、兄弟のキーで止まる", () => {
    const blocks = extractWorkflowRunBlocks(yaml);
    expect(blocks.map((b) => [b.line, b.scriptLine])).toEqual([
      [5, 6],
      [11, 12],
      [14, 14],
      [16, 16],
    ]);
    expect(blocks[0].script).toBe(['          echo ok', '          echo "$x。"', "", "          echo tail"].join("\n"));
    expect(blocks[0].script).not.toContain("shell:");
    expect(blocks[1].script).toBe('          echo "$y。"');
    expect(blocks[2].script).toBe("echo $z。");
    expect(blocks[3].script).toBe("echo $w。 it's");
  });

  it("取り出した中身を走査すると、run: の中だけを見つける (env の値は見ない)", () => {
    const names = extractWorkflowRunBlocks(yaml).flatMap((b) => scanShellMultibyteVars(b.script).findings.map((f) => f.name));
    expect(names).toEqual(["x", "y", "z", "w"]);
  });
});

/** 走査しない置き場 (依存・生成物・ほかの作業コピー) */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".expo",
  ".turbo",
  ".vercel",
  ".claude",
  "Pods",
  "coverage",
  "test-results",
  "playwright-report",
]);
const SHELL_EXT = /\.(?:sh|bash)$/;
const WORKFLOW_EXT = /\.ya?ml$/;
/** 拡張子の無いファイルの shebang (sh・bash・zsh・dash・ksh) */
const SHELL_SHEBANG = /^#![^\n]*\b(?:ba|z|da|k)?sh\b/;
/** shebang を調べるのに読む先頭の文字数 (shebang の行は 1 行で、これより長いものはこのリポジトリに無い) */
const SHEBANG_PROBE_CHARS = 200;

function walk(dir: string, out: { shell: string[]; workflows: string[] }): void {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === "" ? e.name : path.posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(rel, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (SHELL_EXT.test(e.name)) out.shell.push(rel);
    else if (rel.startsWith(".github/") && WORKFLOW_EXT.test(e.name)) out.workflows.push(rel);
    else if (!e.name.includes(".") && SHELL_SHEBANG.test(fs.readFileSync(path.join(ROOT, rel), "utf8").slice(0, SHEBANG_PROBE_CHARS))) {
      out.shell.push(rel);
    }
  }
}

describe("リポジトリのシェルスクリプトと workflow の run:", () => {
  const files = { shell: [] as string[], workflows: [] as string[] };
  walk("", files);
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  it("走査の対象に、既知のスクリプトと workflow が入っている (空振りしない)", () => {
    expect(files.shell).toEqual(
      expect.arrayContaining([
        "scripts/local-ci.sh",
        "scripts/supabase-local.sh",
        "scripts/lib/local-ci-gateway-502.sh",
        "apps/mobile/maestro/scripts/reset-test-users.sh",
        "SETUP_ENV.sh",
      ]),
    );
    expect(files.workflows).toEqual(expect.arrayContaining([".github/workflows/ci.yml"]));
    const runCount = files.workflows.reduce((n, rel) => n + extractWorkflowRunBlocks(read(rel)).length, 0);
    expect(runCount).toBeGreaterThan(0);
  });

  it("シェルスクリプトに $名前 + マルチバイトの文字が無く、どれも最後まで読める", () => {
    const report = files.shell.flatMap((rel) => {
      const { findings, problems } = scanShellMultibyteVars(read(rel));
      return [
        ...findings.map((f) => `${rel}:${f.line}: $${f.name} の直後が「${f.next}」 → \${${f.name}}${f.next} にする: ${f.text}`),
        ...problems.map((p) => `${rel}: 読めなかった: ${p}`),
      ];
    });
    expect(report).toEqual([]);
  });

  it("workflow の run: に $名前 + マルチバイトの文字が無く、どれも最後まで読める", () => {
    const report = files.workflows.flatMap((rel) =>
      extractWorkflowRunBlocks(read(rel)).flatMap((b) => {
        const { findings, problems } = scanShellMultibyteVars(b.script);
        return [
          ...findings.map((f) => `${rel}:${b.scriptLine + f.line - 1}: $${f.name} の直後が「${f.next}」 → \${${f.name}}${f.next} にする: ${f.text}`),
          ...problems.map((p) => `${rel}:${b.line} の run: 読めなかった: ${p}`),
        ];
      }),
    );
    expect(report).toEqual([]);
  });
});

/** macOS の /bin/bash の版の印 (これが 3.2 のときだけ、実際の壊れ方と突き合わせる) */
const BASH32_PATH = "/bin/bash";
const BASH32_VERSION = /^GNU bash, version 3\.2\./;
/** 壊れ方が出る日本語のロケール */
const JA_LOCALE = "ja_JP.UTF-8";

function bash32Available(): boolean {
  if (process.platform !== "darwin" || !fs.existsSync(BASH32_PATH)) return false;
  const r = spawnSync(BASH32_PATH, ["--version"], { encoding: "utf8" });
  return r.status === 0 && BASH32_VERSION.test(r.stdout);
}

function runBash32(script: string) {
  return spawnSync(BASH32_PATH, ["-u", "-c", `x=1\n${script}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: JA_LOCALE, LC_ALL: JA_LOCALE },
  });
}

describe.runIf(bash32Available())("bash 3.2 の実際の壊れ方と突き合わせる (macOS)", () => {
  it.each(BAD_CASES)("壊れる: $title", ({ script }) => {
    const r = runBash32(script);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unbound variable");
  });

  it.each(GOOD_CASES)("壊れない: $title", ({ script }) => {
    const r = runBash32(script);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
