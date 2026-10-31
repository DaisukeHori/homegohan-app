// @vitest-environment node
/**
 * #2093 (docs-1030b) の記録の古さの直しで、同じ設計書の中の記述どうしが食い違わないことの contract テスト (ソース走査)
 *
 * docs-1030b の直し (design-doc.patch) の審査 R1 で、1 か所だけ今に合わせると同じ冊の別の箇所と食い違う形が 3 つ見つかった:
 *  1. operator/02 のプランの画面の段 (1 行): 読み直しの断りを「404 / 403 / 401」にしたのに、同じ行の後ろの
 *     「404 / 403 以外で失敗して」「404 / 403 の場合」「404 / 403 になったとき」が 401 を含まないまま
 *     (401 が「再試行を出さない」側と「止めて再試行を出す」側の両方に読める)
 *  2. billing/02 §8: §8.1 の ManualPlanCurrentViewSchema の source に 'store' を足したのに、§8.6 の
 *     MANUAL_PLAN_SOURCE_LABELS が 'stripe' | 'manual' のまま (§8.0 の手順で置いて型検査すると、
 *     MANUAL_PLAN_SOURCE_LABELS[view.current.source] が TS7053 になる)。§8.2 の source を作る式も 'store' を作らない
 *  3. mobile/05 の auth の呼び出しの閉包の表: W-6 の行に「この行の file:line は origin/main `45552db8` の行番号」と
 *     行全体の宣言を足したのに、同じ行の「無くなった」呼び出し (scope `others`) の file:line は数えた時点 (`7d05ff10`) の番号のまま
 *     (無くなった呼び出しは、無くなったあとの sha には無いので、行全体の宣言のもとでは偽の参照になる)
 *
 * ここでは次を確かめる (どれも直す前の origin/main の設計書でも成り立ち、上の 3 つの食い違いだけを落とす):
 *  A. operator/02 の各行で、「読み直しが <ステータス> / <ステータス> …」の列挙が 2 つ以上あれば、どれも同じ集合
 *  B. billing/02 §8: §8.1 の source の値の集合 = §8.2 の source を作る式が作る値の集合 = §8.6 の
 *     MANUAL_PLAN_SOURCE_LABELS の型のキー = その表のキー。§8.2 の式が読む data.<列> は SUBSCRIPTION_COLUMNS にある
 *  C. mobile/05 の閉包の表で、行に「(…の file:line は origin/main `<sha>` の行番号)」の宣言があるなら、
 *     その行の「無くなった」呼び出しの file:line は `<別の sha>` の を直前に付けて、数えた時点の sha を名指しする
 *
 * 限界: A は同じ行の中の食い違いだけを見る (行をまたぐ食い違いと、実コードのステータスの表との突き合わせは見ない)。
 * C は「無くなった」の直前の file:line だけを見る (残っている呼び出しの番号が宣言の sha で正しいかは見ない — git の履歴を読まない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const OPERATOR_API_SPEC = 'docs/design/operator/02-api-spec.md';
const MANUAL_PLAN_GRANT = 'docs/design/billing/02-manual-plan-grant.md';
const AUTH_SESSION = 'docs/design/mobile/05-auth-session.md';

function readLines(rel: string): string[] {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n');
}

/** 文字列のリテラル ('…') の中身を順に取り出す */
function quotedValues(text: string): string[] {
  return [...text.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

describe('A. operator/02: 同じ行の中の「読み直しが <ステータス> …」の列挙はどれも同じ', () => {
  /** 「読み直しが 404 / 403 / 401」のようなステータスの列挙 (3 桁の数を「 / 」でつないだもの) */
  const REREAD_STATUS_LIST = /読み直しが (\d{3}(?: \/ \d{3})*)/g;

  /** 1 行の中の列挙を、ステータスの集合 (並べ替えた配列) にして返す */
  function rereadStatusSets(line: string): string[][] {
    return [...line.matchAll(REREAD_STATUS_LIST)].map((match) => sorted(match[1].split(' / ')));
  }

  it('判定の見つけ方: 列挙が食い違う行を見つけ、そろった行は通す', () => {
    const mixed = '読み直しが 404 / 403 / 401 なら文を出す。読み直しが 404 / 403 以外で失敗して止める';
    const aligned = '読み直しが 404 / 403 / 401 なら文を出す。読み直しが 404 / 403 / 401 以外で失敗して止める';
    expect(new Set(rereadStatusSets(mixed).map((set) => set.join(','))).size).toBe(2);
    expect(new Set(rereadStatusSets(aligned).map((set) => set.join(','))).size).toBe(1);
  });

  it('走査が空振りしていない (プランの画面の段に、読み直しのステータスの列挙が 2 つ以上ある)', () => {
    const planLine = readLines(OPERATOR_API_SPEC).find((line) => line.includes('`src/app/super-admin/plans/[id]/page.tsx`'));
    expect(planLine, `${OPERATOR_API_SPEC} にプランの画面 (plans/[id]/page.tsx) を名指しする行がある`).toBeDefined();
    expect(rereadStatusSets(planLine ?? '').length).toBeGreaterThanOrEqual(2);
  });

  it('どの行でも、読み直しのステータスの列挙が 2 つ以上あれば同じ集合', () => {
    const mismatched = readLines(OPERATOR_API_SPEC).flatMap((line, index) => {
      const sets = rereadStatusSets(line).map((set) => set.join(' / '));
      return new Set(sets).size > 1 ? [`${OPERATOR_API_SPEC}:${index + 1} (${[...new Set(sets)].join(' と ')})`] : [];
    });
    expect(mismatched).toEqual([]);
  });
});

describe('B. billing/02 §8: source の値は §8.1 の Zod・§8.2 の作る式・§8.6 の表示名の表でそろう', () => {
  const lines = readLines(MANUAL_PLAN_GRANT);

  /** §8.1 の ManualPlanCurrentViewSchema の source: z.enum([...]) の値 */
  function schemaSourceValues(): string[] {
    const start = lines.findIndex((line) => line.startsWith('export const ManualPlanCurrentViewSchema = z.object({'));
    expect(start, `${MANUAL_PLAN_GRANT} に ManualPlanCurrentViewSchema がある`).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, index) => index > start && line.startsWith('});'));
    const sourceLine = lines.slice(start, end).find((line) => /^\s*source: z\.enum\(\[/.test(line));
    expect(sourceLine, 'ManualPlanCurrentViewSchema に source: z.enum([...]) がある').toBeDefined();
    const enumPart = /z\.enum\(\[([^\]]*)\]\)/.exec(sourceLine ?? '')?.[1] ?? '';
    return sorted(quotedValues(enumPart));
  }

  /** §8.2 の source を作る式 (`source: data.stripe_subscription_id === null ? …`。行末のコメントは除く) */
  function repositorySourceExpression(): string {
    const sourceLine = lines.find((line) => /^\s*source: data\.stripe_subscription_id === null \?/.test(line));
    expect(sourceLine, `${MANUAL_PLAN_GRANT} の §8.2 に source を作る式がある`).toBeDefined();
    return (sourceLine ?? '').split('//')[0];
  }

  /** §8.6 の MANUAL_PLAN_SOURCE_LABELS の型のキーと、表のキー */
  function labelKeys(): { typeKeys: string[]; objectKeys: string[] } {
    const labelLine = lines.find((line) => line.startsWith('export const MANUAL_PLAN_SOURCE_LABELS:'));
    expect(labelLine, `${MANUAL_PLAN_GRANT} の §8.6 に MANUAL_PLAN_SOURCE_LABELS がある`).toBeDefined();
    const match = /Readonly<Record<([^,]+), string>> = \{([^}]*)\}/.exec(labelLine ?? '');
    expect(match, 'MANUAL_PLAN_SOURCE_LABELS は 1 行の Readonly<Record<…, string>> = { … }').not.toBeNull();
    return {
      typeKeys: sorted(quotedValues(match?.[1] ?? '')),
      objectKeys: sorted([...(match?.[2] ?? '').matchAll(/(\w+):/g)].map((key) => key[1])),
    };
  }

  it('§8.2 の source を作る式が作る値 = §8.1 の source の値', () => {
    expect(sorted(quotedValues(repositorySourceExpression()))).toEqual(schemaSourceValues());
  });

  it('§8.2 の source を作る式が読む data.<列> は、SUBSCRIPTION_COLUMNS で読む列', () => {
    const columnsLine = lines.find((line) => line.startsWith('const SUBSCRIPTION_COLUMNS = '));
    expect(columnsLine, `${MANUAL_PLAN_GRANT} の §8.2 に SUBSCRIPTION_COLUMNS がある`).toBeDefined();
    const columns = quotedValues(columnsLine ?? '')[0]?.split(',').map((column) => column.trim()) ?? [];
    const read = [...repositorySourceExpression().matchAll(/data\.(\w+)/g)].map((match) => match[1]);
    expect(read.length).toBeGreaterThan(0);
    expect(read.filter((column) => !columns.includes(column))).toEqual([]);
  });

  it('§8.6 の MANUAL_PLAN_SOURCE_LABELS の型のキーと表のキー = §8.1 の source の値', () => {
    const { typeKeys, objectKeys } = labelKeys();
    const values = schemaSourceValues();
    expect(typeKeys).toEqual(values);
    expect(objectKeys).toEqual(values);
  });
});

describe('C. mobile/05 の閉包の表: 行の sha の宣言のもとで、無くなった呼び出しの file:line は数えた時点の sha を名指しする', () => {
  /** 行の中の sha の宣言 「(<範囲>の file:line は origin/main `<sha>` の行番号)」(<範囲> は「この行」「global の 10 行」など) */
  const ROW_SHA_DECLARATION = /\(([^()]*?)の file:line は origin\/main `([0-9a-f]+)` の行番号\)/;
  /** file:line の参照 (`path:123`)。直前に「`<sha>` の 」があればその sha を取る */
  const FILE_LINE_REF = /(?:`([0-9a-f]+)` の )?`[^`\s]+:\d+(?:-\d+)?`/g;
  /** 呼び出しが無くなったことを書く語 */
  const REMOVED = '無くなった';

  /** 閉包の表の行 (`| W-n …` / `| M-n …`) */
  function closureRows(text: string): string[] {
    return text.split('\n').filter((line) => /^\| [WM]-\d+ /.test(line));
  }

  /** 行の sha の宣言があるとき、無くなった呼び出しの直前の file:line が、宣言と別の sha を名指ししていない箇所 */
  function violations(row: string): string[] {
    const declaration = ROW_SHA_DECLARATION.exec(row);
    if (declaration === null) return [];
    const declaredSha = declaration[2];
    const out: string[] = [];
    let from = 0;
    for (let at = row.indexOf(REMOVED, from); at >= 0; at = row.indexOf(REMOVED, from)) {
      const refs = [...row.slice(0, at).matchAll(FILE_LINE_REF)];
      const last = refs[refs.length - 1];
      if (last !== undefined && (last[1] === undefined || last[1] === declaredSha)) out.push(last[0]);
      from = at + REMOVED.length;
    }
    return out;
  }

  it('判定の見つけ方: 行全体の宣言のもとで sha の無い「無くなった」の参照を見つけ、sha を名指ししたものは通す', () => {
    const stale = '| W-6 x | 9 行 (この行の file:line は origin/main `45552db8` の行番号): `a.ts:1`。`b.ts:151` は段 C で無くなった | 10 |';
    const named = '| W-6 x | 9 行 (global の 10 行の file:line は origin/main `45552db8` の行番号): `a.ts:1`。`7d05ff10` の `b.ts:151` は段 C で無くなった | 10 |';
    const undeclared = '| W-6 x | 9 行: `a.ts:1`。`b.ts:151` は段 C で無くなった | 10 |';
    expect(violations(stale)).toEqual(['`b.ts:151`']);
    expect(violations(named)).toEqual([]);
    expect(violations(undeclared)).toEqual([]);
  });

  it('走査が空振りしていない (W-6 の行があり、無くなった呼び出しを書く)', () => {
    const rows = closureRows(fs.readFileSync(path.join(ROOT, AUTH_SESSION), 'utf-8'));
    const w6 = rows.find((row) => row.startsWith('| W-6 '));
    expect(w6, `${AUTH_SESSION} の閉包の表に W-6 の行がある`).toBeDefined();
    expect(w6 ?? '').toContain(REMOVED);
  });

  it('行の sha の宣言がある行で、無くなった呼び出しの file:line は数えた時点の sha を名指しする', () => {
    const rows = closureRows(fs.readFileSync(path.join(ROOT, AUTH_SESSION), 'utf-8'));
    const stale = rows.flatMap((row) => violations(row).map((ref) => `${row.slice(0, row.indexOf(' |', 2))}: ${ref}`));
    expect(stale).toEqual([]);
  });
});
