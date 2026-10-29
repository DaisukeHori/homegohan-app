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
 *   1. ai-api-messages.ts の文の定数と、文を作る関数の戻り値が、どれも日本語 (英語だけの文でない) で、括弧の外に英字の項目名・値が無い
 *      (englishIdentifiersOutsideParentheses。関数の戻り値は route の走査 (tests/api-error-english-field-names.test.ts) が読まないので、
 *      ここで export された全部の関数を値で確かめる。食事の区分の文は v4 / v5 が渡す 5 値を差し込む)
 *   2. 文を作る関数が、数・位置・日付の範囲を文に入れる (手で書いた期待値と突き合わせる)
 *   3. AI の全 route と相談の提案の実行 (src/lib/ai/consultation-action-executor.ts) の、どこかのオブジェクトの error / message に直接書いた文
 *      (v4 / v5 の枠の検証の戻り値・提案の実行の結果を含む) と、検証の失敗の文 (`errors.push(…)` の引数・`errors: [...]` の要素。
 *      提案の実行では `errors.join` を通して result.error に入る) に、英語だけの文が残っていない
 *      (提案の実行の結果に実際に出る文は tests/consultation-action-validation-messages.test.ts が確かめる)
 *   4. 3 と同じ所の文に、括弧の外の英字の項目名・値が無い (#1917 の続き。テンプレートの式の部分は値を読まずに印
 *      UNRESOLVED_SUBSTITUTION にするので、括弧の外に式を差し込む文は違反になる。項目の名前は ai-api-messages.ts の
 *      aiConsultation* の関数・AI_CONSULTATION_* の定数で作り、その戻り値と値は 1 と 2 で確かめる)。
 *      以前は提案の実行の 'date は必須です'・'mealIdが指定されていません'・`${key} は数値で指定してください` が
 *      この見張りの外にあり、英字の項目名が括弧の外に出ていた
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MEAL_ORDER } from '@homegohan/shared';
import * as messages from '@/lib/ai/ai-api-messages';
import {
  englishIdentifiersOutsideParentheses,
  isEnglishOnly,
  JAPANESE,
  routeFilesUnder,
  sourceOf,
  UNRESOLVED_SUBSTITUTION,
} from './helpers/api-error-text-scan';

/** 見張る AI の route の根 */
const API_AI_ROUTES_ROOT = 'src/app/api/ai';

/** 受け付ける日付の範囲 (手で書いた期待値。isCalendarDate の範囲と同じ) */
const DATE_RANGE_JA = 'YYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付';

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
    expect(messages.aiInvalidDateMessage('開始日')).toBe(`開始日は${DATE_RANGE_JA}で指定してください`);
    expect(messages.aiRequiredFieldMessage('日付')).toBe('日付を指定してください');
  });

  it('献立の生成の枠の文は、位置 (1 から数える)・数・区分を入れた日本語の文', () => {
    expect(messages.aiTargetSlotsTooManyMessage(93, 31, 3)).toBe('献立を作る枠は 93 個 (31 日 × 3 食) までです');
    expect(messages.aiTargetSlotsSpanTooLongMessage(31)).toBe('献立を作る期間は、最初の日から最後の日まで含めて 31 日以内にしてください');
    expect(messages.aiTargetSlotNotObjectMessage(0)).toBe('1 番目の枠の指定が正しくありません');
    expect(messages.aiTargetSlotDateInvalidMessage(2)).toBe(`3 番目の枠の日付は${DATE_RANGE_JA}で指定してください`);
    // 受け付ける英字の値は括弧の中に ' / ' で並べる (#1917 の続き。以前は「… の食事の区分は breakfast・lunch のどれかにしてください」で、英字の値が括弧の外に出ていた)
    expect(messages.aiTargetSlotMealTypeInvalidMessage(1, ['breakfast', 'lunch'])).toBe(
      '2 番目の枠の食事の区分 (mealType) は次のいずれかを指定してください (breakfast / lunch)',
    );
    expect(messages.aiTargetSlotPlannedMealIdInvalidMessage(4)).toBe('5 番目の枠の献立の指定が正しくありません');
    expect(messages.aiTargetSlotDuplicateMessage('2026-10-10', 'dinner')).toBe('同じ枠 (2026-10-10 の dinner) が 2 回指定されています');
  });

  it('相談の提案の実行の文は、項目を「日本語の名前 (キー)」の形にし、数を入れた日本語の文 (#1917 の続き)', () => {
    expect(messages.aiConsultationFieldLabel('dish_name')).toBe('料理名 (dish_name)');
    expect(messages.aiConsultationFieldLabel('startDate')).toBe('開始日 (startDate)');
    // 表に無いキーも、括弧の外は日本語にする
    expect(messages.aiConsultationFieldLabel('unknown_key')).toBe('項目 (unknown_key)');
    // プロトタイプのキーで表の外の値を引かない
    expect(messages.aiConsultationFieldLabel('constructor')).toBe('項目 (constructor)');
    expect(messages.aiConsultationNonEmptyTextMaxMessage('item_name', 200)).toBe('品名 (item_name) は 1〜200 文字の文字列で指定してください');
    expect(messages.aiConsultationOptionalTextMaxMessage('memo', 1000)).toBe('メモ (memo) は 1000 文字以内の文字列か null で指定してください');
    expect(messages.aiConsultationNumberMessage('sodium_g')).toBe('食塩相当量 (sodium_g) は数値で指定してください');
    expect(messages.aiConsultationRangeMessage('daily_calories', 500, 6000)).toBe(
      '1 日のエネルギー (daily_calories) は 500 〜 6000 の範囲で指定してください',
    );
    expect(messages.aiConsultationNumberRangeMessage('fat_g', 0, 300)).toBe('脂質 (fat_g) は 0 〜 300 の範囲の数値で指定してください');
    expect(messages.AI_CONSULTATION_DISHES_NOT_ARRAY_MESSAGE).toBe('料理の一覧 (dishes) は配列で指定してください');
    expect(messages.AI_CONSULTATION_IMAGE_URL_NOT_STRING_MESSAGE).toBe('画像の URL (image_url) は文字列で指定してください');
    expect(messages.AI_CONSULTATION_DATE_REQUIRED_MESSAGE).toBe('日付 (date) を指定してください');
    expect(messages.AI_CONSULTATION_START_DATE_REQUIRED_MESSAGE).toBe('開始日 (startDate) を指定してください');
    expect(messages.AI_CONSULTATION_DATE_AND_MEAL_TYPE_REQUIRED_MESSAGE).toBe('日付 (date) と食事の区分 (mealType) を指定してください');
    expect(messages.AI_CONSULTATION_MEAL_ID_REQUIRED_MESSAGE).toBe('献立 (mealId) を指定してください');
    expect(messages.aiConsultationSingleMealStartedMessage('2026-10-10', 'midnight_snack')).toBe('2026-10-10の夜食を生成中...');
  });

  /**
   * 文を作る関数ごとの戻り値 (関数の名前 → 戻り値)。差し込む値は、本番で入る値 (食事の区分は v4 / v5 が渡す正本 MEAL_ORDER の 5 値・
   * 重複の枠は英字の区分の値) にする。ai-api-messages.ts に関数を足したら、ここにも足す (下の it が export の一覧との一致を確かめる)
   */
  const FUNCTION_OUTPUTS: Readonly<Record<string, string>> = {
    aiInvalidDateMessage: messages.aiInvalidDateMessage('日付'),
    aiRequiredFieldMessage: messages.aiRequiredFieldMessage('日付'),
    aiTargetSlotsTooManyMessage: messages.aiTargetSlotsTooManyMessage(1, 1, 1),
    aiTargetSlotsSpanTooLongMessage: messages.aiTargetSlotsSpanTooLongMessage(1),
    aiTargetSlotNotObjectMessage: messages.aiTargetSlotNotObjectMessage(0),
    aiTargetSlotDateInvalidMessage: messages.aiTargetSlotDateInvalidMessage(0),
    aiTargetSlotMealTypeInvalidMessage: messages.aiTargetSlotMealTypeInvalidMessage(0, MEAL_ORDER),
    aiTargetSlotPlannedMealIdInvalidMessage: messages.aiTargetSlotPlannedMealIdInvalidMessage(0),
    aiTargetSlotDuplicateMessage: messages.aiTargetSlotDuplicateMessage('2026-10-10', 'lunch'),
    // 相談の提案の実行の文 (表に無いキーでも括弧の外は日本語)
    aiConsultationFieldLabel: messages.aiConsultationFieldLabel('unknown_key'),
    aiConsultationNonEmptyTextMaxMessage: messages.aiConsultationNonEmptyTextMaxMessage('dish_name', 1),
    aiConsultationOptionalTextMaxMessage: messages.aiConsultationOptionalTextMaxMessage('quantity', 1),
    aiConsultationNumberMessage: messages.aiConsultationNumberMessage('protein_g'),
    aiConsultationRangeMessage: messages.aiConsultationRangeMessage('fiber_g', 0, 1),
    aiConsultationNumberRangeMessage: messages.aiConsultationNumberRangeMessage('carbs_g', 0, 1),
    // 食事の区分は v4 / v5 と同じ正本 MEAL_ORDER の 5 値を全部入れる (英字の値が文に出ないこと)
    aiConsultationSingleMealStartedMessage: MEAL_ORDER.map((mealType) =>
      messages.aiConsultationSingleMealStartedMessage('2026-10-10', mealType),
    ).join(' / '),
  };

  it('文を作る関数の戻り値の一覧は、ai-api-messages.ts が export する関数を全部持つ (足した関数が下の確かめから漏れない)', () => {
    const exportedFunctions = Object.entries(messages)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    expect(Object.keys(FUNCTION_OUTPUTS).sort()).toEqual(exportedFunctions.sort());
  });

  it('文を作る関数の戻り値は、どれも英語だけの文でなく、括弧の外に英字の項目名・値が無い (#1917 の続き)', () => {
    for (const [name, text] of Object.entries(FUNCTION_OUTPUTS)) {
      expect(isEnglishOnly(text), name).toBe(false);
      expect(englishIdentifiersOutsideParentheses(text), `${name}: ${text}`).toEqual([]);
    }
  });

  it('判定は、以前の食事の区分の文 (英字の値を括弧の外に並べた形) を拾う (上の確かめが空振りしない)', () => {
    expect(englishIdentifiersOutsideParentheses('2 番目の枠の食事の区分は breakfast・lunch・midnight_snack のどれかにしてください')).toEqual([
      'breakfast',
      'lunch',
      'midnight_snack',
    ]);
  });

  it('文の定数 (*_MESSAGE と日付の条件) も、括弧の外に英字の項目名・値が無い', () => {
    for (const [name, text] of stringEntries.filter(([key]) => !key.endsWith('_CODE'))) {
      expect(englishIdentifiersOutsideParentheses(text), `${name}: ${text}`).toEqual([]);
    }
  });
});

describe('走査が見ない所の文にも、英語だけの文が残っていない', () => {
  /** 文字列・テンプレートの文字の部分 (テンプレートは `${i}` などの式の部分を除いてつなぐ)。文字列でなければ null */
  function literalTextOf(node: ts.Node): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
    return null;
  }

  /** プロパティの名前 (識別子・文字列の名前だけ。計算した名前は null) */
  function propertyNameOf(node: ts.PropertyAssignment): string | null {
    return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
  }

  /** 検証の失敗の文を積む配列の名前 (errors・mealUpdateErrors など。名前の終わりが errors) */
  const ERRORS_ARRAY_NAME = /errors$/i;

  /**
   * テンプレートの式の部分を値として読まずに印 (UNRESOLVED_SUBSTITUTION) にした文 (文字列はそのまま)。文字列でなければ null。
   * 括弧の外に式を差し込む文 (`${key} は数値で指定してください`) は、印が括弧の外の英字の項目名として拾われる。
   * 括弧の中の式 (`… (${values.join(' / ')})`) は括弧ごと外れるので拾わない
   */
  function markedTextOf(node: ts.Node): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans.map((span) => ` ${UNRESOLVED_SUBSTITUTION} ${span.literal.text}`).join('');
    }
    return null;
  }

  /**
   * ファイルの中で、失敗の文として本文・結果に入る所に直接書いた文字列・テンプレートのうち、check が違反とするもの。
   *   - どこかのオブジェクトの `error` / `message` のプロパティ (本文を作る呼び出しの外: 相談の提案の実行の結果 `result = { error: … }`・
   *     v4 / v5 の枠の検証の戻り値 `{ valid: false, error: … }`)
   *   - 検証の失敗の文を積む配列への `errors.push(…)` の引数と、`{ errors: [...] }` の要素 (提案の実行の検証の戻り値。`errors.join` で result.error に入る)
   */
  function textViolations(
    file: string,
    sf: ts.SourceFile,
    render: (node: ts.Node) => string | null,
    isViolation: (text: string) => boolean,
  ): string[] {
    const found: string[] = [];
    const check = (node: ts.Node) => {
      const trimmed = render(node)?.replace(/\s+/g, ' ').trim();
      if (trimmed && isViolation(trimmed)) {
        found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} 「${trimmed}」`);
      }
    };
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node)) {
        const name = propertyNameOf(node);
        if (name === 'error' || name === 'message') check(node.initializer);
        if (name !== null && ERRORS_ARRAY_NAME.test(name) && ts.isArrayLiteralExpression(node.initializer)) {
          node.initializer.elements.forEach(check);
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'push' &&
        ts.isIdentifier(node.expression.expression) &&
        ERRORS_ARRAY_NAME.test(node.expression.expression.text)
      ) {
        node.arguments.forEach(check);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  /** 英語だけの文 (テンプレートは式の部分を除いて文字の部分をつなぐ) */
  function englishTextProperties(file: string, sf: ts.SourceFile = sourceOf(file)): string[] {
    return textViolations(file, sf, literalTextOf, isEnglishOnly);
  }

  /** 括弧の外に英字の項目名・値 (テンプレートの式の部分の印を含む) がある文 (#1917 の続き) */
  function englishIdentifierTexts(file: string, sf: ts.SourceFile = sourceOf(file)): string[] {
    return textViolations(file, sf, markedTextOf, (text) => englishIdentifiersOutsideParentheses(text).length > 0);
  }

  it('見張りの部品が、error / message・errors.push・errors: [...] の文字列とテンプレートの英語の文を拾い、日本語の文と errors 以外の配列は拾わない (例: 以前の v4 の枠の検証の文・提案の実行の検証の文)', () => {
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
        'function g(key: string, input: unknown) {',
        '  const errors: string[] = [];',
        '  const mealUpdateErrors: string[] = [];',
        "  if (!input) return { data: {}, errors: ['updates must be an object', '日付を指定してください'] };",
        "  errors.push('dish_name must be a non-empty string (max 200 chars)');",
        '  errors.push(`${key} must be a finite number`);',
        '  mealUpdateErrors.push(`${key} は数値で指定してください`);',
        "  names.push('not an error text');",
        '  return { data: {}, errors };',
        '}',
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(englishTextProperties('fixture.ts', fixture)).toEqual([
      'fixture.ts:2 「targetSlots[ ] is not an object」',
      'fixture.ts:3 「date must be in YYYY-MM-DD format」',
      'fixture.ts:4 「Generation started」',
      'fixture.ts:11 「updates must be an object」',
      'fixture.ts:12 「dish_name must be a non-empty string (max 200 chars)」',
      'fixture.ts:13 「must be a finite number」',
    ]);
  });

  it('見張りの部品が、括弧の外の英字の項目名と、括弧の外に差し込む式を拾い、括弧の中の項目名・式と日本語だけの文は拾わない (例: 以前の提案の実行の文)', () => {
    const fixture = ts.createSourceFile(
      'fixture.ts',
      [
        'function f(key: string, values: string[], date: string, mealType: string) {',
        '  const errors: string[] = [];',
        "  if (key === 'a') return { error: 'date は必須です' };",
        "  if (key === 'b') return { error: 'mealIdが指定されていません' };",
        "  if (key === 'c') return { error: '日付 (date) を指定してください' };",
        '  if (key === \'d\') return { error: `食事の区分 (mealType) は次のいずれかを指定してください (${values.join(\' / \')})` };',
        '  if (key === \'e\') return { message: `${date}の${mealType}を生成中...` };',
        "  errors.push('dishes は配列で指定してください');",
        '  errors.push(`${key} は数値で指定してください`);',
        "  errors.push('献立を指定してください');",
        "  return { data: {}, errors: ['target_value と target_unit は空にできません', '目標値 (target_value) は空にできません'] };",
        '}',
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(englishIdentifierTexts('fixture.ts', fixture)).toEqual([
      'fixture.ts:3 「date は必須です」',
      'fixture.ts:4 「mealIdが指定されていません」',
      `fixture.ts:7 「${UNRESOLVED_SUBSTITUTION} の ${UNRESOLVED_SUBSTITUTION} を生成中...」`,
      'fixture.ts:8 「dishes は配列で指定してください」',
      `fixture.ts:9 「${UNRESOLVED_SUBSTITUTION} は数値で指定してください」`,
      'fixture.ts:11 「target_value と target_unit は空にできません」',
    ]);
  });

  const SCANNED_FILES = [...routeFilesUnder(API_AI_ROUTES_ROOT), 'src/lib/ai/consultation-action-executor.ts'];

  it.each(SCANNED_FILES)('%s の error / message の文', (file) => {
    expect(englishTextProperties(file)).toEqual([]);
  });

  it.each(SCANNED_FILES)('%s の error / message の文に、括弧の外の英字の項目名・値が無い (#1917 の続き)', (file) => {
    expect(englishIdentifierTexts(file)).toEqual([]);
  });

  it('AI の route を走査している', () => {
    expect(routeFilesUnder(API_AI_ROUTES_ROOT)).toContain('src/app/api/ai/menu/v4/generate/route.ts');
  });
});
