// src/__tests__/app/menus/weekly/photo-result-refetch-wiring.test.ts
// Issue #2047:
//   週間献立の「写真から入力」(analyzePhotoWithAI) は、mealId つきで /api/ai/analyze-meal-photo を呼ぶ。route の 200 は
//   「Edge が背景で解析を始めた」で、解析 (10〜20 秒) はまだ終わっていない。以前の画面は「写真解析は同期的に行われる」という前提で、
//   200 のすぐあとに 1 回だけ献立を読み直し、解析の前の献立を画面とキャッシュに置いていた (結果は開き直すまで出なかった)。
//   → 結果が書かれたことが分かるまで、上限つきで読み直す (src/lib/meal-photo-result-watch.ts の waitForMealPhotoResult)。
//     上限で止まったら、その旨を出す。待っているあいだは写真から入力のモーダルの「AIが解析中...」を出したままにする。
//
// page.tsx は巨大なクライアントコンポーネントで、全体の描画での検証は現実的でないため、既存の配線テスト
// (poll-tick-watch-guard.test.ts・ux2-02-remaining-alerts-wiring.test.ts) と同じくソースを検査する。
// 待ち方そのもの (上限・結果の見分け) は tests/meal-photo-result-watch.test.ts が見る。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PAGE_TSX_PATH = path.resolve(__dirname, '../../../../app/(main)/menus/weekly/page.tsx');
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

/** 行コメントを除く (経緯のコメントに当たらないように、コードだけを検査する) */
function stripLineComments(text: string): string {
  return text.replace(/\/\/.*$/gm, '');
}

/** marker のあとの最初の '{' から、対応する '}' まで */
function blockAfter(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`印が見つからない: ${marker}`);
  let depth = 0;
  let bodyStart = -1;
  for (let i = at; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      if (depth === 0) bodyStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && bodyStart !== -1) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`終端が見つからない: ${marker}`);
}

const analyzeBody = blockAfter(pageSource, 'const analyzePhotoWithAI = async () => {');
const analyzeCode = stripLineComments(analyzeBody);
/** route が 200 を返したあとの分岐 */
const okBranch = stripLineComments(blockAfter(analyzeBody, 'if (res.ok) {'));

describe('写真から入力: 解析が終わってから献立を読み直す (#2047)', () => {
  it('「写真解析は同期的に行われる」前提のコメントと、200 のすぐあとの 1 回だけの読み直しが無い', () => {
    expect(analyzeBody).not.toContain('同期的に行われる');
    expect(okBranch).not.toContain('pollRes');
  });

  it('200 のあとは waitForMealPhotoResult で結果を待ってから、献立を画面とキャッシュに置く', () => {
    const waitAt = okBranch.indexOf('await waitForMealPhotoResult(');
    expect(waitAt).toBeGreaterThanOrEqual(0);
    expect(okBranch.indexOf('setCurrentPlan(newPlan)')).toBeGreaterThan(waitAt);
    expect(okBranch.indexOf('weekDataCache.current.set(targetDate')).toBeGreaterThan(waitAt);
    // 200 の分岐の中で、待つ前に献立を読まない
    expect(okBranch.slice(0, waitAt)).not.toMatch(/fetch\(/);
  });

  it('結果を比べる元 (頼む前の献立) は、解析を頼む前に控える', () => {
    const baselineAt = analyzeCode.indexOf('photoResultBaseline(');
    const requestAt = analyzeCode.indexOf("aiFetch('/api/ai/analyze-meal-photo'");
    expect(baselineAt).toBeGreaterThanOrEqual(0);
    expect(requestAt).toBeGreaterThan(baselineAt);
  });

  it('待っているあいだはモーダルを閉じず「解析中」を出したまま: 200 の分岐で、待つ前にモーダル・写真・解析中を片づけない', () => {
    const waitAt = okBranch.indexOf('await waitForMealPhotoResult(');
    const beforeWait = okBranch.slice(0, waitAt);
    expect(beforeWait).not.toContain('setActiveModal(null)');
    expect(beforeWait).not.toContain('setPhotoFiles([])');
    expect(beforeWait).not.toContain('endPhotoAnalyze()');
    // 待ち終えたら、モーダルは「まだ解析を頼んだ回のものなら」閉じる (利用者が開いた別のモーダル・開き直したモーダルを閉じない)
    expect(okBranch).not.toContain('setActiveModal(null)');
    expect(okBranch).not.toContain('MODAL_CLOSE_PHOTO_EDIT_FOR_MEAL');
    expect(okBranch.indexOf("dispatchModal({ type: 'MODAL_CLOSE_PHOTO_EDIT_SESSION', payload: session })")).toBeGreaterThan(waitAt);
    expect(okBranch.indexOf('endPhotoAnalyze()')).toBeGreaterThan(waitAt);
  });

  it('上限で止まったら黙って終えず、その旨を出す (閉じたら献立を読み直す)。献立が消えていたらその旨を出す', () => {
    expect(okBranch).toMatch(/outcome\.status === 'timeout'\) \{\s*setSuccessMessage\(\{\s*title: PHOTO_RESULT_TIMEOUT_TITLE,\s*message: PHOTO_RESULT_TIMEOUT_MESSAGE,[\s\S]*?refreshOnDismiss: true/);
    expect(okBranch).toMatch(/outcome\.status === 'meal_missing'\) \{\s*setSuccessMessage\(\{\s*title: PHOTO_RESULT_MEAL_MISSING_TITLE,\s*message: PHOTO_RESULT_MEAL_MISSING_MESSAGE/);
  });

  it('待っているあいだに週が変わっていたら、解析を頼んだ週の献立を画面に置かない', () => {
    const guardAt = okBranch.indexOf('if (formatLocalDate(displayedWeekStartRef.current) === targetDate) {');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    const guarded = blockAfter(okBranch.slice(guardAt), 'if (');
    expect(guarded).toContain('setCurrentPlan(newPlan)');
    expect(guarded).toContain('updateCalendarMealDatesFromDailyMeals(dailyMeals)');
  });
});

describe('写真の解析の結果を待つ監視の印 (#2047。#1657 の印と同じ形)', () => {
  it('新しい印を置く前に前の印を下ろし、待ち終えたら印が下りていないかを確かめてから置く', () => {
    const lowerAt = okBranch.indexOf('if (photoResultWatchRef.current) photoResultWatchRef.current.active = false;');
    const createAt = okBranch.indexOf('const photoResultWatch = { active: true };');
    const assignAt = okBranch.indexOf('photoResultWatchRef.current = photoResultWatch;');
    const waitAt = okBranch.indexOf('await waitForMealPhotoResult(');
    expect(lowerAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(lowerAt);
    expect(assignAt).toBeGreaterThan(createAt);
    expect(waitAt).toBeGreaterThan(assignAt);
    expect(okBranch).toContain('isActive: () => photoResultWatch.active');
    const guardAt = okBranch.indexOf("if (outcome.status === 'cancelled' || !photoResultWatch.active) return;");
    expect(guardAt).toBeGreaterThan(waitAt);
    expect(okBranch.indexOf('setCurrentPlan(newPlan)')).toBeGreaterThan(guardAt);
  });

  it('アンマウントで印を下ろす', () => {
    const unmountAt = pageSource.indexOf('// コンポーネントアンマウント時にクリーンアップ');
    expect(unmountAt).toBeGreaterThanOrEqual(0);
    const unmountCode = blockAfter(pageSource.slice(unmountAt), 'return () => {');
    expect(unmountCode).toContain('photoResultWatchRef.current.active = false;');
    expect(unmountCode).toContain('photoResultWatchRef.current = null;');
  });
});

describe('写真から入力のモーダルの回 (#2047: 待つあいだに開いた別のモーダルを、待ち始めたときのモーダルと見分ける)', () => {
  it('解析は一度に 1 つ: 解析中なら始めない。始めるときに、写真を送ったモーダルの回を控えてから解析中にする', () => {
    const guardAt = analyzeCode.indexOf('if (isAnalyzingPhoto) return;');
    const sessionAt = analyzeCode.indexOf('const session = photoEditSession;');
    const startAt = analyzeCode.indexOf('startPhotoAnalyze(session);');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(sessionAt).toBeGreaterThan(guardAt);
    expect(startAt).toBeGreaterThan(sessionAt);
    // 回を持たない「解析中にする」だけの経路を残さない
    expect(pageSource).not.toContain("dispatchAiGen({ type: 'PHOTO_ANALYZE_START' })");
    expect(pageSource).not.toContain('setIsAnalyzingPhoto(');
  });

  it('モーダルの「解析中」は、そのモーダルの回で送った写真のときだけ。ほかの回で送った写真なら other を渡す', () => {
    const modalAt = pageSource.indexOf('<PhotoEditModal');
    expect(modalAt).toBeGreaterThanOrEqual(0);
    const modalProps = pageSource.slice(modalAt, pageSource.indexOf('/>', pageSource.indexOf('onAnalyze={analyzePhotoWithAI}', modalAt)));
    expect(modalProps).toContain("isAnalyzingPhoto={photoEditAnalyzeState === 'own'}");
    expect(modalProps).toContain("isOtherPhotoAnalyzing={photoEditAnalyzeState === 'other'}");
    expect(pageSource).toContain('const photoEditAnalyzeState = photoAnalyzeStateForSession(aiGen, photoEditSession);');
  });

  it('写真から入力のモーダルは、手で変更のモーダルからも openPhotoEdit で開く (開くたびに新しい回・写真は空から)', () => {
    const openBody = stripLineComments(blockAfter(pageSource, 'const openPhotoEdit = (meal: PlannedMeal) => {'));
    expect(openBody).toContain("dispatchModal({ type: 'MODAL_OPEN_PHOTO_EDIT', payload: meal });");
    expect(openBody).toContain('setPhotoFiles([]);');
    expect(openBody).toContain('setPhotoPreviews([]);');
    expect(pageSource).toContain('onOpenPhotoEdit={() => openPhotoEdit(manualEditMeal)}');
    // 回を進めずに写真から入力のモーダルを開く経路を残さない
    expect(stripLineComments(pageSource)).not.toContain("setActiveModal('photoEdit')");
  });
});
