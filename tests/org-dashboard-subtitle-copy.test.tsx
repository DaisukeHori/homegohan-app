/**
 * 組織のダッシュボードの見出しの下の説明 (副題) が、画面の今の中身だけを言っていることのテスト (#1911)
 *
 * 問題:
 *   組織の管理者のダッシュボードは、組織の集計 (活力スコア・朝食摂取率・深夜食率・活動率) と部署別の表示を
 *   #1325 / #1120 で止めていて、出すのはメンバー数 (GET /api/org/stats) だけ。それなのに副題が
 *   「組織のバイタルサインと生産性指標」と書いていて、無い機能があるように読めた
 *   (#1911「未完成の機能は画面に出さない」と食い違う)。副題を「組織のメンバー数」に直した。
 *
 * このテストが見ること:
 *   1. ダッシュボードを描画し、見出し「ダッシュボード」のすぐ下の説明が「組織のメンバー数」であること。
 *      メンバー数が取れたときも取れなかったときも同じ (説明は取得の結果で変わらない)。
 *   2. 描画した画面の文字に、止めている集計を思わせる語 (STOPPED_FEATURE_WORDS) が 1 つも無いこと。
 *   3. 同じ型の取りこぼしが無いよう、組織の管理画面 (src/app/(org) 配下) のすべてのソースの、画面に出うる
 *      文字 (JSX の文字・文字列・テンプレート文字列の文字の部分) にも、その語が無いこと。
 *      コメントは構文木の節にならないので見ない (#1325 / #1120 の経緯を書いたコメントは残してよい)。
 *
 * 文言の英語の固定の残りは tests/org-ui-no-english-copy.test.ts が、集計・再集計の通信を呼ばないことは
 * tests/org-dashboard-refresh-route.test.tsx が見る。ここは副題と「止めている機能があるように読める語」だけを見る。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { default: OrgDashboardPage } = await import('@/app/(org)/org/dashboard/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = path.resolve(__dirname, '..');
/** 走査する画面のディレクトリ (組織の管理画面のルートグループ) */
const SCAN_ROOT = 'src/app/(org)';
/** ダッシュボードのソース (走査の対象に入っていることを確かめる) */
const DASHBOARD_FILE = 'src/app/(org)/org/dashboard/page.tsx';

/** 見出し (サイドバーのナビの名前と同じ) */
const DASHBOARD_HEADING = 'ダッシュボード';
/** 見出しの下の説明。画面の今の中身 (メンバー数) だけを言う */
const DASHBOARD_SUBTITLE = '組織のメンバー数';
/** 以前の副題 (止めている集計があるように読めた) */
const REMOVED_SUBTITLE = '組織のバイタルサインと生産性指標';

/**
 * 止めている機能 (#1325 / #1120 の組織の集計と部署別の表示) があるように読める語と、
 * 未完成の機能を出す語 (#1911)。組織の管理画面の、画面に出うる文字に 1 つも書かない。
 * チャレンジの「集計 (参加者数と平均)」は実在する機能なので、「集計」そのものは数えない。
 */
const STOPPED_FEATURE_WORDS = [
  'バイタル',
  '生産性',
  '活力スコア',
  '朝食摂取率',
  '深夜食率',
  '活動率',
  '部署ランキング',
  '部署別',
  '準備中',
  '近日公開',
] as const;

/** 描画の待ちの上限 (ミリ秒)。非同期の読み込みは即時に解決するので、これを超えたら描画の不具合 */
const RENDER_WAIT_LIMIT_MS = 3000;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ stats: { member_count: 12, organization_id: 'org-1' } }));
  vi.stubGlobal('fetch', fetchMock);
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  consoleErrorSpy.mockRestore();
  vi.unstubAllGlobals();
});

async function until(condition: () => boolean, what: string) {
  const startedAt = performance.now();
  while (!condition()) {
    if (performance.now() - startedAt > RENDER_WAIT_LIMIT_MS) throw new Error(`待ちきれませんでした: ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const text = () => container.textContent ?? '';

/** 描画して、メンバー数の取得が終わる (成功か失敗の表示になる) まで待つ */
async function renderDashboard() {
  await act(async () => {
    root.render(<OrgDashboardPage />);
  });
  await until(() => fetchMock.mock.calls.length >= 1, 'メンバー数の取得の開始');
  await until(() => /\d+\s*名/.test(text()) || text().includes('取得できませんでした'), 'メンバー数の取得の完了');
}

/** 見出し (h1) の次の要素の文字 = 見出しの下の説明 */
function subtitleText(): string | null {
  const heading = container.querySelector('h1');
  expect(heading?.textContent).toBe(DASHBOARD_HEADING);
  return heading?.nextElementSibling?.textContent ?? null;
}

describe('組織のダッシュボードの副題: 今の中身 (メンバー数) だけを言う (#1911)', () => {
  it('ST-1: 見出しの下の説明が「組織のメンバー数」で、以前の副題は出ない', async () => {
    await renderDashboard();

    expect(subtitleText()).toBe(DASHBOARD_SUBTITLE);
    expect(text()).not.toContain(REMOVED_SUBTITLE);
    expect(text()).toMatch(/12\s*名/);
  });

  it('ST-2: メンバー数が取れないときも、説明は同じ (取得の結果で、止めている機能を言う文に変わらない)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: { code: 'INTERNAL_ERROR' } }, 500));

    await renderDashboard();

    expect(text()).toContain('メンバー数を取得できませんでした');
    expect(subtitleText()).toBe(DASHBOARD_SUBTITLE);
  });

  it.each(STOPPED_FEATURE_WORDS)('ST-3: 描画した画面に「%s」が無い', async (word) => {
    await renderDashboard();

    expect(text()).not.toContain(word);
  });
});

// ---- 組織の管理画面のソースの走査 (同じ型の取りこぼしを防ぐ) ----

interface CopyFinding {
  file: string;
  line: number;
  text: string;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(rel));
    else if (/\.(?:tsx?|jsx?)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** 画面に出うる文字 (JSX の文字・文字列・テンプレート文字列の文字の部分) を集める。コメントは節にならないので入らない */
function collectCopy(file: string, source: string): CopyFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: CopyFinding[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxText(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function findStoppedFeatureWords(findings: CopyFinding[]): string[] {
  return findings.flatMap((finding) =>
    STOPPED_FEATURE_WORDS.filter((word) => finding.text.includes(word)).map(
      (word) => `${finding.file}:${finding.line}「${word}」 (${finding.text.trim()})`,
    ),
  );
}

describe('組織の管理画面のソース: 止めている機能があるように読める語を、画面に出る文字に書かない (#1911)', () => {
  const files = listSourceFiles(SCAN_ROOT);

  it('ST-4: 走査の対象にダッシュボードを含む組織の管理画面のソースがある (空の走査で通らない)', () => {
    expect(files).toContain(DASHBOARD_FILE);
    const dashboardCopy = collectCopy(DASHBOARD_FILE, fs.readFileSync(path.join(ROOT, DASHBOARD_FILE), 'utf8'));
    expect(dashboardCopy.map((finding) => finding.text)).toContain(DASHBOARD_SUBTITLE);
  });

  it('ST-5: src/app/(org) 配下のどの画面の文字にも、止めている機能を思わせる語が無い', () => {
    const violations = files.flatMap((file) =>
      findStoppedFeatureWords(collectCopy(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))),
    );
    expect(violations).toEqual([]);
  });

  it('ST-6: 走査は以前の副題を見つける (見張りが効いていることの確かめ)。コメントの中の語は数えない', () => {
    const sample = [
      '// 以前の副題は「組織のバイタルサインと生産性指標」だった',
      'export const Page = () => (',
      `  <p>${REMOVED_SUBTITLE}</p>`,
      ');',
      "const notice = '集計は準備中です';",
    ].join('\n');
    const violations = findStoppedFeatureWords(collectCopy('sample.tsx', sample));

    expect(violations).toEqual([
      `sample.tsx:3「バイタル」 (${REMOVED_SUBTITLE})`,
      `sample.tsx:3「生産性」 (${REMOVED_SUBTITLE})`,
      'sample.tsx:5「準備中」 (集計は準備中です)',
    ]);
  });
});
