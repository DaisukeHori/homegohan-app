// @vitest-environment node
/**
 * 設計書の文の置き場 (節) と、節を名指す参照が、指す先の中身と食い違わないことの contract テスト (ソース走査)
 *
 * #2050 (docs-1026c) の R1 の指摘から:
 * (1) cross/02 §8 に献立のドメインの節を足した PATCH が、§8.3 Operator ドメインの表と
 *     「運営ロールの MFA (cross/12 §11.4。段 E)…」の段落のあいだに節を差し込み、段落が新しい節の下へ移った。
 *     cross/12 の追随表はこの段落の置き場を「cross/02 §8.3 Operator ドメイン」と記録しているので、
 *     段落のすぐ上の見出しが、cross/12 の追随表が名指す節であることを確かめる。
 * (2) cross/23 §13 (定数一覧) に足した行の根拠の欄が「§11 の表」を指していたが、§11 はシーケンス図の節で、
 *     その定数の行も表も無かった。§13 の根拠の欄が `§X の…表` と書いて指す節は、その定数の名前を表の行に持つこと、
 *     根拠の欄が指す `§X` はどれも cross/23 に見出しとしてあることを確かめる。
 * (3) cross/23 §0.3 に足したシナリオ S-27 (#2041 の写真の解析の CAS) の期待の欄が、Issue #2050 が P7 で製品の欠陥とした順
 *     (先に送った A の印が後の B の invokedAt のあとに付き、A の結果が残る) を期待として書き、その順を
 *     別の it (PC-4 = invokedAt のあとにほかの書き手が書いた行) の形と呼んでいた。§0.3 の宣言の本数と S-n の行・
 *     §4.3 のトレース・§12.3 の対応表の S-n がそろうこと、§12.3 がテストのファイルの後の括弧で名指す it の id が
 *     そのファイルに実在することを確かめる。
 * (4) R3 の指摘: S-27 の期待とトレースが、B の invokedAt から B の印までのあいだに行が書かれない前提を置いたまま、
 *     route の時計を invokedAt として送っていたとき (#2056 の前) にはその前提を満たさない順 (A の書き込みがそのあいだに
 *     入る順) まで、B の結果が残ると書いていた。トレースが、コードが実際に
 *     通る順序の守りの手順 (_shared/meal-photo-cas.ts の関数のうち route・Edge が呼ぶもの) を飛ばすと、前提が抜けても
 *     気づけない (#2056 で要求の印が足されたあとも、トレースは Edge の印からしか書いていなかった)。#2041 のシナリオの
 *     §4.3 のトレースの行が、route・Edge が呼ぶ手順の関数の名前をどれも書くことを確かめる。
 * (5) R4 の指摘:
 *     (a) S-27 の期待とトレースが、送った順ごとの振る舞いを散文の場合分けで書き、`_shared/meal-photo-cas.ts` の注釈と
 *         request-order のテストの it に続く 3 つ目の写しになっていた (R1〜R3 で毎周ずれた。確かめた順を超える全称の文もあった)。
 *         順ごとの振る舞いの正本は tests/analyze-meal-photo-cas-request-order.test.ts の RO-n の it とし、正典は id を名指すだけにした。
 *         #2041 のシナリオの §0.3 の期待・§4.3 のトレースが名指す it の id は §12.3 の同じ S-n の行にあること (正典 → テスト)、
 *         request-order のテストの RO-n の it はどれも §12.3 のどこかの行に名指されていること (テスト → 正典) を確かめる。
 *         順を足す・消すコードの変更は it の増減を伴うので、正典の id を同じ PR で直さないと赤になる。
 *     (b) operator/11 の「解散済みの家族を運営が強制解散すると 409」の行と family/11 の S-19 の注が、その行の正を
 *         family/11 §8 (全パターン表) と書いていたが、§8 にその行は無く、§10.1 (③状態遷移表) にある。
 *         2 つの参照が指す family/11 の節が、運営の強制解散で `FAMILY_ALREADY_DISSOLVED` になる行を持つことを確かめる。
 *     (c) cross/13a の招待の API の行が組織の招待の画面を `page.tsx:37, 72, 104` と書いていたが、#2054 のあとその行は
 *         fetch の行でなくなっていた。行番号でなく関数の名前で指し、名指した関数がその画面のファイルに定義されていることを確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

const CROSS02 = 'docs/design/cross/02-rls-patterns.md';
const CROSS12 = 'docs/design/cross/12-operator-mfa.md';
const CROSS13A = 'docs/design/cross/13a-legal-consent-api-server.md';
const CROSS23 = 'docs/design/cross/23-planned-meals-score-integrity.md';
const FAMILY11 = 'docs/design/family/11-self-dissolve.md';
const OPERATOR11 = 'docs/design/operator/11-ops-batches-non-billing.md';

/** cross/02 の運営ロールの MFA の段落の書き出し (cross/12 の追随表が置き場を記録している文) */
const OPERATOR_MFA_PARAGRAPH_START = '運営ロールの MFA (cross/12 §11.4。段 E)';
/** cross/12 の追随表の、cross/02 の行の先頭のセル */
const CROSS12_FOLLOWUP_CROSS02_CELL = '| `docs/design/cross/02-rls-patterns.md` |';
/** cross/12 の追随表の、運営ロールの MFA の段落の行を見分ける語 (逐語の一部) */
const CROSS12_FOLLOWUP_MFA_QUOTE = '「運営ロール (`user_profiles.roles` の super_admin';
/** 追随表のセルの「§8.3 Operator ドメイン」の形 (番号と見出しの名前) */
const DOMAIN_SECTION_REFERENCE = /§(\d+\.\d+) (\S+ ドメイン)/;

/** cross/23 の定数一覧の節と、その次の節の見出しの書き出し */
const CROSS23_CONSTANTS_HEADING = '## 13. ';
const CROSS23_AFTER_CONSTANTS_HEADING = '## 14. ';
/** 見出し `## 9. 表 3 点`・`### 9.3 ③状態遷移表` の番号 */
const NUMBERED_HEADING = /^(#{2,4}) (\d+(?:\.\d+)*)\.? /gm;
/** 根拠の欄の `§9.3 の状態遷移表`・`§10 のエラー表`・`§3.1 の表` (節の中の表を指す参照) */
const SECTION_TABLE_REFERENCE = /§(\d+(?:\.\d+)*) の[^§、・。()|]*?表/g;
const SECTION_REFERENCE = /§(\d+(?:\.\d+)*)/g;
/** 表の区切りの行 (`|---|---|`) */
const TABLE_SEPARATOR_ROW = /^\|(?:\s*:?-+:?\s*\|)+\s*$/;

/** cross/23 §0.3 の見出しの宣言の本数 (`### 0.3 ユーザーシナリオ (27 本。…)`) */
const SCENARIO_COUNT_DECLARATION = /^#{2,4} 0\.3 ユーザーシナリオ \((\d+) 本/m;
/** 表の先頭のセルがシナリオの番号 (`| S-27 |`) の行 */
const SCENARIO_ROW = /^\| (S-\d+) \|/gm;
const SCENARIO_ROW_PREFIX = '| S-';
/** シナリオの番号 (`S-27`。it の id と同じ形なので、it の id から外す) */
const SCENARIO_ID = /^S-\d+$/;
/** シナリオを持つ節の番号: §0.3 = シナリオ・§4.3 = トレース・§12.3 = シナリオ ⇄ テスト */
const SCENARIO_SECTION = '0.3';
const TRACE_SECTION = '4.3';
const SCENARIO_TEST_SECTION = '12.3';
/** §12.3 の行の、テストのファイルのすぐ後の括弧 (`` `tests/x.test.ts` (PC-1・PC-2 …) ``) */
const TEST_FILE_WITH_IDS = /`((?:tests|src|apps)\/[^`]+\.test\.tsx?)` \(([^)]*)\)/g;
/** 括弧の中の it の id (`PC-1`・`P-3`・`I-15`) */
const TEST_ID = /\b([A-Z]{1,3}-\d+)\b/g;
/** テストのファイルの it / describe の名前の書き出しの id (`it('RO-1: …'`・`describe('RO-5: …'`) */
const TEST_NAME_ID = /['"`]([A-Z]{1,3}-\d+): /g;
/** §0.3 のシナリオの表の、期待の欄の位置 (シナリオの番号・シナリオ・期待) */
const SCENARIO_EXPECTATION_CELL = 2;
/** #2041 の写真の解析の CAS のシナリオの行を見分ける語 */
const PHOTO_CAS_SCENARIO_MARK = '#2041';
/** 送った順ごとの振る舞いの正本のテスト (route と Edge を本物で通す。RO-n の it) */
const PHOTO_CAS_REQUEST_ORDER_TEST = 'tests/analyze-meal-photo-cas-request-order.test.ts';
/** 写真の解析の書き込みの順序の守り (#121 の CAS・#2050 の要求の印) の関数を置くファイル */
const PHOTO_CAS_MODULE = 'supabase/functions/_shared/meal-photo-cas.ts';
/** 順序の守りの関数を呼ぶ側 (Next.js の route = 要求の印・Edge のハンドラ = invokedAt の読み取り・解析の印・書く前の確認) */
const PHOTO_CAS_CALLERS: readonly string[] = [
  'src/app/api/ai/analyze-meal-photo/route.ts',
  'supabase/functions/analyze-meal-photo/index.ts',
];
/** export した関数の名前 (`export function x(`・`export async function x(`) */
const EXPORTED_FUNCTION = /^export (?:async )?function (\w+)\s*\(/gm;
/** ブロックの注釈と行の注釈 (`https://` の `//` は残す) */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:])\/\/.*$/gm;

/** operator/11 の解散した家族の状態遷移表の、解散済みの家族を運営が強制解散する行の書き出し */
const OPERATOR11_DISSOLVED_FORCE_ROW = '| `dissolved` | `operator_force_dissolve_family`';
/** その行が 409 の行の正を指す形 (`正は family/11 §10.1`) */
const OPERATOR11_CANON_REFERENCE = /正は family\/11 §(\d+(?:\.\d+)*)/;
/** family/11 の S-19 の行 (の注) が 409 の行の節を指す形 (`§10.1・Q-5`) */
const FAMILY11_S19_ROW_PREFIX = '| S-19 |';
const FAMILY11_S19_NOTE_REFERENCE = /§(\d+(?:\.\d+)*)・Q-5/;
/** family/11 の、解散済みの家族を運営が強制解散すると 409 で止まる行を見分ける語 (操作の欄とエラー) */
const FORCE_DISSOLVE_OPERATION = '運営が強制解散';
const FAMILY_ALREADY_DISSOLVED = 'FAMILY_ALREADY_DISSOLVED';

/** cross/13a の招待の API の行が名指す、組織の招待の画面 */
const ORG_INVITES_PAGE = 'src/app/(org)/org/invites/page.tsx';
/** 関数の定義 (`const x = useCallback(…`・`const x = async (…`・`function x(`) */
const functionDefinition = (name: string): RegExp => new RegExp(`(?:const ${name}\\s*=|function ${name}\\s*\\()`);

/** needle で始まる行のすぐ上の見出しの行 (見出しが無ければ null) */
function headingAbove(markdown: string, needle: string): string | null {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => line.startsWith(needle));
  if (index < 0) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (/^#{1,6} /.test(lines[i] ?? '')) return lines[i] ?? null;
  }
  return null;
}

/** 番号つきの見出しの節の本文 (見出しの行から、同じ深さか浅い次の見出しの手前まで。無ければ null) */
function sectionBody(markdown: string, sectionNumber: string): string | null {
  const headings = [...markdown.matchAll(NUMBERED_HEADING)].map((m) => ({
    start: m.index ?? 0,
    depth: (m[1] ?? '').length,
    number: m[2] ?? '',
  }));
  const at = headings.findIndex((h) => h.number === sectionNumber);
  if (at < 0) return null;
  const own = headings[at];
  if (!own) return null;
  const next = headings.slice(at + 1).find((h) => h.depth <= own.depth);
  return markdown.slice(own.start, next ? next.start : markdown.length);
}

/** 表の行をセルに分ける (バッククォートの中の | では分けない。先頭と末尾の | の外は数えない) */
function tableCells(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (const ch of row.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

type ConstantsRow = { names: string[]; basis: string };

/** 定数一覧の節の表の行 (見出しの行と区切りの行を除く) の、名前の欄のバッククォートの中身と根拠の欄 (最後の欄) */
function constantsRows(constantsSection: string): ConstantsRow[] {
  const rows = constantsSection.split('\n').filter((line) => line.startsWith('|'));
  return rows
    .filter((row, index) => index > 0 && !TABLE_SEPARATOR_ROW.test(row))
    .map((row) => {
      const cells = tableCells(row);
      const names = [...(cells[0] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
      return { names, basis: cells[cells.length - 1] ?? '' };
    });
}

/** 根拠の欄の `§X の…表` が指す節のうち、その定数の名前を表の行に持たないもの / `§X` のうち見出しが無いもの */
function brokenConstantReferences(markdown: string, constantsSection: string): string[] {
  const broken: string[] = [];
  for (const { names, basis } of constantsRows(constantsSection)) {
    for (const [, sectionNumber] of basis.matchAll(SECTION_REFERENCE)) {
      if (sectionNumber && sectionBody(markdown, sectionNumber) === null) {
        broken.push(`${names.join('・')}: §${sectionNumber} の見出しが無い`);
      }
    }
    for (const [reference, sectionNumber] of basis.matchAll(SECTION_TABLE_REFERENCE)) {
      const body = sectionNumber ? sectionBody(markdown, sectionNumber) : null;
      if (body === null) continue;
      const tableRows = body.split('\n').filter((line) => line.startsWith('|'));
      const named = tableRows.some((line) => names.some((name) => line.includes(`\`${name}\``)));
      if (!named) broken.push(`${names.join('・')}: 「${reference}」の節の表に名前の行が無い`);
    }
  }
  return broken;
}

describe('cross/02 の運営ロールの MFA の段落は、cross/12 の追随表が名指す節 (§8.3 Operator ドメイン) の下にある (#2050)', () => {
  it('段落のすぐ上の見出しを取り出せる (別の節を差し込むと、その節の見出しになる)', () => {
    const operator = ['### 8.3 Operator ドメイン', '', '| `admin_audit_logs` | a | b |', '', `${OPERATOR_MFA_PARAGRAPH_START}: …`].join('\n');
    expect(headingAbove(operator, OPERATOR_MFA_PARAGRAPH_START)).toBe('### 8.3 Operator ドメイン');
    const inserted = operator.replace(
      `\n\n${OPERATOR_MFA_PARAGRAPH_START}`,
      `\n\n### 8.4 献立 (meal planner) ドメイン\n\n| \`planned_meals\` | a | b |\n\n${OPERATOR_MFA_PARAGRAPH_START}`,
    );
    expect(headingAbove(inserted, OPERATOR_MFA_PARAGRAPH_START)).toBe('### 8.4 献立 (meal planner) ドメイン');
    expect(headingAbove(operator, '無い文')).toBeNull();
  });

  it('cross/12 の追随表の置き場の節と、cross/02 の段落のすぐ上の見出しが同じ', () => {
    const followupRows = read(CROSS12)
      .split('\n')
      .filter((line) => line.startsWith(CROSS12_FOLLOWUP_CROSS02_CELL) && line.includes(CROSS12_FOLLOWUP_MFA_QUOTE));
    expect(followupRows, `${CROSS12} の追随表に cross/02 の運営ロールの MFA の段落の行がちょうど 1 行ある`).toHaveLength(1);
    const placement = DOMAIN_SECTION_REFERENCE.exec(tableCells(followupRows[0] ?? '')[1] ?? '');
    expect(placement, '追随表の置き場の欄が「§N.M 〜 ドメイン」の形').not.toBeNull();
    const expectedHeading = `### ${placement?.[1]} ${placement?.[2]}`;
    expect(expectedHeading).toBe('### 8.3 Operator ドメイン');
    expect(headingAbove(read(CROSS02), OPERATOR_MFA_PARAGRAPH_START)).toBe(expectedHeading);
  });
});

describe('cross/23 §13 の定数一覧の根拠の欄が指す節は、本書にあり、表を指すならその定数の行を持つ (#2050)', () => {
  const fixture = [
    '## 9. 表 3 点',
    '',
    '### 9.3 ③状態遷移表',
    '',
    '| 前 | 操作 | 後 |',
    '|---|---|---|',
    '| 任意 | 400 (`INVALID_X`) | 変わらず |',
    '',
    '## 10. エラー表',
    '',
    '| 経路 | 応答 |',
    '|---|---|',
    '| Edge | 400 (`INVALID_X`) |',
    '',
    '## 11. シーケンス',
    '',
    '```',
    'INVALID_X は図の中だけ',
    '```',
    '',
    '## 13. 定数一覧',
    '',
    '| 名前 | 値 | 置き場 | 根拠 |',
    '|---|---|---|---|',
    "| `INVALID_X` | `'x'` | `a.ts` | 400 の文 (§11 の表) |",
    '',
    '## 14. 新設一覧',
  ].join('\n');
  const constantsOf = (markdown: string): string =>
    markdown.slice(markdown.indexOf(CROSS23_CONSTANTS_HEADING), markdown.indexOf(CROSS23_AFTER_CONSTANTS_HEADING));

  it('表の無い節を「§X の表」で指すと見分ける (シーケンス図の節)・表に名前の行がある節を指せば通る', () => {
    expect(brokenConstantReferences(fixture, constantsOf(fixture))).toEqual(['INVALID_X: 「§11 の表」の節の表に名前の行が無い']);
    const fixed = fixture.replace('(§11 の表)', '(§9.3 の状態遷移表・§10 のエラー表)');
    expect(brokenConstantReferences(fixed, constantsOf(fixed))).toEqual([]);
  });

  it('本書に見出しの無い §X を根拠に書くと見分ける', () => {
    const missing = fixture.replace('(§11 の表)', '(§12.9)');
    expect(brokenConstantReferences(missing, constantsOf(missing))).toEqual(['INVALID_X: §12.9 の見出しが無い']);
  });

  it('バッククォートの中の | ではセルを分けない', () => {
    expect(tableCells("| `A` | `'a' | 'b'` | 根拠 (§9.3) |")).toEqual(['`A`', "`'a' | 'b'`", '根拠 (§9.3)']);
  });

  it('cross/23 の §13 の行の根拠が指す節は、どれも本書にあり、表を指すならその定数の行を持つ', () => {
    const markdown = read(CROSS23);
    expect(markdown.indexOf(CROSS23_CONSTANTS_HEADING), `${CROSS23} に §13 の見出しがある`).toBeGreaterThanOrEqual(0);
    expect(markdown.indexOf(CROSS23_AFTER_CONSTANTS_HEADING), `${CROSS23} に §14 の見出しがある`).toBeGreaterThan(
      markdown.indexOf(CROSS23_CONSTANTS_HEADING),
    );
    const constants = constantsOf(markdown);
    const rows = constantsRows(constants);
    expect(rows.length, '§13 の表の行を取り出せる').toBeGreaterThan(0);
    expect(rows.some(({ basis }) => [...basis.matchAll(SECTION_REFERENCE)].length > 0), '§13 の根拠の欄に §X の参照がある (走査が空でない)').toBe(true);
    expect(brokenConstantReferences(markdown, constants)).toEqual([]);
  });
});

/** 節の本文の、先頭のセルがシナリオの番号の行の番号 (出てきた順) */
function scenarioIds(body: string): string[] {
  return [...body.matchAll(SCENARIO_ROW)].map((m) => m[1] ?? '');
}

/** §12.3 の行が、テストのファイルのすぐ後の括弧で名指す it の id のうち、そのファイルに `'<id>: ` の it 名が無いもの */
function missingTestIds(scenarioTestSection: string, readFile: (relativePath: string) => string): string[] {
  const missing: string[] = [];
  for (const row of scenarioTestSection.split('\n').filter((line) => line.startsWith(SCENARIO_ROW_PREFIX))) {
    for (const [, file, inside] of row.matchAll(TEST_FILE_WITH_IDS)) {
      if (!file) continue;
      const ids = [...(inside ?? '').matchAll(TEST_ID)].map((m) => m[1] ?? '');
      if (ids.length === 0) continue;
      const source = readFile(file);
      for (const id of ids) {
        if (!new RegExp(`['"\`]${id}: `).test(source)) missing.push(`${file}: ${id}`);
      }
    }
  }
  return missing;
}

/** §0.3 の #2041 の写真の解析の CAS のシナリオの行 */
function photoCasScenarioRows(scenarioSection: string): string[] {
  return scenarioSection.split('\n').filter((line) => line.startsWith(SCENARIO_ROW_PREFIX) && line.includes(PHOTO_CAS_SCENARIO_MARK));
}

/** 文の中の it の id (シナリオの番号 `S-n` は数えない。出てきた順・重なりなし) */
function testIdsIn(text: string): string[] {
  const ids = [...text.matchAll(TEST_ID)].map((m) => m[1] ?? '').filter((id) => !SCENARIO_ID.test(id));
  return [...new Set(ids)];
}

/** 節の本文の、先頭のセルが id のシナリオの番号の行 (無ければ null) */
function scenarioRow(section: string, id: string): string | null {
  return section.split('\n').find((line) => line.startsWith(`| ${id} |`)) ?? null;
}

/**
 * §0.3 の #2041 のシナリオの行の期待の欄と §4.3 のトレースの行が名指す it の id のうち、§12.3 の同じ S-n の行に無いもの
 * (`S-27: RO-9`)。§12.3 に行が無ければ `S-27: §12.3 の行が無い`
 */
function photoCasIdsMissingFromScenarioTests(scenarioSection: string, traceSection: string, scenarioTestSection: string): string[] {
  const missing: string[] = [];
  for (const row of photoCasScenarioRows(scenarioSection)) {
    const id = tableCells(row)[0] ?? '';
    const testsRow = scenarioRow(scenarioTestSection, id);
    if (testsRow === null) {
      missing.push(`${id}: §12.3 の行が無い`);
      continue;
    }
    const named = new Set(testIdsIn(tableCells(testsRow).slice(1).join(' | ')));
    const traceCells = tableCells(scenarioRow(traceSection, id) ?? '').slice(1);
    const cited = testIdsIn([...tableCells(row).slice(1), ...traceCells].join(' | '));
    for (const testId of cited) {
      if (!named.has(testId)) missing.push(`${id}: ${testId}`);
    }
  }
  return missing;
}

/** §12.3 の行が、テストのファイル file のすぐ後の括弧で名指す it の id (どの S-n の行でも) */
function testIdsNamedForFile(scenarioTestSection: string, file: string): Set<string> {
  const named = new Set<string>();
  for (const row of scenarioTestSection.split('\n').filter((line) => line.startsWith(SCENARIO_ROW_PREFIX))) {
    for (const [, rowFile, inside] of row.matchAll(TEST_FILE_WITH_IDS)) {
      if (rowFile !== file) continue;
      for (const id of testIdsIn(inside ?? '')) named.add(id);
    }
  }
  return named;
}

/** テストのファイルの it / describe の名前の id のうち、§12.3 がどの行でも名指さないもの (出てきた順・重なりなし) */
function testIdsUnnamedInScenarioTests(testSource: string, scenarioTestSection: string, file: string): string[] {
  const named = testIdsNamedForFile(scenarioTestSection, file);
  const ids = [...new Set([...testSource.matchAll(TEST_NAME_ID)].map((m) => m[1] ?? ''))];
  return ids.filter((id) => !named.has(id));
}

/** 注釈を外したソース (注釈の中の関数の名前を呼び出しと数えない) */
function withoutComments(source: string): string {
  return source.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '$1');
}

/** moduleSource が export した関数のうち、呼ぶ側のどれかが (注釈の外で) `名前(` と呼ぶものの名前 (export の順) */
function casStepsCalledBy(moduleSource: string, callerSources: readonly string[]): string[] {
  const exported = [...moduleSource.matchAll(EXPORTED_FUNCTION)].map((m) => m[1] ?? '');
  const callers = callerSources.map(withoutComments);
  return exported.filter((name) => callers.some((source) => new RegExp(`\\b${name}\\(`).test(source)));
}

/** §0.3 の #2041 のシナリオの §4.3 のトレースの行が書いていない手順 (`S-27: 名前`。トレースの行が無ければ `S-27: トレースの行が無い`) */
function casStepsMissingFromTraces(scenarioSection: string, traceSection: string, steps: readonly string[]): string[] {
  const ids = photoCasScenarioRows(scenarioSection).map((line) => tableCells(line)[0] ?? '');
  const missing: string[] = [];
  for (const id of ids) {
    const trace = traceSection.split('\n').find((line) => line.startsWith(`| ${id} |`));
    if (!trace) {
      missing.push(`${id}: トレースの行が無い`);
      continue;
    }
    for (const step of steps) {
      if (!trace.includes(`\`${step}`)) missing.push(`${id}: ${step}`);
    }
  }
  return missing;
}

describe('cross/23 のシナリオの表・トレース・シナリオ ⇄ テストの表がそろい、#2041 のシナリオが名指す it の id は §12.3 にあり、送った順のテストの it はどれも §12.3 に名指される (#2050)', () => {
  const casTestSource = [
    "it('PC-1: 先に送った解析が後に終わっても、後に送った解析の結果が残る', async () => {",
    "it.each([['A', 1]])('P-3: 2 本の解析は (%s)', async () => {",
  ].join('\n');
  const readFixture = (relativePath: string): string => (relativePath === 'tests/x.test.ts' ? casTestSource : '');

  it('括弧の中の id がファイルの it 名に無ければ見分ける (it.each の名前も数える・id の無い括弧は見ない)', () => {
    const section = [
      '| シナリオ | 確かめるテスト |',
      '|---|---|',
      '| S-1 | `tests/x.test.ts` (PC-1・P-3。条件の評価) |',
      '| S-2 | `tests/y.test.ts` (変えない。緑のまま) |',
    ].join('\n');
    expect(missingTestIds(section, readFixture)).toEqual([]);
    const wrong = section.replace('(PC-1・P-3。', '(PC-1・PC-4・P-3。');
    expect(missingTestIds(wrong, readFixture)).toEqual(['tests/x.test.ts: PC-4']);
  });

  const scenarios = [
    '| # | シナリオ | 期待 |',
    '|---|---|---|',
    '| S-11 | 写真の解析 | 書く |',
    '| S-27 | 写真を 2 回続けて送る (#2041) | 後に送った B の結果。確かめた順は §12.3 の RO-1・RO-6 |',
  ].join('\n');
  const traces = [
    '| # | トレース | 結果 |',
    '|---|---|---|',
    '| S-11 | 何も書かない (RO-9) | 期待どおり |',
    '| S-27 | S-11 と同じ手順 | 期待どおり (RO-1・RO-6) |',
  ].join('\n');
  const scenarioTests = [
    '| シナリオ | 確かめるテスト |',
    '|---|---|',
    '| S-11 | `tests/ro.test.ts` (RO-3) |',
    '| S-27 | `tests/ro.test.ts` (RO-1・RO-6)・`tests/pc.test.ts` (PC-9) |',
  ].join('\n');

  it('#2041 のシナリオの期待・トレースが名指す id が §12.3 の同じ S-n の行に無いと見分ける (S-n は id に数えない・#2041 を名指さない行は見ない)', () => {
    expect(testIdsIn('S-11 と同じ手順 (RO-1・RO-6・RO-1)')).toEqual(['RO-1', 'RO-6']);
    expect(photoCasIdsMissingFromScenarioTests(scenarios, traces, scenarioTests)).toEqual([]);
    // 期待の欄に順を足したが §12.3 の行に足していない
    const added = scenarios.replace('RO-1・RO-6 |', 'RO-1・RO-6・RO-7 |');
    expect(photoCasIdsMissingFromScenarioTests(added, traces, scenarioTests)).toEqual(['S-27: RO-7']);
    // トレースの結果の欄の id も見る
    const traceAdded = traces.replace('期待どおり (RO-1・RO-6)', '期待どおり (RO-1・RO-6・RO-8)');
    expect(photoCasIdsMissingFromScenarioTests(scenarios, traceAdded, scenarioTests)).toEqual(['S-27: RO-8']);
    // §12.3 から id を消した
    const removed = scenarioTests.replace('(RO-1・RO-6)', '(RO-1)');
    expect(photoCasIdsMissingFromScenarioTests(scenarios, traces, removed)).toEqual(['S-27: RO-6']);
    const noRow = scenarioTests.replace(/^\| S-27 \|.*$/m, '');
    expect(photoCasIdsMissingFromScenarioTests(scenarios, traces, noRow)).toEqual(['S-27: §12.3 の行が無い']);
  });

  it('テストのファイルの it / describe の id のうち、§12.3 がそのファイルの括弧で名指さないものを見分ける (ほかのファイルの括弧の id は数えない)', () => {
    const source = [
      "it('RO-1: a', async () => {",
      "it('RO-3: b', async () => {",
      "it('RO-6: c', async () => {",
      "describe('RO-5: d', () => {",
      "it('RO-6: e', async () => {",
    ].join('\n');
    const covered = scenarioTests.replace('`tests/ro.test.ts` (RO-3)', '`tests/ro.test.ts` (RO-3・RO-5)');
    expect(testIdsUnnamedInScenarioTests(source, covered, 'tests/ro.test.ts')).toEqual([]);
    // 新しい順の it を足したが §12.3 に名指していない
    expect(testIdsUnnamedInScenarioTests(`${source}\nit('RO-9: f', async () => {`, covered, 'tests/ro.test.ts')).toEqual(['RO-9']);
    // 別のファイルの括弧に同じ id があっても数えない
    const otherFile = covered.replace('`tests/pc.test.ts` (PC-9)', '`tests/pc.test.ts` (PC-9・RO-9)');
    expect(testIdsUnnamedInScenarioTests(`${source}\nit('RO-9: f', async () => {`, otherFile, 'tests/ro.test.ts')).toEqual(['RO-9']);
    expect(testIdsUnnamedInScenarioTests(source, scenarioTests, 'tests/ro.test.ts')).toEqual(['RO-5']);
  });

  it('シナリオの番号の行を、出てきた順に取り出す (表の見出しの行・ほかの表の行は数えない)', () => {
    expect(scenarioIds(['| # | シナリオ |', '|---|---|', '| S-1 | a |', '| S-2 | b |', '| I-1 | c |'].join('\n'))).toEqual(['S-1', 'S-2']);
  });

  it('cross/23 §0.3 の宣言の本数・§0.3 の行・§4.3 のトレース・§12.3 の対応表の S-n がそろう', () => {
    const markdown = read(CROSS23);
    const declared = SCENARIO_COUNT_DECLARATION.exec(markdown);
    expect(declared, `${CROSS23} §0.3 の見出しが本数を宣言している`).not.toBeNull();
    const ids = scenarioIds(sectionBody(markdown, SCENARIO_SECTION) ?? '');
    expect(ids.length, '§0.3 の行の数 = 見出しの宣言の本数').toBe(Number(declared?.[1]));
    expect(new Set(ids).size, '§0.3 の番号に重なりが無い').toBe(ids.length);
    expect(scenarioIds(sectionBody(markdown, TRACE_SECTION) ?? ''), '§4.3 のトレースの行').toEqual(ids);
    expect(scenarioIds(sectionBody(markdown, SCENARIO_TEST_SECTION) ?? ''), '§12.3 の対応表の行').toEqual(ids);
  });

  it('cross/23 §12.3 がテストのファイルの後の括弧で名指す it の id は、そのファイルに実在する', () => {
    const section = sectionBody(read(CROSS23), SCENARIO_TEST_SECTION);
    expect(section, `${CROSS23} に §12.3 の見出しがある`).not.toBeNull();
    expect(missingTestIds(section ?? '', read)).toEqual([]);
  });

  it('cross/23 の #2041 のシナリオの §0.3 の期待は送った順のテストの id を名指し、期待・§4.3 のトレースが名指す id はどれも §12.3 の同じ S-n の行にある', () => {
    const markdown = read(CROSS23);
    const scenarioSection = sectionBody(markdown, SCENARIO_SECTION) ?? '';
    // #2041 のシナリオ (S-27) を足す前の正典では行が無く、ここは何も見ない。足した正典では行ごとに見る
    const photoCasRows = photoCasScenarioRows(scenarioSection);
    const requestOrderIds = new Set([...read(PHOTO_CAS_REQUEST_ORDER_TEST).matchAll(TEST_NAME_ID)].map((m) => m[1] ?? ''));
    for (const row of photoCasRows) {
      const expectation = tableCells(row)[SCENARIO_EXPECTATION_CELL] ?? '';
      expect(
        testIdsIn(expectation).filter((id) => requestOrderIds.has(id)).length,
        `${tableCells(row)[0]} の期待の欄が ${PHOTO_CAS_REQUEST_ORDER_TEST} の it の id を名指す`,
      ).toBeGreaterThan(0);
    }
    expect(
      photoCasIdsMissingFromScenarioTests(scenarioSection, sectionBody(markdown, TRACE_SECTION) ?? '', sectionBody(markdown, SCENARIO_TEST_SECTION) ?? ''),
    ).toEqual([]);
  });

  it('cross/23 に #2041 のシナリオがあれば、送った順のテスト (route と Edge を本物で通す) の RO-n の it は、どれも §12.3 のどこかの行がそのファイルの括弧で名指す', () => {
    const source = read(PHOTO_CAS_REQUEST_ORDER_TEST);
    expect([...source.matchAll(TEST_NAME_ID)].length, `${PHOTO_CAS_REQUEST_ORDER_TEST} に id つきの it がある (走査が空でない)`).toBeGreaterThan(0);
    const markdown = read(CROSS23);
    const unnamed = testIdsUnnamedInScenarioTests(source, sectionBody(markdown, SCENARIO_TEST_SECTION) ?? '', PHOTO_CAS_REQUEST_ORDER_TEST);
    // #2041 のシナリオ (S-27) を足す前の正典は、送った順のテストを §12.3 で名指していない (そのシナリオを足すときに、全部の RO-n を名指す)
    const hasPhotoCasScenario = photoCasScenarioRows(sectionBody(markdown, SCENARIO_SECTION) ?? '').length > 0;
    expect(hasPhotoCasScenario ? unnamed : []).toEqual([]);
  });
});

describe('cross/23 の #2041 のシナリオのトレースは、route・Edge が呼ぶ書き込みの順序の守りの手順をどれも書く (#2050 R3)', () => {
  const moduleFixture = [
    'export function parseInvokedAt(value: unknown) {}',
    'export async function markRequest(db: Db) {}',
    'export async function claim(db: Db) {}',
    'function notExported() {}',
    'export async function unused(db: Db) {}',
  ].join('\n');
  const routeFixture = [
    "import { markRequest } from './cas';",
    '// unused(db) は注釈の中だけ',
    '/* claim(db) もブロックの注釈の中だけ */',
    "const url = 'https://example.test/unused';",
    'const mark = await markRequest(supabase);',
  ].join('\n');
  const edgeFixture = 'const parsed = parseInvokedAt(body.invokedAt)\nconst c = await claim(queueDb)';

  it('export した関数のうち、呼ぶ側が注釈の外で呼ぶものだけを手順に数える', () => {
    expect(casStepsCalledBy(moduleFixture, [routeFixture, edgeFixture])).toEqual(['parseInvokedAt', 'markRequest', 'claim']);
    expect(casStepsCalledBy(moduleFixture, [routeFixture])).toEqual(['markRequest']);
  });

  it('#2041 のシナリオのトレースの行が手順の名前を書かない・トレースの行が無いと見分ける (#2041 を名指さない行は見ない)', () => {
    const scenarios = ['| # | シナリオ | 期待 |', '|---|---|---|', '| S-26 | 写真 | x |', '| S-27 | 写真を 2 回 (#2041) | B |'].join('\n');
    const trace = [
      '| # | トレース | 結果 |',
      '|---|---|---|',
      '| S-26 | 何も書かない | 期待どおり |',
      '| S-27 | route: `markRequest` → Edge: `parseInvokedAt` → `claim` (印 a) | 期待どおり |',
    ].join('\n');
    const steps = ['parseInvokedAt', 'markRequest', 'claim'];
    expect(casStepsMissingFromTraces(scenarios, trace, steps)).toEqual([]);
    // 要求の印を飛ばし、Edge から書き始めたトレース (R2 の S-27 のトレースは、#2056 が足した要求の印を書いていなかった)
    const skipped = trace.replace('route: `markRequest` → ', '');
    expect(casStepsMissingFromTraces(scenarios, skipped, steps)).toEqual(['S-27: markRequest']);
    const noRow = trace.replace(/^\| S-27 \|.*$/m, '');
    expect(casStepsMissingFromTraces(scenarios, noRow, steps)).toEqual(['S-27: トレースの行が無い']);
  });

  it('cross/23 §4.3 の #2041 のシナリオのトレースの行は、route・Edge が呼ぶ手順の関数の名前をどれも書く', () => {
    const steps = casStepsCalledBy(read(PHOTO_CAS_MODULE), PHOTO_CAS_CALLERS.map(read));
    // 走査が空でない: Edge の解析の印と、route の要求の印 (#2050) は手順に入る
    expect(steps).toEqual(expect.arrayContaining(['claimPhotoAnalysis', 'markPhotoAnalysisRequest']));
    const markdown = read(CROSS23);
    const scenarioSection = sectionBody(markdown, SCENARIO_SECTION) ?? '';
    expect(casStepsMissingFromTraces(scenarioSection, sectionBody(markdown, TRACE_SECTION) ?? '', steps)).toEqual([]);
  });
});

/** family/11 の節 sectionNumber が、解散済みの家族を運営が強制解散すると FAMILY_ALREADY_DISSOLVED で止まる表の行を持つか */
function hasForceDissolve409Row(family11: string, sectionNumber: string): boolean {
  const body = sectionBody(family11, sectionNumber);
  if (body === null) return false;
  return body
    .split('\n')
    .some((line) => line.startsWith('|') && line.includes(FORCE_DISSOLVE_OPERATION) && line.includes(FAMILY_ALREADY_DISSOLVED));
}

/** 行の中の節の参照 (pattern の 1 つ目の括弧) のうち、family/11 のその節が 409 の行を持たないもの (`§8`) */
function sectionsWithoutForceDissolve409Row(rows: readonly string[], pattern: RegExp, family11: string): string[] {
  return rows
    .map((row) => pattern.exec(row)?.[1] ?? null)
    .filter((section): section is string => section !== null && !hasForceDissolve409Row(family11, section))
    .map((section) => `§${section}`);
}

describe('解散済みの家族を運営が強制解散すると 409 の行の正を指す参照 (operator/11・family/11 S-19) は、その行を持つ family/11 の節を指す (#2050 R4)', () => {
  const family11Fixture = [
    '## 8. ① 全パターン表',
    '',
    '| 立場 | 状態 | 入口 | 何が起きるか |',
    '|---|---|---|---|',
    '| 運営 | 通常 | 強制解散 | 今までどおり (S-19) |',
    '| 代表者 | 解散済み | API | 409 `FAMILY_ALREADY_DISSOLVED` |',
    '',
    '## 10. ③ 状態遷移表',
    '',
    '### 10.1 `family_groups`',
    '',
    '| 前 | 操作 | 後 | ガード | 副作用 |',
    '|---|---|---|---|---|',
    '| dissolved | 運営が強制解散 | dissolved | `status = active` | 409 `FAMILY_ALREADY_DISSOLVED` |',
    '',
    '### 10.2 `organizations`',
  ].join('\n');

  it('節が運営の強制解散の 409 の行を持つかを見分ける (操作とエラーが別の行に分かれていれば持たない・無い節は持たない)', () => {
    expect(hasForceDissolve409Row(family11Fixture, '10.1')).toBe(true);
    expect(hasForceDissolve409Row(family11Fixture, '10')).toBe(true);
    expect(hasForceDissolve409Row(family11Fixture, '8')).toBe(false);
    expect(hasForceDissolve409Row(family11Fixture, '10.2')).toBe(false);
    expect(hasForceDissolve409Row(family11Fixture, '9')).toBe(false);
  });

  it('参照が 409 の行を持たない節 (全パターン表の §8) を指すと見分ける', () => {
    const operatorRow = `${OPERATOR11_DISSOLVED_FORCE_ROW} (家族の冊) | 同じ | super_admin (正は family/11 §8) | 409 |`;
    expect(sectionsWithoutForceDissolve409Row([operatorRow], OPERATOR11_CANON_REFERENCE, family11Fixture)).toEqual(['§8']);
    expect(
      sectionsWithoutForceDissolve409Row([operatorRow.replace('§8)', '§10.1)')], OPERATOR11_CANON_REFERENCE, family11Fixture),
    ).toEqual([]);
    const s19Row = `${FAMILY11_S19_ROW_PREFIX} 監査を書く (注: 409 で止める。§8・Q-5) |`;
    expect(sectionsWithoutForceDissolve409Row([s19Row], FAMILY11_S19_NOTE_REFERENCE, family11Fixture)).toEqual(['§8']);
    expect(sectionsWithoutForceDissolve409Row([s19Row.replace('§8・', '§10.1・')], FAMILY11_S19_NOTE_REFERENCE, family11Fixture)).toEqual([]);
  });

  it('operator/11 の解散済みの家族の強制解散の行と、family/11 の S-19 の注が指す family/11 の節は、その 409 の行を持つ', () => {
    const family11 = read(FAMILY11);
    const operatorRows = read(OPERATOR11)
      .split('\n')
      .filter((line) => line.startsWith(OPERATOR11_DISSOLVED_FORCE_ROW) && OPERATOR11_CANON_REFERENCE.test(line));
    // 行を足す前の正典では 0 行 (ここは何も見ない)。足した正典では 1 行
    expect(operatorRows.length, `${OPERATOR11} の、解散済みの家族の強制解散の行で family/11 の節を正とする行は 1 行まで`).toBeLessThanOrEqual(1);
    const s19Rows = family11
      .split('\n')
      .filter((line) => line.startsWith(FAMILY11_S19_ROW_PREFIX) && FAMILY11_S19_NOTE_REFERENCE.test(line));
    expect(s19Rows.length, `${FAMILY11} の S-19 の行のうち、注が 409 の行の節を指す行は 1 行まで`).toBeLessThanOrEqual(1);
    expect(sectionsWithoutForceDissolve409Row(operatorRows, OPERATOR11_CANON_REFERENCE, family11)).toEqual([]);
    expect(sectionsWithoutForceDissolve409Row(s19Rows, FAMILY11_S19_NOTE_REFERENCE, family11)).toEqual([]);
  });
});

/** 行の中の `file` と、そのすぐ後に「の」か括弧で続けて名指す `関数`・`関数` の名前 (file が無ければ null。`file:12` の行番号は名前に数えない) */
function functionsNamedAfter(row: string, file: string): string[] | null {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\`${escaped}(?::[\\d, ]+)?\`(?: の | \\()?((?:\`\\w+\`・?)*)`).exec(row);
  if (!match) return null;
  return [...(match[1] ?? '').matchAll(/`(\w+)`/g)].map((m) => m[1] ?? '');
}

/** 名指した関数のうち、source に定義 (`const x =`・`function x(`) が無いもの */
function undefinedFunctions(names: readonly string[], source: string): string[] {
  return names.filter((name) => !functionDefinition(name).test(source));
}

describe('cross/13a の招待の API の行が名指す組織の招待の画面の関数は、その画面のファイルに定義がある (#2050 R4)', () => {
  const pageFixture = [
    "'use client';",
    'export default function Page() {',
    '  const fetchInvites = useCallback(async () => {',
    "    const res = await fetch('/api/org/invites');",
    '  }, []);',
    '  const handleRevokeInvite = async (id: string) => {',
    '    const res = await fetch(`/api/org/invites/${id}/revoke`);',
    '  };',
    '}',
  ].join('\n');

  it('ファイルのすぐ後に名指す関数の名前を取り出し、定義の無い名前を見分ける (行番号だけの名指しは名前が無い)', () => {
    const named = `呼ぶ画面 (Web \`${ORG_INVITES_PAGE}\` の \`fetchInvites\`・\`handleRevokeInvite\`、モバイル \`x.tsx\`)`;
    expect(functionsNamedAfter(named, ORG_INVITES_PAGE)).toEqual(['fetchInvites', 'handleRevokeInvite']);
    expect(undefinedFunctions(['fetchInvites', 'handleRevokeInvite'], pageFixture)).toEqual([]);
    const renamed = named.replace('`handleRevokeInvite`', '`handleCancelInvite`');
    expect(undefinedFunctions(functionsNamedAfter(renamed, ORG_INVITES_PAGE) ?? [], pageFixture)).toEqual(['handleCancelInvite']);
    expect(functionsNamedAfter(`\`${ORG_INVITES_PAGE}:3, 4, 7\` (\`fetchInvites\`)`, ORG_INVITES_PAGE)).toEqual(['fetchInvites']);
    expect(functionsNamedAfter(`\`${ORG_INVITES_PAGE}:3, 4, 7\`、モバイル`, ORG_INVITES_PAGE)).toEqual([]);
    expect(functionsNamedAfter('名指しが無い行', ORG_INVITES_PAGE)).toBeNull();
  });

  it('cross/13a の招待の API の行が組織の招待の画面に続けて名指す関数は、画面のファイルに定義がある', () => {
    const rows = read(CROSS13A)
      .split('\n')
      .filter((line) => line.startsWith('|') && line.includes(`\`${ORG_INVITES_PAGE}`));
    expect(rows, `${CROSS13A} に組織の招待の画面を名指す行がちょうど 1 行ある`).toHaveLength(1);
    // 関数の名前で指す前の正典 (行番号だけ) では名前が無く、ここは何も見ない。名前で指した正典では名前ごとに見る
    expect(undefinedFunctions(functionsNamedAfter(rows[0] ?? '', ORG_INVITES_PAGE) ?? [], read(ORG_INVITES_PAGE))).toEqual([]);
  });
});
