// @vitest-environment node
/**
 * 設計書の 1 冊の中で、同じ事実の指し先 (行番号・基準の sha) が 1 つにそろうことの contract テスト (ソース走査)。#2025 の続き (docs-1026b)
 *
 * docs-1026b の設計書の直し (R1) の形: marketing/01 は冊の全体 (§2.2) と §4.1 の頭の段落で file:line の基準を origin/main `ab201cc6` と
 * 名指すのに、§4.1 の `photo-entrances` の行の analyzePhotoWithAI を今の main の `:4330` に書き換え、同じ節の献立表の「写真から入力」の行は
 * 基準の `:4323` のまま残り、1 冊の中で値が 2 つに分かれた。
 * 「すべて基準の値のまま」と「すべて同じ今の行」のどちらも通し、値が分かれたときだけ赤にする (tests/helpers/design-doc-fact-consistency.ts)。
 * あわせて、冊が基準の sha を名指す間は、その sha の時点の行番号のままであることを見る (R1 は marketing/01 §4.1 の根拠の行と
 * billing/03 §2.4 の行を、基準の宣言を残したまま、そろえて今の main の行に書き換えた。値はそろっていても宣言と食い違う)。
 * 確かめる事実と冊は tests/helpers/design-doc-facts-2025.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFactValues, findSplitFactValues } from './helpers/design-doc-fact-consistency';
import {
  BASIS_PINNED_FACTS_2025,
  DESIGN_DOC_FACTS_2025,
  readAnalyzePhotoWithAiLine,
  readBillingFoundationSha,
  readMarketingBasisSha,
  readNutritionFeedbackModelLine,
  readPraiseCommentPromptLine,
  readMobileGetApiErrorMessageRange,
  readOpenShoppingListLine,
  readShoppingListRegenerateCallLine,
  readSupportUserListLastLoginLine,
  readSupportUserLoginCountLine,
} from './helpers/design-doc-facts-2025';

const ROOT = path.resolve(__dirname, '..');

describe('marketing/01 の事実の取り出し', () => {
  it('基準の sha を、冊の全体の宣言と §4.1 の頭の段落の両方から読む', () => {
    expect(readMarketingBasisSha('本書の事実 (file:line・番兵の中身・他の文書の行) の基準は origin/main `ab201cc6`。')).toEqual(['ab201cc6']);
    expect(readMarketingBasisSha('「根拠」の file:line は origin/main `ab201cc6` の行で、`evidence` には')).toEqual(['ab201cc6']);
    expect(readMarketingBasisSha('「origin/main `f0dff7a9`」と書いた記録')).toEqual([]);
  });

  it('analyzePhotoWithAI の行を、主張の表の 2 つの書き方から読み、R1 の形 (4330 と 4323) は分かれたとして返す', () => {
    const doc = [
      '| `photo-entrances` | … | 献立表の「写真から入力」`src/app/(main)/menus/weekly/page.tsx:4330` (`analyzePhotoWithAI`) とモーダル |',
      '| 献立表の「写真から入力」(`src/app/(main)/menus/weekly/page.tsx:4323` の `analyzePhotoWithAI`。モーダルの題 |',
    ].join('\n');
    expect(collectFactValues(doc, readAnalyzePhotoWithAiLine)).toEqual([
      { line: 1, value: '4330' },
      { line: 2, value: '4323' },
    ]);
    expect(findSplitFactValues(collectFactValues(doc, readAnalyzePhotoWithAiLine))).toEqual(['4330: 1', '4323: 2']);
  });

  it('「買い物リストを開く」の行を、主張の表 (「…」の直後) と画面の表 (`…` の後の括弧) の両方から読む', () => {
    expect(readOpenShoppingListLine('献立表の「買い物リストを開く」`src/app/(main)/menus/weekly/page.tsx:5649` → シート')).toEqual(['5649']);
    expect(readOpenShoppingListLine('`/menus/weekly` で `買い物リストを開く` (`src/app/(main)/menus/weekly/page.tsx:5649`) を押して')).toEqual([
      '5649',
    ]);
  });

  it('/api/shopping-list/regenerate を呼ぶ行を、§2.5 と §4.1 の書き方から読む (同じ行の regenerateShoppingList の行は拾わない)', () => {
    expect(
      readShoppingListRegenerateCallLine('作成も作り直しも、献立表の画面がこの 1 つの API を呼ぶ: `src/app/(main)/menus/weekly/page.tsx:3398`。'),
    ).toEqual(['3398']);
    expect(
      readShoppingListRegenerateCallLine(
        '`regenerateShoppingList` (`menus/weekly/page.tsx:3358`。同意の確認は `:3372`) が `/api/shopping-list/regenerate` を呼ぶ (`:3398`。',
      ),
    ).toEqual(['3398']);
  });
});

describe('cross/16・cross/13b の事実の取り出し', () => {
  it('support の画面の行を、行番号の後の注の括弧 (origin/main の sha の行) があっても読む', () => {
    const line =
      '→ Web `src/app/(support)/support/users/page.tsx:307` (origin/main `2f97b3dd7` の行) の「n回」と、…。Web の support の一覧 `src/app/(support)/support/users/page.tsx:227` (origin/main `2f97b3dd7` の行) の「最終ログイン: …」は';
    expect(readSupportUserLoginCountLine(line)).toEqual(['307']);
    expect(readSupportUserListLastLoginLine(line)).toEqual(['227']);
    expect(readSupportUserLoginCountLine('それを描く `src/app/(support)/support/users/page.tsx:307` (詳細の「n回」)')).toEqual(['307']);
    expect(readSupportUserListLastLoginLine('| A | `src/app/(support)/support/users/page.tsx:227` (一覧の「最終ログイン: …」)')).toEqual(['227']);
    expect(readSupportUserListLastLoginLine('Web の support の一覧 (`src/app/(support)/support/users/page.tsx:227`) は、#1717 で')).toEqual(['227']);
  });

  it('getApiErrorMessage の範囲を読み、同じ行の getJapaneseApiErrorMessage の範囲は拾わない', () => {
    expect(
      readMobileGetApiErrorMessageRange(
        'を Alert に出す (`apps/mobile/src/lib/api-error.ts:82-85` の `getJapaneseApiErrorMessage` (origin/main `2f97b3dd7` の行)。本文の `error` は `:38-68` の `getApiErrorMessage` が読む)',
      ),
    ).toEqual(['38-68']);
    expect(readMobileGetApiErrorMessageRange('| Error の message から本文の文を取り出す `getApiErrorMessage` (平たい文字列も読む) | `apps/mobile/src/lib/api-error.ts:38-68` |')).toEqual([
      '38-68',
    ]);
    expect(readMobileGetApiErrorMessageRange('HTTP の番号を持たない (`httpStatusOfApiError` が `undefined`。`api-error.ts:78-83`)')).toEqual([]);
  });
});

describe('冊が名指す基準の sha の時点の行番号 (基準を取り直さずに値だけ今の main の行にしない)', () => {
  it('billing/03 の土台の sha と、原価の表の model の行を読む', () => {
    expect(readBillingFoundationSha('| 土台 | origin/main `4b1e1abe` (#1911 のマージ。`66d02c5d` で cross/20 が入った後)。')).toEqual(['4b1e1abe']);
    expect(readBillingFoundationSha('| 版 | origin/main `4b1e1abe` |')).toEqual([]);
    expect(readNutritionFeedbackModelLine('| `nutrition_advice` (栄養士のコメント) | OpenAI `gpt-5.2` (`src/app/api/ai/nutrition/feedback/route.ts:112`) | 同上 |')).toEqual(['112']);
    expect(readPraiseCommentPromptLine('献立の振り返りは `src/app/api/ai/nutrition/feedback/route.ts:94` の指示「良い点を見つけて褒める。…」')).toEqual(['94']);
  });

  for (const fact of BASIS_PINNED_FACTS_2025) {
    it(`${fact.doc} の「${fact.name}」は、基準 ${fact.basis} の時点の行`, () => {
      const doc = fs.readFileSync(path.join(ROOT, fact.doc), 'utf8');
      const bases = collectFactValues(doc, fact.readBasis).map((mention) => mention.value);
      // 冊が基準を取り直したなら、値を新しい基準で確かめ直して、この表 (tests/helpers/design-doc-facts-2025.ts) も直す
      expect([...new Set(bases)], `${fact.doc} が名指す基準の sha`).toEqual([fact.basis]);
      const mentions = collectFactValues(doc, fact.read);
      expect(mentions.length, `${fact.doc} で「${fact.name}」を述べる箇所の数`).toBeGreaterThanOrEqual(1);
      expect(
        mentions.filter((mention) => mention.value !== fact.valueAtBasis),
        `${fact.doc} の「${fact.name}」が基準 ${fact.basis} の時点の行 (:${fact.valueAtBasis}) と違う`,
      ).toEqual([]);
    });
  }
});

describe('#2025 の続き (docs-1026b) で確かめた事実が、冊の中でそろう', () => {
  for (const fact of DESIGN_DOC_FACTS_2025) {
    it(`${fact.doc} の「${fact.name}」`, () => {
      const doc = fs.readFileSync(path.join(ROOT, fact.doc), 'utf8');
      const mentions = collectFactValues(doc, fact.read);
      // 取り出しの形が冊の書き方からずれて、何も見なくなっていないこと
      expect(mentions.length, `${fact.doc} で「${fact.name}」を述べる箇所の数`).toBeGreaterThanOrEqual(fact.minMentions);
      expect(findSplitFactValues(mentions), `${fact.doc} の「${fact.name}」が箇所によって違う`).toEqual([]);
    });
  }
});
