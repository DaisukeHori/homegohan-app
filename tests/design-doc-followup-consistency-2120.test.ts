// @vitest-environment node
/**
 * #2120 (docs-1031b) の記録の古さの直しで、設計書の参照の先と画面の図が実物と食い違わないことの contract テスト (ソース走査)
 *
 * docs-1031b の直し (design-doc.patch) の審査 R1 で、古さを直す直しそのものが新しい食い違いを 3 つ作っていた:
 *  1. operator/02 §23 のエラーコードの行に足した「プランの編集 (`PATCH /api/super-admin/plans/{id}`。§15)」の §15 は
 *     A/B テスト API の節で、PATCH plans は §17 (プラン定義 API) にある (同じ行の price-change は §17 と書いている)
 *  2. operator/03 §24 の見出しを「価格変更モーダル」から「価格の変更の画面」にしたのに、その画面の冒頭のコメント
 *     (`src/app/super-admin/plans/[id]/price-change/page.tsx`) は「§24 (価格変更モーダル)」のまま
 *  3. operator/03 §24 の価格の変更の画面の図が、実物の 2 段 (Step 1 の価格の入力とシミュレーション → 「確認ステップへ →」→
 *     Step 2 の確認・変更理由・適用開始日時・実行) を落とし、全部を 1 画面に並べていた
 *
 * ここでは次を確かめる (どれも直す前の設計書 (このブランチの docs) でも、直したあとの設計書でも成り立ち、上の 3 つだけを落とす):
 *  A. operator/02 の「(`<METHOD> /api/…`。§N)」の参照は、§N の節に「### <METHOD> /api/…」の見出しがある
 *  B. src のコメントが「operator/03-ui-spec.md §N (<名前>)」と書き、operator/03 に「**<見出し>** (`<そのファイル>`)」の
 *     見出しがあれば、<名前> = <見出し>
 *  C. operator/03 に価格の変更の画面のファイルを名指しする見出しがあれば、その図は画面の Step ごとに分かれ、
 *     図の欄・ボタンの名前は、画面でその名前を出す Step と同じ Step に書かれている
 *
 * 限界: A は「(`<METHOD> <path>`。§N」の形の参照だけを見る (「§N の …」のように文の中で書いた参照と、ほかの冊は見ない)。
 * B は見出しが画面のファイルを名指しするときだけ見る (名指ししない見出しと、§ の番号が正しいかは見ない)。
 * C は価格の変更の画面の図だけを見る (欄の並びの順と、図の括弧の中の説明は見ない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const OPERATOR_API_SPEC = 'docs/design/operator/02-api-spec.md';
const OPERATOR_UI_SPEC = 'docs/design/operator/03-ui-spec.md';
const PRICE_CHANGE_PAGE = 'src/app/super-admin/plans/[id]/price-change/page.tsx';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function readLines(rel: string): string[] {
  return read(rel).split('\n');
}

describe('A. operator/02: 「(`<METHOD> /api/…`。§N)」の参照の先の節に、その API の見出しがある', () => {
  /** 「`PATCH /api/super-admin/plans/{id}`。§17」の形の参照 */
  const API_SECTION_REF = /`(GET|POST|PATCH|PUT|DELETE) (\/api\/[^`\s]+)`。§(\d+)/g;

  /** 節の番号 (## N.) ごとの、その節の行 */
  function sectionsByNumber(lines: string[]): Map<number, string[]> {
    const sections = new Map<number, string[]>();
    let current: string[] | undefined;
    for (const line of lines) {
      const heading = /^## (\d+)\. /.exec(line);
      if (heading) {
        current = [];
        sections.set(Number(heading[1]), current);
      }
      current?.push(line);
    }
    return sections;
  }

  /** 参照の先の節に「### <METHOD> <path>」の見出しが無い参照 (「行: 参照」の形) */
  function unresolvedRefs(lines: string[]): string[] {
    const sections = sectionsByNumber(lines);
    return lines.flatMap((line, index) =>
      [...line.matchAll(API_SECTION_REF)].flatMap(([, method, apiPath, section]) => {
        const heading = `### ${method} ${apiPath}`;
        const found = (sections.get(Number(section)) ?? []).some((sectionLine) => sectionLine.trim() === heading);
        return found ? [] : [`:${index + 1} ${method} ${apiPath} → §${section}`];
      }),
    );
  }

  it('判定の見つけ方: 違う節を指す参照を見つけ、正しい節を指す参照は通す', () => {
    const doc = [
      '## 15. A/B テスト API',
      '### POST /api/super-admin/experiments',
      '## 17. プラン定義 API',
      '### PATCH /api/super-admin/plans/{id}',
      '| X | 409 | プランの編集 (`PATCH /api/super-admin/plans/{id}`。§17)・作成 (`POST /api/super-admin/experiments`。§15) |',
      '| Y | 409 | プランの編集 (`PATCH /api/super-admin/plans/{id}`。§15) |',
    ];
    expect(unresolvedRefs(doc)).toEqual([':6 PATCH /api/super-admin/plans/{id} → §15']);
  });

  it('走査が空振りしていない (価格の変更の API の参照が §17 にある)', () => {
    const refs = readLines(OPERATOR_API_SPEC).flatMap((line) =>
      [...line.matchAll(API_SECTION_REF)].map(([, method, apiPath, section]) => `${method} ${apiPath} §${section}`),
    );
    expect(refs).toContain('POST /api/super-admin/plans/{id}/price-change §17');
  });

  it('どの参照も、参照の先の節に「### <METHOD> <path>」の見出しがある', () => {
    expect(unresolvedRefs(readLines(OPERATOR_API_SPEC))).toEqual([]);
  });
});

/** src の下の .ts / .tsx (リポジトリからの相対のパス) */
function sourceFiles(): string[] {
  const entries = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf-8' });
  return entries
    .filter((entry) => /\.tsx?$/.test(entry))
    .map((entry) => path.posix.join('src', entry.split(path.sep).join('/')));
}

describe('B. src のコメントが書く operator/03 の節の名前は、そのファイルを名指しする見出しと同じ', () => {
  /** 「operator/03-ui-spec.md §24 (価格の変更の画面)」の形の参照の名前 */
  const UI_SPEC_LABEL_REF = /operator\/03-ui-spec\.md §[\d.]+ \(([^)]+)\)/g;

  /** operator/03 の「**<見出し>** (`<ファイル>`)」の見出し (ファイル → 見出し) */
  function headingsByFile(lines: string[]): Map<string, string> {
    const headings = new Map<string, string>();
    for (const line of lines) {
      const match = /^\*\*([^*]+)\*\* \(`([^`]+)`\)/.exec(line);
      if (match) headings.set(match[2], match[1]);
    }
    return headings;
  }

  /** 見出しと食い違う名前 (「ファイル: 名前 ≠ 見出し」の形) */
  function mismatchedLabels(files: ReadonlyMap<string, string>, headings: ReadonlyMap<string, string>): string[] {
    return [...files].flatMap(([file, source]) => {
      const heading = headings.get(file);
      if (heading === undefined) return [];
      return [...source.matchAll(UI_SPEC_LABEL_REF)]
        .map((match) => match[1])
        .filter((label) => label !== heading)
        .map((label) => `${file}: ${label} ≠ ${heading}`);
    });
  }

  it('判定の見つけ方: 見出しと違う名前を見つけ、同じ名前と見出しの無いファイルは通す', () => {
    const headings = headingsByFile(['**価格の変更の画面** (`src/a/page.tsx`):', '**ほかの画面**:']);
    const files = new Map([
      ['src/a/page.tsx', ' * operator/03-ui-spec.md §24 (価格変更モーダル) 準拠'],
      ['src/b/page.tsx', ' * operator/03-ui-spec.md §3 (共通レイアウト) 準拠'],
    ]);
    expect(mismatchedLabels(files, headings)).toEqual(['src/a/page.tsx: 価格変更モーダル ≠ 価格の変更の画面']);
    files.set('src/a/page.tsx', ' * operator/03-ui-spec.md §24 (価格の変更の画面) 準拠');
    expect(mismatchedLabels(files, headings)).toEqual([]);
  });

  it('走査が空振りしていない (価格の変更の画面のコメントが operator/03 §24 の名前を書く)', () => {
    expect([...read(PRICE_CHANGE_PAGE).matchAll(UI_SPEC_LABEL_REF)].map((match) => match[1])).toHaveLength(1);
  });

  it('どのコメントの名前も、そのファイルを名指しする operator/03 の見出しと同じ', () => {
    const files = new Map(sourceFiles().map((file) => [file, read(file)]));
    expect(mismatchedLabels(files, headingsByFile(readLines(OPERATOR_UI_SPEC)))).toEqual([]);
  });
});

describe('C. operator/03 の価格の変更の画面の図は、画面の Step ごとに分かれ、欄とボタンを同じ Step に書く', () => {
  /** 画面の「{/* Step N: … *\/}」の区切りごとの、その Step の本文 (Step の番号 → 本文) */
  function pageSteps(source: string): Map<number, string> {
    const marks = [...source.matchAll(/\{\/\* Step (\d+):/g)];
    return new Map(
      marks.map((mark, index) => [
        Number(mark[1]),
        source.slice(mark.index ?? 0, marks[index + 1]?.index ?? source.length),
      ]),
    );
  }

  /** 画面の文字列の定数 (値 → 定数の名前。ボタンの文を定数で書いているため) */
  function stringConstants(source: string): Map<string, string> {
    return new Map([...source.matchAll(/^const (\w+) = '([^']+)';$/gm)].map((match) => [match[2], match[1]]));
  }

  /** 画面で、その名前を出す Step の番号 (定数で書いた文は定数の名前で探す) */
  function stepsShowing(label: string, steps: ReadonlyMap<number, string>, constants: ReadonlyMap<string, string>): number[] {
    const constantName = constants.get(label);
    return [...steps]
      .filter(([, body]) => body.includes(label) || (constantName !== undefined && body.includes(constantName)))
      .map(([step]) => step);
  }

  /** 図のコードブロックの行 (見出しが無ければ undefined) */
  function diagramLines(lines: string[]): string[] | undefined {
    const headingIndex = lines.findIndex((line) => /^\*\*[^*]+\*\* \(`/.test(line) && line.includes(`\`${PRICE_CHANGE_PAGE}\``));
    if (headingIndex < 0) return undefined;
    const open = lines.findIndex((line, index) => index > headingIndex && line.startsWith('```'));
    const close = lines.findIndex((line, index) => index > open && line.startsWith('```'));
    expect(open, `${OPERATOR_UI_SPEC} の価格の変更の画面の見出しの後に図 (コードブロック) がある`).toBeGreaterThan(headingIndex);
    return lines.slice(open + 1, close);
  }

  /** 図の欄・ボタンの名前と、図の上でのその Step (Step の区切りより前は undefined) */
  function diagramLabels(lines: string[]): { label: string; step: number | undefined }[] {
    let step: number | undefined;
    return lines.flatMap((line) => {
      const stepMark = /^Step (\d+)/.exec(line);
      if (stepMark) {
        step = Number(stepMark[1]);
        return [];
      }
      const withoutNotes = line.replace(/ \([^()]*(?:\([^()]*\)[^()]*)*\)/g, '');
      const buttons = [...withoutNotes.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
      if (withoutNotes.trimStart().startsWith('[')) return buttons.map((label) => ({ label, step }));
      return withoutNotes
        .split(' / ')
        .map((part) => part.split(':')[0].trim())
        .filter((label) => label !== '')
        .map((label) => ({ label, step }));
    });
  }

  /** 図の名前が、画面でその名前を出す Step と違う Step に書かれているもの */
  function misplacedLabels(diagram: string[], source: string): string[] {
    const steps = pageSteps(source);
    const constants = stringConstants(source);
    return diagramLabels(diagram).flatMap(({ label, step }) => {
      const shown = stepsShowing(label, steps, constants);
      if (step !== undefined && shown.includes(step)) return [];
      return [`${label}: 図は Step ${step ?? '(区切り無し)'}、画面は Step ${shown.join('・') || '(無し)'}`];
    });
  }

  const page = read(PRICE_CHANGE_PAGE);

  it('判定の見つけ方: Step の区切りの無い図と、違う Step に書いた欄を見つけ、正しい図は通す', () => {
    const source = [
      "const EXECUTE_LABEL = '実行する';",
      '{/* Step 1: 入力 */}',
      '<label>新しい月額 (JPY)</label><button>確認ステップへ →</button>',
      '{/* Step 2: 確認 */}',
      '<label>変更理由</label><button>{EXECUTE_LABEL}</button>',
    ].join('\n');
    const flat = ['新しい月額: [¥入力]', '変更理由: [テキストエリア] (必須)', '[実行する]'];
    expect(misplacedLabels(flat, source)).toHaveLength(3);
    const swapped = ['Step 1:', '新しい月額: [¥入力]', '変更理由: [テキストエリア]', 'Step 2:', '[確認ステップへ →]  [実行する]'];
    expect(misplacedLabels(swapped, source)).toEqual([
      '変更理由: 図は Step 1、画面は Step 2',
      '確認ステップへ →: 図は Step 2、画面は Step 1',
    ]);
    const right = ['Step 1 (入力):', '新しい月額: [¥入力] (送る)', '[確認ステップへ →]', 'Step 2 (確認):', '変更理由: [テキストエリア]', '[実行する]'];
    expect(misplacedLabels(right, source)).toEqual([]);
  });

  it('画面は Step 1 (価格の入力) と Step 2 (確認と実行) に分かれている (走査が空振りしていない)', () => {
    const steps = pageSteps(page);
    expect([...steps.keys()]).toEqual([1, 2]);
    const constants = stringConstants(page);
    expect(stepsShowing('影響をシミュレーション', steps, constants)).toEqual([1]);
    expect(stepsShowing('変更理由', steps, constants)).toEqual([2]);
    expect(stepsShowing('価格変更を実行する', steps, constants)).toEqual([2]);
  });

  it('設計書に価格の変更の画面の図があれば、Step ごとに分かれ、どの欄・ボタンも画面と同じ Step に書かれている', () => {
    const diagram = diagramLines(readLines(OPERATOR_UI_SPEC));
    if (diagram === undefined) return;
    expect(diagramLabels(diagram).length).toBeGreaterThanOrEqual(pageSteps(page).size);
    expect(misplacedLabels(diagram, page)).toEqual([]);
  });
});
