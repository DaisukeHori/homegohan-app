/**
 * 「献立を改善」の画面側の配線テスト (#1138)
 *
 * app/menus/weekly/index.tsx は大きく、jest で描画して確かめるのが難しい。
 * 以前のバグは「画面が存在しない API を呼ぶモーダルをそのまま置いていた」という配線の問題だったため、
 * ここではソースを読んで、次の 3 点が外れていないことを固定する。
 *   1. 改善モーダルの 2 つの置き場 (weekly 画面 / 栄養分析の詳細) が、どちらも handleImprove につながっている
 *   2. handleImprove が既存の v4 生成 (useV4MenuGeneration) を使う
 *   3. モバイルのどのコードも、サーバーに存在しない /api/ai/menu/meal/improve を参照していない
 * 挙動そのものは improve-meal*.test / nutrition-detail-improve.test / use-v4-menu-generation.test が確かめる。
 */

import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const PAGE_PATH = path.join(MOBILE_ROOT, 'app/menus/weekly/index.tsx');
const page = fs.readFileSync(PAGE_PATH, 'utf8');

/** `<Tag ... />` の開始から最初の `/>` までを取り出す (対象のモーダルは props の中に `/>` を含まない) */
function jsxElement(source: string, tag: string): string {
  const start = source.indexOf(`<${tag}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('/>', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('weekly 画面: 献立を改善の配線', () => {
  it('改善モーダル (weekly 画面側) が handleImprove につながっている', () => {
    const element = jsxElement(page, 'ImproveMealModal');
    expect(element).toContain('onSubmit={handleImprove}');
    expect(element).toContain('advice={improveAdvice}');
  });

  it('栄養分析の詳細モーダルが handleImprove につながっている (改善モーダルを内側に持つため必須)', () => {
    const element = jsxElement(page, 'NutritionDetailModal');
    expect(element).toContain('onImprove={handleImprove}');
  });

  it('栄養分析 (StatsModal) から改善を開くとき、表示中の AI 栄養士の提案を改善モーダルへ渡す', () => {
    const element = jsxElement(page, 'StatsModal');
    expect(element).toContain('onOpenImprove={(advice) =>');
    expect(element).toContain('setImproveAdvice(advice ?? null)');
  });

  it('handleImprove は submitImprove 経由で、既存の v4 生成 (v4Generate) を呼ぶ', () => {
    const start = page.indexOf('const handleImprove = useCallback(');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = page.slice(start, page.indexOf('}, [pendingRequestId, v4Generate]);', start));
    expect(body).toContain('submitImprove(');
    expect(body).toContain('generate: v4Generate');
    // 生成中かどうかは、この画面が進捗を追っている生成の有無で判定する
    expect(body).toContain('isBusy: pendingRequestId !== null');
  });

  it('handleImprove が過去の日付の判定に渡す「今日」は、画面と同じ Asia/Tokyo の todayLocal() (端末の new Date() ではない)', () => {
    const start = page.indexOf('const handleImprove = useCallback(');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = page.slice(start, page.indexOf('}, [pendingRequestId, v4Generate]);', start));
    // コメントでの言及 (経緯の説明) は許し、コードだけを見る
    const code = body.replace(/\/\/.*$/gm, '');
    expect(code).toContain('today: todayLocal(),');
    expect(code).not.toMatch(/new Date\(/);
    expect(code).not.toContain('formatLocalDate');
    // 挙動そのもの (UTC の端末で JST の昨日が過去として拒否される) は weekly-page-dates.test.tsx が確かめる
  });

  it('V4 生成モーダルの生成中表示は、完了しても戻らないフックの isGenerating ではなく pendingRequestId で決める', () => {
    const element = jsxElement(page, 'V4GenerateModal');
    expect(element).toContain('isGenerating={pendingRequestId !== null}');
    expect(page).not.toContain('isV4Generating');
  });
});

describe('モバイルのコード全体', () => {
  it('サーバーに存在しない /api/ai/menu/meal/improve を呼ぶコード (文字列リテラル) が無い', () => {
    // コメントでの言及 (経緯の説明) は許し、API の呼び出しに使う文字列リテラルだけを見る
    const literal = /['"`]\/api\/ai\/menu\/meal\/improve/;
    const offenders = [...walk(path.join(MOBILE_ROOT, 'app')), ...walk(path.join(MOBILE_ROOT, 'src'))]
      .filter((file) => literal.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(MOBILE_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('この確認自体が正しく働く: 修正前のコードの書き方 (api.post の呼び出し) は検出される', () => {
    const literal = /['"`]\/api\/ai\/menu\/meal\/improve/;
    expect(literal.test("await api.post('/api/ai/menu/meal/improve', { date })")).toBe(true);
    expect(literal.test('// 以前は存在しない API (POST /api/ai/menu/meal/improve) を呼んでいた')).toBe(false);
  });
});
