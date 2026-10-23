// @vitest-environment node
/**
 * AI の API (src/app/api/ai/**) の本文の文 (src/lib/ai/ai-api-messages.ts) の見張り (#1917 の ai の配下)
 *
 * 問題:
 *   AI の API は route ごとに 'Image is required'・'Meal not found'・'targetSlots[0] is not an object' のような英語の文を返し、
 *   画面 (食事の記録・献立表・AI 相談) とモバイルがそのまま出していた。route の本文は tests/api-error-japanese-scan.test.ts が走査で見張るが、
 *   走査は関数の戻り値 (aiTargetSlotDateInvalidMessage(i) など) と、route の外のファイル (相談の提案の実行の結果) の文を見ない。
 *
 * このテストが確かめること:
 *   1. ai-api-messages.ts の文の定数と、文を作る関数の戻り値が、どれも日本語 (英語だけの文でない)
 *   2. 文を作る関数が、数・位置・日付の範囲を文に入れる (手で書いた期待値と突き合わせる)
 *   3. AI の全 route と相談の提案の実行 (src/lib/ai/consultation-action-executor.ts) の、どこかのオブジェクトの error / message に直接書いた文
 *      (v4 / v5 の枠の検証の戻り値・提案の実行の結果を含む) に、英語だけの文が残っていない
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as messages from '@/lib/ai/ai-api-messages';
import { isEnglishOnly, JAPANESE, routeFilesUnder, sourceOf } from './helpers/api-error-text-scan';

/** 見張る AI の route の根 */
const API_AI_ROUTES_ROOT = 'src/app/api/ai';

/** 受け付ける日付の範囲 (手で書いた期待値。isCalendarDate の範囲と同じ) */
const DATE_RANGE_JA = 'YYYY-MM-DD の形の実在する日付 (0101-01-02〜9998-12-30)';

describe('ai-api-messages.ts の文は日本語', () => {
  const stringEntries = Object.entries(messages).filter((entry): entry is [string, string] => typeof entry[1] === 'string');

  it('文の定数 (*_MESSAGE と日付の条件) は、どれも日本語を含み、英語だけの文でない', () => {
    const texts = stringEntries.filter(([name]) => !name.endsWith('_CODE'));
    expect(texts.length).toBeGreaterThan(0);
    for (const [name, text] of texts) {
      expect(JAPANESE.test(text), name).toBe(true);
      expect(isEnglishOnly(text), name).toBe(false);
    }
  });

  it('写真の読み取りの code は従来の値のまま (画面・ログが読む)', () => {
    expect(messages.AI_PHOTO_MODE_MISMATCH_CODE).toBe('mode_mismatch');
    expect(messages.AI_PHOTO_UNKNOWN_TYPE_CODE).toBe('unknown_type');
  });

  it('日付の条件は、受け付ける範囲を書いた日本語の文', () => {
    expect(messages.AI_CALENDAR_DATE_REQUIREMENT_JA).toBe(DATE_RANGE_JA);
    expect(messages.aiInvalidDateMessage('開始日')).toBe(`開始日は ${DATE_RANGE_JA} で指定してください`);
    expect(messages.aiRequiredFieldMessage('日付')).toBe('日付を指定してください');
  });

  it('献立の生成の枠の文は、位置 (1 から数える)・数・区分を入れた日本語の文', () => {
    expect(messages.aiTargetSlotsTooManyMessage(93, 31, 3)).toBe('献立を作る枠は 93 個 (31 日 × 3 食) までです');
    expect(messages.aiTargetSlotsSpanTooLongMessage(31)).toBe('献立を作る期間は、最初の日から最後の日まで含めて 31 日以内にしてください');
    expect(messages.aiTargetSlotNotObjectMessage(0)).toBe('1 番目の枠の指定が正しくありません');
    expect(messages.aiTargetSlotDateInvalidMessage(2)).toBe(`3 番目の枠の日付は ${DATE_RANGE_JA} で指定してください`);
    expect(messages.aiTargetSlotMealTypeInvalidMessage(1, ['breakfast', 'lunch'])).toBe(
      '2 番目の枠の食事の区分は breakfast・lunch のどれかにしてください',
    );
    expect(messages.aiTargetSlotPlannedMealIdInvalidMessage(4)).toBe('5 番目の枠の献立の指定が正しくありません');
    expect(messages.aiTargetSlotDuplicateMessage('2026-10-10', 'dinner')).toBe('同じ枠 (2026-10-10 の dinner) が 2 回指定されています');
  });

  it('文を作る関数の戻り値は、どれも英語だけの文でない', () => {
    const outputs = [
      messages.aiInvalidDateMessage('日付'),
      messages.aiRequiredFieldMessage('日付'),
      messages.aiTargetSlotsTooManyMessage(1, 1, 1),
      messages.aiTargetSlotsSpanTooLongMessage(1),
      messages.aiTargetSlotNotObjectMessage(0),
      messages.aiTargetSlotDateInvalidMessage(0),
      messages.aiTargetSlotMealTypeInvalidMessage(0, ['breakfast']),
      messages.aiTargetSlotPlannedMealIdInvalidMessage(0),
      messages.aiTargetSlotDuplicateMessage('2026-10-10', 'lunch'),
    ];
    for (const text of outputs) expect(isEnglishOnly(text), text).toBe(false);
  });
});

describe('走査が見ない所の文にも、英語だけの文が残っていない', () => {
  /**
   * ファイルの中の、どこかのオブジェクトの `error` / `message` のプロパティに直接書いた文字列・テンプレートのうち、英語だけのもの
   * (本文を作る呼び出しの外: 相談の提案の実行の結果 `result = { error: … }`・v4 / v5 の枠の検証の戻り値 `{ valid: false, error: … }`)。
   * テンプレートは文字の部分だけをつないで判定する (`${i}` などの式の部分は見ない)
   */
  function englishTextProperties(file: string, sf: ts.SourceFile = sourceOf(file)): string[] {
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        (node.name.text === 'error' || node.name.text === 'message')
      ) {
        const init = node.initializer;
        let text: string | null = null;
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) text = init.text;
        else if (ts.isTemplateExpression(init)) text = [init.head.text, ...init.templateSpans.map((span) => span.literal.text)].join(' ');
        const trimmed = text?.replace(/\s+/g, ' ').trim();
        if (trimmed && isEnglishOnly(trimmed)) {
          found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} 「${trimmed}」`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  it('見張りの部品が、文字列とテンプレートの英語の文を拾い、日本語の文は拾わない (例: 以前の v4 の枠の検証の文)', () => {
    const fixture = ts.createSourceFile(
      'fixture.ts',
      [
        'function f(i: number) {',
        '  if (i > 1) return { valid: false, error: `targetSlots[${i}] is not an object` };',
        "  if (i > 2) return { error: 'date must be in YYYY-MM-DD format' };",
        "  if (i > 3) return { message: 'Generation started' };",
        "  if (i > 4) return { error: `${i} 番目の枠の指定が正しくありません` };",
        "  return { error: '日付を指定してください', reason: 'not checked' };",
        '}',
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(englishTextProperties('fixture.ts', fixture)).toEqual([
      'fixture.ts:2 「targetSlots[ ] is not an object」',
      'fixture.ts:3 「date must be in YYYY-MM-DD format」',
      'fixture.ts:4 「Generation started」',
    ]);
  });

  it.each([...routeFilesUnder(API_AI_ROUTES_ROOT), 'src/lib/ai/consultation-action-executor.ts'])('%s の error / message の文', (file) => {
    expect(englishTextProperties(file)).toEqual([]);
  });

  it('AI の route を走査している', () => {
    expect(routeFilesUnder(API_AI_ROUTES_ROOT)).toContain('src/app/api/ai/menu/v4/generate/route.ts');
  });
});
