/**
 * シェルスクリプトの `$名前` の直後にマルチバイトの文字 (ASCII 以外) が来る箇所を、静的に探す。
 *
 * 背景: macOS の /bin/bash 3.2.57 は、日本語のロケール (LANG=ja_JP.UTF-8 など) のもとで、`$名前` の直後の
 * マルチバイトの文字の 1 バイト目を変数名の一部として読む。`"$reasons。"` は `reasons` + 「。」ではなく、
 * `reasons\xe3` という別の変数の展開になる。set -u のもとでは unbound variable で exit 127 になり、
 * set -u が無ければ黙って空文字になる。Linux の bash 5 では起きないので、m1 (macOS) に回ったときだけ赤になる。
 * 直し方は `${名前}。` (波括弧で名前の終わりを示す)。
 *
 * 2026-10-23 に M2 の /bin/bash 3.2.57 で、次の形が壊れ、次の形は壊れないことを確かめた:
 *   - 壊れる: 二重引用符の中 / 引用符の外 / 区切りに引用符の無いヒアドキュメント (<<EOF) の本文
 *   - 壊れない: 単一引用符の中 / 区切りに引用符のあるヒアドキュメント (<<'EOF') の本文 / `${x}。` / `"$x"。` /
 *     位置パラメータ (`$1。`) と特殊パラメータ (`$#。` `$?。`)
 *
 * 走査は、展開が起きない場所 (コメント・単一引用符・$'…'・区切りに引用符のあるヒアドキュメント・バックスラッシュで
 * 逃がした `\$`) だけを除き、それ以外の `$名前` をすべて見る。二重引用符・`$( … )`・バッククォートの入れ子は
 * 文脈の積み上げで追う (二重引用符の中の `'` は文字そのもの・`$( … )` の中では引用符が効き直す)。
 * 字句の追跡が崩れたとき (閉じていない単一引用符・終わりの行の無いヒアドキュメント) は「読めなかった」として
 * problems に返す。黙って読み飛ばすと見張りが空振りするため。
 */

/** 見つけた箇所 */
export type MultibyteVarFinding = {
  /** 1 始まりの行番号 */
  line: number;
  /** 変数名 (`$` を除く) */
  name: string;
  /** 直後の文字 */
  next: string;
  /** その行 (前後の空白を除く) */
  text: string;
};

/** 走査の結果 */
export type MultibyteVarScan = {
  findings: MultibyteVarFinding[];
  /** 字句の追跡が崩れた箇所 (閉じていない引用符・終わりの無いヒアドキュメント) */
  problems: string[];
};

/** ASCII の最後の文字の符号 (これより大きい符号はマルチバイトの文字の一部) */
export const ASCII_MAX_CODE = 0x7f;
/** bash の変数名の 1 文字目 / 2 文字目以降 */
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
/** この文字の直後の `#` はコメントの始まり (語の先頭) */
const COMMENT_PRECEDERS = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")"]);
/** ヒアドキュメントの演算子と区切り (`<<-` は本文と区切りの行の先頭のタブを除く。区切りは英字か _ で始まるものだけ見る: `$((1<<2))` を拾わない) */
const HEREDOC_OP = /^<<(-?)[ \t]*(?:'([A-Za-z_][\w-]*)'|"([A-Za-z_][\w-]*)"|\\?([A-Za-z_][\w-]*))/;

type Context = "top" | "dq" | "cmd" | "bq";

type PendingHeredoc = { delimiter: string; stripTabs: boolean; expands: boolean; line: number };

const isNonAscii = (ch: string | undefined): boolean => ch !== undefined && ch.charCodeAt(0) > ASCII_MAX_CODE;

/** `src[i]` が `$` のとき、そこから始まる `$名前` + マルチバイトの文字を調べ、見つけたら返す */
function multibyteAfterName(src: string, i: number): { name: string; next: string } | null {
  if (!NAME_START.test(src[i + 1] ?? "")) return null;
  let j = i + 1;
  while (j < src.length && NAME_CHAR.test(src[j])) j += 1;
  const next = src[j];
  return isNonAscii(next) ? { name: src.slice(i + 1, j), next } : null;
}

/**
 * シェルスクリプトの本文を走査する。
 * @param src スクリプトの本文 (UTF-8 を読んだ文字列)
 */
export function scanShellMultibyteVars(src: string): MultibyteVarScan {
  const findings: MultibyteVarFinding[] = [];
  const problems: string[] = [];
  const lines = src.split("\n");
  // 文字の位置 → 行番号 (1 始まり)
  const lineStarts: number[] = [];
  {
    let pos = 0;
    for (const l of lines) {
      lineStarts.push(pos);
      pos += l.length + 1;
    }
  }
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const record = (index: number, hit: { name: string; next: string }) => {
    const line = lineOf(index);
    findings.push({ line, name: hit.name, next: hit.next, text: lines[line - 1].trim() });
  };

  const stack: Context[] = ["top"];
  /** cmd の文脈ごとの括弧の深さ */
  const parenDepth: number[] = [];
  let pending: PendingHeredoc[] = [];
  let i = 0;

  /** 改行 (位置 nl) の直後から、たまっているヒアドキュメントの本文を読む。読み終えた位置 (次に読む文字) を返す */
  const consumeHeredocs = (nl: number): number => {
    let pos = nl + 1;
    for (const h of pending) {
      let closed = false;
      while (pos <= src.length) {
        const end = src.indexOf("\n", pos);
        const lineEnd = end === -1 ? src.length : end;
        const raw = src.slice(pos, lineEnd);
        const body = h.stripTabs ? raw.replace(/^\t+/, "") : raw;
        if (body === h.delimiter) {
          pos = lineEnd + 1;
          closed = true;
          break;
        }
        if (h.expands) {
          for (let k = 0; k < raw.length; k += 1) {
            if (raw[k] === "\\") {
              k += 1;
              continue;
            }
            if (raw[k] === "$") {
              const hit = multibyteAfterName(raw, k);
              if (hit) record(pos + k, hit);
            }
          }
        }
        if (end === -1) {
          pos = src.length + 1;
          break;
        }
        pos = lineEnd + 1;
      }
      if (!closed) problems.push(`${h.line} 行目のヒアドキュメント (区切り ${h.delimiter}) の終わりの行が見つからない`);
    }
    pending = [];
    return pos;
  };

  while (i < src.length) {
    const ctx = stack[stack.length - 1];
    const ch = src[i];

    if (ch === "\\") {
      // 逃がした 1 文字 (\$ は展開しない)。行末の \ は行の継続
      i += 2;
      continue;
    }

    if (ch === "\n" && pending.length > 0 && ctx !== "dq") {
      i = consumeHeredocs(i);
      continue;
    }

    if (ch === "$") {
      const hit = multibyteAfterName(src, i);
      if (hit) record(i, hit);
      if (src[i + 1] === "(") {
        stack.push("cmd");
        parenDepth.push(0);
        i += 2;
        continue;
      }
      if (src[i + 1] === "'" && ctx !== "dq") {
        // $'…' (ANSI-C の引用。中で変数は展開しない。\' で引用符を逃がせる)
        let j = i + 2;
        while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
        if (j >= src.length) problems.push(`${lineOf(i)} 行目の $'…' が閉じていない`);
        i = j + 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (ctx === "dq") {
      if (ch === '"') stack.pop();
      else if (ch === "`") stack.push("bq");
      i += 1;
      continue;
    }

    // top / cmd / bq: 引用符・コメント・ヒアドキュメントが効く
    if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) {
        problems.push(`${lineOf(i)} 行目の単一引用符が閉じていない`);
        break;
      }
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      stack.push("dq");
      i += 1;
      continue;
    }
    if (ch === "`") {
      if (ctx === "bq") stack.pop();
      else stack.push("bq");
      i += 1;
      continue;
    }
    if (ch === "#" && (i === 0 || COMMENT_PRECEDERS.has(src[i - 1]))) {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (ch === "<" && src.startsWith("<<<", i)) {
      // ヒアストリング (ヒアドキュメントではない。続く語は普通に読む)
      i += 3;
      continue;
    }
    if (ch === "<" && src[i + 1] === "<") {
      const m = HEREDOC_OP.exec(src.slice(i));
      if (m) {
        const quoted = m[2] !== undefined || m[3] !== undefined || m[0].includes("\\");
        pending.push({
          delimiter: m[2] ?? m[3] ?? m[4],
          stripTabs: m[1] === "-",
          expands: !quoted,
          line: lineOf(i),
        });
        i += m[0].length;
        continue;
      }
      i += 2;
      continue;
    }
    if (ctx === "cmd") {
      if (ch === "(") parenDepth[parenDepth.length - 1] += 1;
      else if (ch === ")") {
        if (parenDepth[parenDepth.length - 1] === 0) {
          stack.pop();
          parenDepth.pop();
        } else parenDepth[parenDepth.length - 1] -= 1;
      }
    }
    i += 1;
  }

  if (pending.length > 0) consumeHeredocs(src.length);
  if (stack.length > 1) problems.push(`ファイルの終わりで ${stack.slice(1).join(" > ")} が閉じていない`);
  return { findings, problems };
}

/** GitHub Actions の workflow から取り出した run: の中身 */
export type WorkflowRunBlock = {
  /** run: の行の 1 始まりの行番号 */
  line: number;
  /** 本文の 1 行目の、YAML の中での 1 始まりの行番号 (ブロックは run: の次の行・1 行の値は run: の行) */
  scriptLine: number;
  /** シェルの本文 */
  script: string;
};

/** `run:` の行 (`- run:` を含む)。1 = 字下げと `- `、2 = 値 */
const RUN_KEY = /^([ \t]*(?:-[ \t]+)?)run:[ \t]*(.*)$/;
/** ブロックの記法 (| や > と、その修飾子) */
const BLOCK_SCALAR = /^[|>][+-]?[0-9]?[ \t]*(?:#.*)?$/;
const indentOf = (l: string): number => /^[ \t]*/.exec(l)?.[0].length ?? 0;

/**
 * workflow の YAML から run: の中身を取り出す (YAML を完全には解かない。このリポジトリの書き方 (`run: |` のブロックと
 * 1 行の run:) を読む)。ブロックの本文は、run の字の位置より深く字下げされた行 (と空行) が続く範囲で、
 * 最初の空でない行の字下げを全行から外す (YAML のブロックの記法と同じ)。
 * 1 行の値が引用符で囲まれていれば、YAML の引用を外す ('' → ')。
 */
export function extractWorkflowRunBlocks(yamlText: string): WorkflowRunBlock[] {
  const lines = yamlText.split("\n");
  const blocks: WorkflowRunBlock[] = [];
  for (let n = 0; n < lines.length; n += 1) {
    const m = RUN_KEY.exec(lines[n]);
    if (!m) continue;
    const keyColumn = m[1].length;
    const value = m[2].trimEnd();
    if (BLOCK_SCALAR.test(value)) {
      const body: string[] = [];
      let k = n + 1;
      while (k < lines.length && (lines[k].trim() === "" || indentOf(lines[k]) > keyColumn)) {
        body.push(lines[k]);
        k += 1;
      }
      // YAML と同じく、本文の最初の空でない行の字下げを全行から外す (外さないと、字下げされたヒアドキュメントの区切りの行を区切りと読めない)
      const firstText = body.find((l) => l.trim() !== "");
      const strip = firstText === undefined ? 0 : indentOf(firstText);
      blocks.push({ line: n + 1, scriptLine: n + 2, script: body.map((l) => l.slice(Math.min(strip, indentOf(l)))).join("\n") });
      n = k - 1;
      continue;
    }
    let script = value;
    if (script.length >= 2 && script.startsWith("'") && script.endsWith("'")) script = script.slice(1, -1).replace(/''/g, "'");
    else if (script.length >= 2 && script.startsWith('"') && script.endsWith('"')) script = script.slice(1, -1).replace(/\\"/g, '"');
    blocks.push({ line: n + 1, scriptLine: n + 1, script });
  }
  return blocks;
}
