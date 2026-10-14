/**
 * scripts/lib/local-ci-slot.sh の枠ごとの値を、全部の枠について 1 回の起動で読む (#1496)。
 *
 * tests/local-ci-slot.test.ts と tests/local-ci-slot-consumers.test.ts は、枠の値を確かめるたびに
 * `bash scripts/lib/local-ci-slot.sh <枠>` を Node から起動していた (1 ファイルで数十回)。負荷の高い機械では Node からの
 * 起動 1 回が数百ミリ秒に伸び、ファイルの所要の大きな部分を占めていた。値はスクリプトの中の定数だけで決まり、
 * テストの途中で変わらないので、最初に使うときに全部の枠をまとめて読み、以後はそれを使い回す。
 *
 * 読み方は以前と同じく、スクリプトを実際に実行して得る (文字列を読んで推測しない): 1 つの bash の中で、
 * 枠ごとに `bash scripts/lib/local-ci-slot.sh <枠>` (テストが確かめている入口そのもの) を順に呼び、出力を枠ごとに分ける。
 * 作業ディレクトリ (local_ci_slot_work_dir) も同じく、1 つの bash の中で全部の枠を求める。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 枠の値の表の正本 */
export const SLOT_LIB = "scripts/lib/local-ci-slot.sh";

/** 出力の中で、枠の区切りを示す行の頭 (SLOT_*= の行と取り違えない) */
const SLOT_HEADER = "@@slot ";

/** 枠の番号の上限 (scripts/lib/local-ci-slot.sh の LCS_SLOT_MAX) */
export function slotMaxOf(root: string): number {
  const m = /^readonly LCS_SLOT_MAX=(\d+)$/m.exec(fs.readFileSync(path.join(root, SLOT_LIB), "utf8"));
  if (!m) throw new Error(`${SLOT_LIB} に LCS_SLOT_MAX が無い`);
  return Number(m[1]);
}

const valueTables = new Map<string, ReadonlyMap<number, ReadonlyMap<string, string>>>();
const workDirTables = new Map<string, ReadonlyMap<number, string>>();

/** 枠ごとの出力 (区切りの行で分けたもの) */
function splitBySlot(out: string, max: number): Map<number, string[]> {
  const bySlot = new Map<number, string[]>();
  let current: string[] | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith(SLOT_HEADER)) {
      current = [];
      bySlot.set(Number(line.slice(SLOT_HEADER.length)), current);
      continue;
    }
    current?.push(line);
  }
  if (bySlot.size !== max + 1) throw new Error(`${SLOT_LIB} の出力が 0〜${max} の全部の枠に無い (${bySlot.size} 枠)`);
  return bySlot;
}

/** 全部の枠の SLOT_*=値 (最初に呼んだときに 1 回だけ起動して読む) */
export function slotValueTable(root: string): ReadonlyMap<number, ReadonlyMap<string, string>> {
  const cached = valueTables.get(root);
  if (cached) return cached;
  const max = slotMaxOf(root);
  // 枠ごとに、テストが確かめている入口 (bash scripts/lib/local-ci-slot.sh <枠>) をそのまま呼ぶ。1 つでも失敗したら止める
  const out = execFileSync(
    "bash",
    ["-c", 'for s in $(seq 0 "$1"); do printf "%s%s\\n" "$2" "$s"; bash "$3" "$s" || exit $?; done', "_", String(max), SLOT_HEADER, SLOT_LIB],
    { cwd: root, encoding: "utf8" },
  );
  const table = new Map<number, ReadonlyMap<string, string>>();
  for (const [slot, lines] of splitBySlot(out, max)) {
    const values = new Map<string, string>();
    for (const line of lines) {
      const m = /^(SLOT_[A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) values.set(m[1], m[2]);
    }
    table.set(slot, values);
  }
  valueTables.set(root, table);
  return table;
}

/** 枠 (0〜上限の整数の文字列) の SLOT_*=値。範囲外・整数でない枠は投げる (その確かめは、スクリプトを直接起動するテストが受け持つ) */
export function slotValuesOf(root: string, slot: string): Map<string, string> {
  const table = slotValueTable(root);
  const values = /^\d+$/.test(slot) ? table.get(Number(slot)) : undefined;
  if (!values) throw new Error(`枠 "${slot}" の値は無い (0〜${table.size - 1} の整数で指定する)`);
  return new Map(values);
}

/** 全部の枠の scripts/supabase-local.sh の作業ディレクトリ (local_ci_slot_work_dir。最初に呼んだときに 1 回だけ起動して読む) */
export function slotWorkDirTable(root: string): ReadonlyMap<number, string> {
  const cached = workDirTables.get(root);
  if (cached) return cached;
  const max = slotMaxOf(root);
  const out = execFileSync(
    "bash",
    ["-c", '. "$3"; for s in $(seq 0 "$1"); do printf "%s%s\\n" "$2" "$s"; local_ci_slot_work_dir "$s" || exit $?; done', "_", String(max), SLOT_HEADER, SLOT_LIB],
    { cwd: root, encoding: "utf8" },
  );
  const table = new Map<number, string>();
  for (const [slot, lines] of splitBySlot(out, max)) table.set(slot, lines.join("\n").trim());
  workDirTables.set(root, table);
  return table;
}
