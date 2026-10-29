// src/__tests__/app/menus/weekly/dish-favorite-wiring.test.ts
// #2011 (docs/design/cross/22-dish-favorites.md §7.9):
//   献立の料理のモーダルの ♥ は、dish_favorites の API (GET /api/favorites/status・POST /api/favorites・
//   DELETE /api/favorites/{id}) を呼ぶ。♥ の状態はモーダルが開くたびに引き直し、取得中は ♥ を disabled にする。
//   status・POST・DELETE の応答は、送った時点の「モーダルの回」(favoriteSessionRef) が今の回と同じときだけ
//   ♥ の印・favoriteId・取得中の印に入れる (押したあとに閉じて別の料理を開くと、前の料理の応答が今の料理の印と id を
//   書き換えるため)。
//
// page.tsx は巨大なクライアントコンポーネントで全体を描けないので、request-watch-guard.test.ts と同じくソースを検査する。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PAGE_TSX_PATH = path.resolve(__dirname, '../../../../app/(main)/menus/weekly/page.tsx');
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

/** コメントの行を除いたソース (経緯のコメントに当たらないように、コードの行だけを検査する) */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join('\n');
}

const pageCode = stripCommentLines(pageSource);

/** start から始まり、その後で最初に end が現れるところまで (end を含む) のコード */
function sliceBetween(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  if (from < 0) throw new Error(`開始の印が見つからない: ${start}`);
  const to = code.indexOf(end, from);
  if (to < 0) throw new Error(`終わりの印が見つからない: ${end}`);
  return code.slice(from, to + end.length);
}

/** start から、その後で最初に end が現れる手前まで (end を含まない) のコード */
function sliceBefore(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  if (from < 0) throw new Error(`開始の印が見つからない: ${start}`);
  const to = code.indexOf(end, from);
  if (to < 0) throw new Error(`終わりの印が見つからない: ${end}`);
  return code.slice(from, to);
}

const STATUS_EFFECT_START = 'favoriteSessionRef.current += 1;';
const STATUS_EFFECT_END = '}, [selectedRecipe, isRecipeModalOpen]);';
const statusEffectCode = sliceBetween(pageCode, STATUS_EFFECT_START, STATUS_EFFECT_END);
const toggleCode = sliceBefore(pageCode, 'const handleToggleFavorite = async () => {', 'const addRecipeToShoppingList');

/** try の本体 (catch より前) と、catch・finally の部分 */
const toggleTryCode = sliceBefore(toggleCode, 'try {', '} catch {');
const toggleCatchFinallyCode = toggleCode.slice(toggleCode.indexOf('} catch {'));

/** 応答のあとに状態を変える呼び出し (♥ の印・id・取得中の印・alert) */
const STATE_WRITE_PATTERN = /\b(setIsFavorite|setFavoriteId|setIsFavoriteLoading|alert)\(/;

describe('献立の ♥ の配線 (dish_favorites。#2011)', () => {
  it('W-1「status の effect はモーダルの回 (favoriteSessionRef) を進め、依存は [selectedRecipe, isRecipeModalOpen] (同じ料理を開き直しても引き直す)」', () => {
    // 回の印は useRef の数で、モーダルが開いているかは activeModal と selectedRecipe の両方で決める
    expect(pageCode).toMatch(/const favoriteSessionRef = useRef\(0\);/);
    expect(pageCode).toMatch(/const isRecipeModalOpen = activeModal === 'recipe' && selectedRecipe !== null;/);

    // effect の先頭で回を進め (useEffect の本体の最初の文)、その回を控える
    const effectAt = pageCode.indexOf(STATUS_EFFECT_START);
    expect(pageCode.slice(0, effectAt)).toMatch(/useEffect\(\(\) => \{\s*$/);
    expect(statusEffectCode).toMatch(/^favoriteSessionRef\.current \+= 1;\s*const session = favoriteSessionRef\.current;/);

    // 閉じている (または料理が無い) ときは取得中の印を下ろして何も送らない
    const closedBranch = sliceBetween(statusEffectCode, 'if (!isRecipeModalOpen || !selectedRecipe) {', 'return;');
    expect(closedBranch).toContain('setIsFavoriteLoading(false);');
    expect(closedBranch).not.toContain('fetch(');

    // 開いているときは取得中の印を立ててから名前で status を引く
    const loadingAt = statusEffectCode.indexOf('setIsFavoriteLoading(true);');
    const fetchAt = statusEffectCode.indexOf('fetch(`/api/favorites/status?name=${encodeURIComponent(selectedRecipe)}`)');
    expect(loadingAt).toBeGreaterThan(statusEffectCode.indexOf('if (!isRecipeModalOpen || !selectedRecipe) {'));
    expect(fetchAt).toBeGreaterThan(loadingAt);

    // 依存は selectedRecipe と isRecipeModalOpen の 2 つ (status の effect はこの 1 つだけ)
    expect(statusEffectCode.endsWith(STATUS_EFFECT_END)).toBe(true);
    expect(pageCode.split(STATUS_EFFECT_START).length - 1).toBe(1);
  });

  it('W-2「status の応答は回が同じときだけ setIsFavorite・setFavoriteId・setIsFavoriteLoading(false) を呼ぶ」', () => {
    const thenBlock = sliceBetween(statusEffectCode, '.then((data:', '})');
    const guardAt = thenBlock.indexOf('if (favoriteSessionRef.current !== session || !data) return;');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    const setFavoriteAt = thenBlock.indexOf('setIsFavorite(data.favorited === true);');
    const setIdAt = thenBlock.indexOf("setFavoriteId(typeof data.id === 'string' ? data.id : null);");
    expect(setFavoriteAt).toBeGreaterThan(guardAt);
    expect(setIdAt).toBeGreaterThan(guardAt);

    // 取得中の印を下ろすのは finally で、回が同じときだけ (失敗・例外でも下ろす)
    expect(statusEffectCode).toMatch(
      /\.finally\(\(\) => \{ if \(favoriteSessionRef\.current === session\) setIsFavoriteLoading\(false\); \}\);/,
    );

    // 応答の側 (fetch より後) で状態を変える呼び出しは、上の 3 つだけ
    const afterFetch = statusEffectCode.slice(statusEffectCode.indexOf('fetch('));
    const writes = afterFetch.match(new RegExp(STATE_WRITE_PATTERN.source, 'g')) ?? [];
    expect(writes).toEqual(['setIsFavorite(', 'setFavoriteId(', 'setIsFavoriteLoading(']);
  });

  it('W-3「handleToggleFavorite は押した時点の回を控え、DELETE・POST・res.json の await のあとで isCurrentSession() を見てから setIsFavorite・setFavoriteId・alert を呼ぶ」', () => {
    // 押した時点の回を控える (try より前)
    const beforeTry = toggleCode.slice(0, toggleCode.indexOf('try {'));
    expect(beforeTry).toContain('const session = favoriteSessionRef.current;');
    expect(beforeTry).toContain('const isCurrentSession = () => favoriteSessionRef.current === session;');

    // DELETE は id で、POST は料理の写しで
    expect(toggleTryCode).toContain("await fetch(`/api/favorites/${encodeURIComponent(favoriteId)}`, { method: 'DELETE' });");
    expect(toggleTryCode).toMatch(/await fetch\('\/api\/favorites', \{ method: 'POST'/);
    expect(toggleTryCode).toContain('dishSnapshotFromMenuDish(');

    // await は 3 つ (DELETE・POST・成功の res.json) と、失敗の本文の res.json の 1 つ
    const lines = toggleTryCode.split('\n');
    const awaitLines = lines.map((line, i) => (line.includes('await ') ? i : -1)).filter((i) => i >= 0);
    expect(awaitLines).toHaveLength(4);

    // 各 await の次の行は、回がまだ続いているかを見る
    for (const i of awaitLines) {
      expect(lines[i + 1]).toContain('isCurrentSession()');
    }

    // 最初の await より後で状態を変える行は、直前の await との間 (その行を含む) で回を見ている
    const firstAwait = awaitLines[0];
    const writeLines = lines.map((line, i) => (i > firstAwait && STATE_WRITE_PATTERN.test(line) ? i : -1)).filter((i) => i >= 0);
    expect(writeLines.length).toBeGreaterThanOrEqual(4);
    for (const i of writeLines) {
      const lastAwait = Math.max(...awaitLines.filter((a) => a < i));
      const between = lines.slice(lastAwait + 1, i + 1).join('\n');
      expect(between, `行 ${lines[i].trim()} の前に isCurrentSession() が無い`).toContain('isCurrentSession()');
    }

    // alert は回が同じときだけ・サーバーの文 (err.error) だけを出す
    expect(toggleTryCode).toContain('if (isCurrentSession() && err?.error) alert(err.error);');
  });

  it('W-4「handleToggleFavorite の catch と finally は isCurrentSession() のときだけ setIsFavorite(prev)・setIsFavoriteLoading(false) を呼ぶ」', () => {
    expect(toggleCatchFinallyCode).toMatch(
      /^\} catch \{\s*if \(isCurrentSession\(\)\) setIsFavorite\(prev\);\s*\} finally \{\s*if \(isCurrentSession\(\)\) setIsFavoriteLoading\(false\);\s*\}\s*\};/,
    );
    // catch・finally に回を見ない書き込みが無い
    const writes = toggleCatchFinallyCode.split('\n').filter((line) => STATE_WRITE_PATTERN.test(line));
    expect(writes).toHaveLength(2);
    for (const line of writes) expect(line).toContain('if (isCurrentSession())');
  });

  it('W-5「page.tsx は /api/recipes/…/like を呼ばず、/api/favorites/status・/api/favorites・/api/favorites/{id} を呼ぶ」', () => {
    expect(pageCode).not.toMatch(/\/api\/recipes\/[^\n]*\/like/);
    expect(pageCode).toContain('/api/favorites/status?name=');
    expect(pageCode).toMatch(/fetch\('\/api\/favorites', \{ method: 'POST'/);
    expect(pageCode).toMatch(/fetch\(`\/api\/favorites\/\$\{encodeURIComponent\(favoriteId\)\}`, \{ method: 'DELETE' \}\)/);
    // 写しの source_planned_meal_id のため、料理を開くときに食事の id を渡す
    expect(pageCode).toContain('plannedMealId: meal.id,');
  });
});
