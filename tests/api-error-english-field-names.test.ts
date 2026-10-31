// @vitest-environment node
/**
 * API の失敗の本文の文に、英字の項目名・役割名を括弧の外に出さないことの見張り (#1917 の続き)
 *
 * 問題:
 *   全 API の走査 (tests/api-error-japanese-scan.test.ts) は「日本語を 1 文字も含まない文」だけを違反にするので、
 *   'id の形式が正しくありません'・'family_id は必須です'・'永久 BAN は super_admin のみ実行可能です' のように、
 *   日本語の文に英字の項目名・役割名だけが混じった文は通る。異常な入力のときだけ、こうした文が画面に出うる。
 *   /api/org だけは tests/org-api-error-role-names.test.ts が見ていたが、ほかの配下には見張りが無かった。
 *
 * 決まり:
 *   項目名は「日本語の名前 (英字の項目名)」の形で、英字の項目名を括弧に入れて添える (src/lib/health-api-messages.ts の
 *   healthFieldLabel・'日付 (date)' と同じ形)。API を呼ぶ人が直す場所を探せるように英字の項目名は残すが、括弧の外は日本語にする。
 *
 * このテストが確かめること (構文木で読む。コメントとログの文は見ない):
 *   1. 判定 (englishIdentifiersOutsideParentheses) と走査 (findErrorTexts) が、以前の文と自前の本文の関数の文を拾い、
 *      括弧に入れた項目名・大文字の語・形式の名前・JSON の値は拾わない
 *   2. src/app/api の全 route (相手が機械の配下を除く) の失敗の本文の文に、括弧の外の英字の項目名・役割名が無い
 *   3. 自前の本文の関数の一覧 (ROUTE_ERROR_TEXT_CALLS) の関数が実在し、その位置の引数が文 (message) である
 *   4. src/lib・src/schemas・packages の Zod の検証の文 (validationMessageOf などが日本語の文をそのまま本文の message にする) にも、
 *      括弧の外の英字の項目名が無い (findValidationMessageTexts。応答の形の検査で画面に出ない文は ZOD_TEXT_EXEMPT_FILES に理由つき)
 *   5. src/lib の関数・表が作って本文に流す文 (BAN を断る文・食事の入力の検証・プランのキーの文・二段階認証の画面の表) を値で確かめる
 *   6. 2 と 4 の走査は、テンプレートの式の部分 (`${…}`) を値として読む (定数・配列の定数の join・数はたどって値にし、
 *      読み取れない式は英字の項目名の形の印 UNRESOLVED_SUBSTITUTION にする)。キー・状態・種類の値のような英字が入りうる式を括弧の外に
 *      差し込むと違反になる (以前の `公開中プランでは ${keys.join(', ')} は変更できません`・`${from} から ${to} への遷移`)。
 *      数・日本語の文だと分かっている読み取れない式だけを、TEMPLATE_SUBSTITUTION_EXEMPT に理由つきで載せる
 * 限界: 本文の文を表 (オブジェクト) から引くもの・関数の戻り値で作るもの・入力の検証の関数が返す文は、4 と 5 に挙げたもの以外は見ない
 *   (健康の記録の入力の検証は tests/health-api-messages.test.ts が、通知の設定の文は tests/notification-preferences.test.ts が、
 *   プランの状態・項目の文は tests/plan-status-transition.test.ts が、AI の API の文を作る関数 (献立の生成の枠の食事の区分の文など) は
 *   tests/ai-api-error-messages.test.ts が、埋め込みの再生成の成功の文は tests/embeddings-regenerate-route.test.ts が値で確かめる)。
 *   AI 相談の提案の実行 (src/lib/ai/consultation-action-executor.ts。route の外) の result.error と検証の失敗の文は、
 *   tests/ai-api-error-messages.test.ts が同じ判定 (englishIdentifiersOutsideParentheses) で走査し、
 *   tests/consultation-action-validation-messages.test.ts が実行の結果の値で確かめる (#1917 の続き)。
 *   見張りであって網羅の証明ではない。
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  API_ROUTES_ROOT,
  englishIdentifiersOutsideParentheses,
  findErrorTexts,
  findValidationMessageTexts,
  isUnderDir,
  routeFilesUnder,
  sourceOf,
  substitutionKey,
  UNRESOLVED_SUBSTITUTION,
  walkFiles,
  type SubstitutionOptions,
} from './helpers/api-error-text-scan';
import { MACHINE_FACING_ERROR_TEXT_PATHS } from './helpers/api-error-japanese-scope';
import {
  PERMANENT_BAN_SUPER_ADMIN_ONLY_MESSAGE,
  SUPER_ADMIN_BAN_REJECTED_MESSAGE,
  SUPER_ADMIN_FREEZE_REJECTED_MESSAGE,
} from '@/lib/admin/user-ban';
import {
  MEAL_TYPE_MESSAGE,
  PLANNED_MEAL_NUTRIENT_FIELDS,
  validatePlannedMealInput,
} from '@/lib/planned-meal-validation';
import {
  ORG_PLAN_KEY_PREFIX_MESSAGE,
  PERSONAL_FAMILY_PLAN_KEY_MESSAGE,
  PRICE_APPLIES_TO_MESSAGE,
} from '@/lib/super-admin/plans-schemas';
import { MFA_ERROR_MESSAGES } from '@/lib/auth/mfa/client';
import { MODERATION_TYPE_INVALID_MESSAGE } from '@/lib/admin/moderation-schemas';
import { PLAN_READ_ONLY_MESSAGE } from '@/lib/super-admin/ai-daily-limits';

/**
 * route の中で失敗の本文を作る自前の関数と、その文の引数の位置 (0 から数える)。
 * 走査の部品の既定 (challengeError) に加えて見る。新しく `function xxx(status, code, message)` のような関数で本文を作るなら、ここに足す
 */
const ROUTE_ERROR_TEXT_CALLS: ReadonlyMap<string, number> = new Map([
  ['errorResponse', 2],
  ['errorBody', 1],
  ['errorJson', 1],
  ['badRequest', 0],
  ['notSupportedResponse', 0],
]);
/** 自前の本文の関数を探す配下 */
const TEXT_CALL_SOURCE_DIRS = ['src/app/api', 'src/lib'] as const;
/** 本文の文を受け取る引数の名前 */
const MESSAGE_PARAMETER_NAME = 'message';

const isMachineFacing = (file: string) =>
  MACHINE_FACING_ERROR_TEXT_PATHS.some(({ path: p }) => file === p || isUnderDir(file, p));

/**
 * テンプレートの式のうち、値を読み取れないが英字の項目名・値にならないもの (substitutionKey(ファイル, 式の字面) → 理由)。
 * 走査は読み取れない式を印 (UNRESOLVED_SUBSTITUTION) にして、括弧の外にあれば違反にする。
 * 理由は「式の値が数・日本語の文である」ことに限る。英字の値 (キー・状態・種類の値) が入りうる式は、ここに足さずに括弧に入れるか日本語の名前にする
 */
const TEMPLATE_SUBSTITUTION_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    substitutionKey('src/app/api/storage/signed-urls/route.ts', 'MAX_PHOTO_URL_LENGTH'),
    '画像の URL の文字数の上限 (数)。@homegohan/shared の定数で、走査は package の import をたどらない',
  ],
  [substitutionKey('src/app/api/menu-plans/add/route.ts', 'maxOffsetDays'), '開始日のずれの日数の上限 (数。menuPlansAddMaxDateOffsetDays() の戻り値)'],
  [substitutionKey('src/app/api/org/challenges/route.ts', 'meta.targetMin'), 'チャレンジの目標値の下限 (数。ORG_CHALLENGE_TYPE_META の targetMin)'],
  [substitutionKey('src/app/api/org/challenges/route.ts', 'meta.targetMax'), 'チャレンジの目標値の上限 (数。ORG_CHALLENGE_TYPE_META の targetMax)'],
]);
const SUBSTITUTIONS: SubstitutionOptions = { exempt: TEMPLATE_SUBSTITUTION_EXEMPT };

const violationsOf = (files: readonly string[]) =>
  files
    .flatMap((file) => findErrorTexts(file, { extraTextCalls: ROUTE_ERROR_TEXT_CALLS, substitutions: SUBSTITUTIONS }))
    .filter((found) => englishIdentifiersOutsideParentheses(found.text).length > 0)
    .map((found) => `${found.file}:${found.line} 「${found.text}」`);

describe('判定: 括弧の外の英字の項目名・役割名', () => {
  it('以前の文を拾う', () => {
    expect(englishIdentifiersOutsideParentheses('id の形式が正しくありません')).toEqual(['id']);
    expect(englishIdentifiersOutsideParentheses('family_id と to_user_id は必須です')).toEqual(['family_id', 'to_user_id']);
    expect(englishIdentifiersOutsideParentheses('永久 BAN は super_admin のみ実行可能です')).toEqual(['super_admin']);
    expect(englishIdentifiersOutsideParentheses('指定した owner は退会の手続き中です')).toEqual(['owner']);
    expect(englishIdentifiersOutsideParentheses('ratingは1〜5の整数で入力してください')).toEqual(['rating']);
    expect(englishIdentifiersOutsideParentheses('daily_note は文字列か null で指定してください')).toEqual(['daily_note']);
    // camelCase の項目名も拾う
    expect(englishIdentifiersOutsideParentheses('periodType は daily のいずれかを指定してください')).toEqual(['periodType', 'daily']);
    expect(englishIdentifiersOutsideParentheses('sourceCode が不正です')).toEqual(['sourceCode']);
  });

  it('括弧に入れた項目名・大文字の語・形式の名前・JSON の値・日本語を含まない文は拾わない', () => {
    for (const ok of [
      'ID (id) の形式が正しくありません',
      '家族のグループ (family_id) と譲渡先の利用者 (to_user_id) は必須です',
      '永久 BAN はスーパー管理者 (super_admin) のみ実行可能です',
      '日付 (date)はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください',
      '1 日のメモ (daily_note) は文字列か null で指定してください',
      '通知 (enabled) は true か false で指定してください',
      '下書き (draft) のプランは PATCH API で価格を変更してください',
      '通知のトークン (expo_push_token) が Expo の通知のトークンの形ではありません',
      '全角の括弧の中（family_id）も括弧の中',
      '入れ子 (外 (family_id) の中) も括弧の中',
      'eGFR (mL/min/1.73m²) は数値で指定してください',
      'Unauthorized',
    ]) {
      expect(englishIdentifiersOutsideParentheses(ok), ok).toEqual([]);
    }
  });
});

describe('走査: 自前の本文の関数の文も集める', () => {
  const FIXTURE_FILE = 'src/app/api/__fixture__/route.ts';
  const FIXTURE = `
    import { NextResponse } from 'next/server';
    function errorResponse(status: number, code: string, message: string) {
      return NextResponse.json({ error: { code, message } }, { status });
    }
    export async function POST() {
      if (a) return errorResponse(400, 'VALIDATION_ERROR', 'id が不正です');
      if (b) return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'family_id は必須です' } }, { status: 400 });
      if (c) return NextResponse.json({ error: '組織の名前 (name) は必須です' }, { status: 400 });
      console.error('family_id のログは見ない');
      return NextResponse.json({ ok: true });
    }
  `;

  it('route の本文の文と errorResponse の文を拾い、括弧に入れた項目名とログは拾わない', () => {
    const found = findErrorTexts(FIXTURE_FILE, { extraTextCalls: ROUTE_ERROR_TEXT_CALLS, text: FIXTURE })
      .filter((f) => englishIdentifiersOutsideParentheses(f.text).length > 0)
      .map((f) => f.text);
    expect(found.sort()).toEqual(['family_id は必須です', 'id が不正です'].sort());
  });

  it('既定の走査 (追加の関数なし) は errorResponse の文を見ない (追加の一覧が要る理由)', () => {
    const texts = findErrorTexts(FIXTURE_FILE, { text: FIXTURE }).map((f) => f.text);
    expect(texts).not.toContain('id が不正です');
    expect(texts).toContain('family_id は必須です');
  });
});

describe('自前の本文の関数の一覧 (ROUTE_ERROR_TEXT_CALLS) は実在する', () => {
  const files = TEXT_CALL_SOURCE_DIRS.flatMap((dir) => walkFiles(dir, (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)));

  // 同じ名前で文を受け取らない関数もある (csp-report の badRequest(status, code) など。文の位置に文字列が来ないので走査に影響しない)。
  // 文を受け取る宣言 (message の引数を持つもの) は、どれも一覧の位置に message を持つ
  it.each([...ROUTE_ERROR_TEXT_CALLS])('%s は、%i 番目 (0 から) の引数が message の関数として宣言されている', (name, index) => {
    const messagePositions: number[] = [];
    for (const file of files) {
      for (const statement of sourceOf(file).statements) {
        if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== name) continue;
        const position = statement.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === MESSAGE_PARAMETER_NAME);
        if (position >= 0) messagePositions.push(position);
      }
    }
    expect(messagePositions.length, name).toBeGreaterThan(0);
    expect(messagePositions.every((position) => position === index), `${name}: ${messagePositions.join(', ')}`).toBe(true);
  });
});

describe('src/app/api の失敗の本文の文に、括弧の外の英字の項目名・役割名が無い', () => {
  const files = routeFilesUnder(API_ROUTES_ROOT).filter((file) => !isMachineFacing(file));

  it('走査する route がある (健康の記録・家族・運営・super_admin を含む)', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'src/app/api/health/checkups/[id]/route.ts',
        'src/app/api/family/members/[member_id]/remove/route.ts',
        'src/app/api/admin/organizations/route.ts',
        'src/app/api/super-admin/settings/route.ts',
      ]),
    );
  });

  /** 以前にテンプレートで英字の値を括弧の外に差し込んでいた route と、直したあとの文 (走査が式の部分を値として読めていることを確かめる) */
  const FIXED_TEMPLATE_TEXTS: ReadonlyArray<readonly [string, string]> = [
    ['src/app/api/admin/moderation/[type]/[id]/route.ts', MODERATION_TYPE_INVALID_MESSAGE],
    ['src/app/api/admin/moderation/[type]/[id]/restore/route.ts', MODERATION_TYPE_INVALID_MESSAGE],
    ['src/app/api/comparison/trigger/route.ts', '比べる期間の種類 (periodType) は次のいずれかを指定してください (daily / weekly / monthly)'],
    [
      'src/app/api/super-admin/embeddings/regenerate/route.ts',
      '対象の表 (table) は次のいずれかを指定してください (dataset_ingredients / dataset_recipes / dataset_menu_sets)',
    ],
    ['src/app/api/super-admin/llm/quotas/route.ts', PLAN_READ_ONLY_MESSAGE],
    ['src/app/api/super-admin/flags/[key]/route.ts', `このフラグは次の機能のパッケージで使用中のため削除できません ( ${UNRESOLVED_SUBSTITUTION} )`],
    // ロールの呼び名を運営の画面の表示名の定数 (OPERATOR_ROLE_LABELS.super_admin・SUPER_ADMIN_ONLY_NOTE) から作る文 (#2134 U1-1)
    ['src/app/api/admin/users/[id]/freeze/route.ts', PERMANENT_BAN_SUPER_ADMIN_ONLY_MESSAGE],
    ['src/app/api/admin/users/[id]/freeze/route.ts', SUPER_ADMIN_FREEZE_REJECTED_MESSAGE],
    ['src/app/api/admin/moderation/[type]/[id]/route.ts', PERMANENT_BAN_SUPER_ADMIN_ONLY_MESSAGE],
  ];

  it.each(FIXED_TEMPLATE_TEXTS)('走査は %s の直した文「%s」を、式の部分を値にして集める', (file, text) => {
    expect(files).toContain(file);
    expect(findErrorTexts(file, { extraTextCalls: ROUTE_ERROR_TEXT_CALLS, substitutions: SUBSTITUTIONS }).map((found) => found.text)).toContain(
      text,
    );
    expect(englishIdentifiersOutsideParentheses(text)).toEqual([]);
  });

  it('違反が 0 件', () => {
    expect(violationsOf(files)).toEqual([]);
  });
});

/** Zod の検証の文を探す配下 (route の中の Zod も見る。相手が機械の配下は除く) */
const ZOD_TEXT_SOURCE_DIRS = ['src/lib', 'src/schemas', 'src/app/api', 'packages/shared/src', 'packages/core/src'] as const;
/**
 * Zod の検証の文を見ないファイルと理由 (画面に出ないもの)。
 * 理由は「その Zod の失敗が本文の文にならない」ことに限る。画面に出うる文は、ここに足さずに直す
 */
const ZOD_TEXT_EXEMPT_FILES: ReadonlyMap<string, string> = new Map([
  [
    'src/lib/legal-consent-api.ts',
    'GET /api/legal/status が自分の応答の形を確かめる検査 (LegalConsentStatusSchema)。食い違えば internalError の 500 で、文は本文に出ずログに残るだけ',
  ],
]);

const isTypeScriptSource = (name: string) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name);

describe('走査: Zod の検証の文を集める (findValidationMessageTexts)', () => {
  const FIXTURE_FILE = 'src/lib/__fixture__/schemas.ts';
  const FIXTURE = `
    import { z } from 'zod';
    const KEY_MESSAGE = 'plan_key の形が違います';
    export const S = z
      .object({
        id: z.string().uuid({ message: 'id は UUID 形式で指定してください' }),
        status: z.enum(['a', 'b'], { message: '状態 (status) の値が不正です' }),
        key: z.string().regex(/^[a-z]+$/, KEY_MESSAGE),
        from: z.string().min(1, 'from は必須です'),
      })
      .refine((v) => v.id !== v.key, { message: 'cursor が不正です', path: ['id'] });
    export function log() {
      console.error('family_id のログは見ない');
    }
  `;

  it('文字列の引数・message のオプション・import しない同じファイルの const を拾い、括弧に入れた項目名とログは拾わない', () => {
    const found = findValidationMessageTexts(FIXTURE_FILE, { text: FIXTURE })
      .filter((f) => englishIdentifiersOutsideParentheses(f.text).length > 0)
      .map((f) => f.text);
    expect(found.sort()).toEqual(
      ['cursor が不正です', 'from は必須です', 'id は UUID 形式で指定してください', 'plan_key の形が違います'].sort(),
    );
  });
});

describe('Zod の検証の文に、括弧の外の英字の項目名が無い (src/lib・src/schemas・src/app/api・packages)', () => {
  const files = ZOD_TEXT_SOURCE_DIRS.flatMap((dir) => walkFiles(dir, isTypeScriptSource)).filter(
    (file) => !isMachineFacing(file) && !/(^|\/)__tests__\//.test(file),
  );

  /** 以前に違反があったファイルと、直したあとの文 (走査が実のファイルの Zod の文に届いていることを確かめる。import 元の const も含む) */
  const FIXED_TEXTS: ReadonlyArray<readonly [string, string]> = [
    ['src/lib/super-admin/plans-schemas.ts', PRICE_APPLIES_TO_MESSAGE],
    ['src/lib/data-subject-requests/core.ts', '請求の種類 (request_type) の値が不正です'],
    ['src/lib/admin/inquiries.ts', '対応の状態 (status) か管理者メモ (adminNotes) のどちらかを指定してください'],
    ['src/lib/super-admin/app-logs.ts', '開始の日時 (from) は終了の日時 (to) 以前の日時にしてください'],
    ['src/app/api/contact/route.ts', 'お問い合わせの種類 (inquiryType) の値が不正です'],
  ];

  it.each(FIXED_TEXTS)('走査は %s の Zod の文「%s」を集める (配下の取り違え・読み落としで空振りしない)', (file, text) => {
    expect(files).toContain(file);
    expect(findValidationMessageTexts(file).map((found) => found.text)).toContain(text);
  });

  it('見ないファイルの一覧は実在し、Zod の文を持つ (古くなった一覧を残さない)', () => {
    for (const file of ZOD_TEXT_EXEMPT_FILES.keys()) {
      expect(files, file).toContain(file);
      expect(findValidationMessageTexts(file).length, file).toBeGreaterThan(0);
    }
  });

  it('違反が 0 件', () => {
    const violations = files
      .filter((file) => !ZOD_TEXT_EXEMPT_FILES.has(file))
      .flatMap((file) => findValidationMessageTexts(file, { substitutions: SUBSTITUTIONS }))
      .filter((found) => englishIdentifiersOutsideParentheses(found.text).length > 0)
      .map((found) => `${found.file}:${found.line} 「${found.text}」`);
    expect(violations).toEqual([]);
  });
});

describe('src/lib の関数・表が作って本文に流す文 (値で確かめる)', () => {
  it('BAN を断る文 (applyUserBan が返し、モデレーションの route が本文の message にする)', () => {
    expect(englishIdentifiersOutsideParentheses(SUPER_ADMIN_BAN_REJECTED_MESSAGE)).toEqual([]);
    // ロールは運営の画面の表示名 (運営最上位) で書く (#2134 U1-1。審査のフォームがこの文をそのまま出す)
    expect(SUPER_ADMIN_BAN_REJECTED_MESSAGE).toBe('運営最上位のユーザーは BAN できません');
  });

  it('食事の入力の検証の文 (meals・meal-plans の 400 の error。Web の alert・モバイルの Alert がそのまま出す)', () => {
    expect(englishIdentifiersOutsideParentheses(MEAL_TYPE_MESSAGE)).toEqual([]);
    const invalidNutrients = Object.fromEntries(PLANNED_MEAL_NUTRIENT_FIELDS.map((field) => [field, -1]));
    const result = validatePlannedMealInput({ mealType: 'brunch', nutrients: invalidNutrients });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(['meal_type', ...PLANNED_MEAL_NUTRIENT_FIELDS].sort());
    for (const message of Object.values(result.fieldErrors)) {
      expect(englishIdentifiersOutsideParentheses(message), message).toEqual([]);
    }
    expect(englishIdentifiersOutsideParentheses(result.error)).toEqual([]);
  });

  it('プランのキー・価格の適用先の文 (テンプレートに差し込む値も括弧の中)', () => {
    for (const message of [PERSONAL_FAMILY_PLAN_KEY_MESSAGE, ORG_PLAN_KEY_PREFIX_MESSAGE, PRICE_APPLIES_TO_MESSAGE]) {
      expect(englishIdentifiersOutsideParentheses(message), message).toEqual([]);
    }
  });

  it('二段階認証の画面の表 (MFA_ERROR_MESSAGES) の全部の文', () => {
    expect(MFA_ERROR_MESSAGES.size).toBeGreaterThan(0);
    for (const [code, message] of MFA_ERROR_MESSAGES) {
      expect(englishIdentifiersOutsideParentheses(message), code).toEqual([]);
    }
  });
});

describe('走査: テンプレートの式の部分を値として読む (#1917 の続き)', () => {
  const FIXTURE_FILE = 'src/app/api/__fixture_template__/route.ts';
  const FIXTURE = `
    import { NextResponse } from 'next/server';
    const KINDS = ['food', 'recipe'] as const;
    const LIMIT = 30;
    const LABEL = '試用の日数 (trial_days)';
    export async function PATCH(keys: string[], from: string, to: string, n: number) {
      if (a) return NextResponse.json({ error: { message: \`公開中プランでは \${keys.join(', ')} は変更できません\` } });
      if (b) return NextResponse.json({ error: { message: \`\${from} から \${to} への遷移は許可されていません\` } });
      if (c) return NextResponse.json({ error: \`種類 (type) は \${KINDS.join(', ')} のいずれかです\` });
      if (d) return NextResponse.json({ error: \`次の項目は変更できません (\${keys.join(', ')})\` });
      if (e) return NextResponse.json({ error: \`種類 (type) は次のいずれかです (\${KINDS.join(' / ')})\` });
      if (f) return NextResponse.json({ error: \`\${LABEL} は \${LIMIT} 日以内、\${LIMIT * 2 - 1} 回まで、上位 \${Math.round(n)}% です\` });
      if (g) return NextResponse.json({ error: \`目標値は \${n} 以上です\` });
      return NextResponse.json({ ok: true });
    }
  `;
  const textsWith = (exempt: ReadonlyMap<string, string>, used?: Set<string>) =>
    findErrorTexts(FIXTURE_FILE, { text: FIXTURE, substitutions: { exempt, used } }).map((found) => found.text);

  it('読み取れない式は印にし、定数・配列の定数の join・数は値にする', () => {
    expect(textsWith(new Map())).toEqual([
      `公開中プランでは ${UNRESOLVED_SUBSTITUTION} は変更できません`,
      `${UNRESOLVED_SUBSTITUTION} から ${UNRESOLVED_SUBSTITUTION} への遷移は許可されていません`,
      '種類 (type) は food, recipe のいずれかです',
      `次の項目は変更できません ( ${UNRESOLVED_SUBSTITUTION} )`,
      '種類 (type) は次のいずれかです (food / recipe)',
      '試用の日数 (trial_days) は 0 日以内、0 回まで、上位 0% です',
      `目標値は ${UNRESOLVED_SUBSTITUTION} 以上です`,
    ]);
  });

  it('括弧の外に英字の値・読み取れない式を差し込む文だけを違反にする (以前のプランの文・モデレーションの種類の文)', () => {
    const violations = textsWith(new Map()).filter((text) => englishIdentifiersOutsideParentheses(text).length > 0);
    expect(violations).toEqual([
      `公開中プランでは ${UNRESOLVED_SUBSTITUTION} は変更できません`,
      `${UNRESOLVED_SUBSTITUTION} から ${UNRESOLVED_SUBSTITUTION} への遷移は許可されていません`,
      '種類 (type) は food, recipe のいずれかです',
      `目標値は ${UNRESOLVED_SUBSTITUTION} 以上です`,
    ]);
  });

  it('オブジェクトの定数の要素 (`LABELS.key`。同じファイル・import 元) は値にし、無い要素は印にする (#2134 U1)', () => {
    const fixture = `
      import { NextResponse } from 'next/server';
      const LABELS = { super_admin: '運営最上位', 'org_admin': '組織管理者' } as const;
      const NOTE = \`\${LABELS.super_admin}のみ\`;
      export async function POST() {
        if (a) return NextResponse.json({ error: { message: \`永久 BAN は\${NOTE}実行できます\` } });
        if (b) return NextResponse.json({ error: \`\${LABELS.org_admin}は変更できません\` });
        if (c) return NextResponse.json({ error: \`\${LABELS.missing}は変更できません\` });
        return NextResponse.json({ ok: true });
      }
    `;
    expect(findErrorTexts(FIXTURE_FILE, { text: fixture, substitutions: { exempt: new Map() } }).map((found) => found.text)).toEqual([
      '永久 BAN は運営最上位のみ実行できます',
      '組織管理者は変更できません',
      `${UNRESOLVED_SUBSTITUTION} は変更できません`,
    ]);
  });

  it('見逃しの一覧に載せた式は空にし、使った鍵を積む', () => {
    const used = new Set<string>();
    const key = substitutionKey(FIXTURE_FILE, 'n');
    const texts = textsWith(new Map([[key, '数']]), used);
    expect(texts).toContain('目標値は 以上です');
    expect([...used]).toEqual([key]);
  });

  it('見逃しの一覧 (TEMPLATE_SUBSTITUTION_EXEMPT) の鍵は、どれも走査で使われる (古くなった一覧を残さない)', () => {
    const used = new Set<string>();
    const options: SubstitutionOptions = { exempt: TEMPLATE_SUBSTITUTION_EXEMPT, used };
    const routeFiles = routeFilesUnder(API_ROUTES_ROOT).filter((file) => !isMachineFacing(file));
    for (const file of routeFiles) findErrorTexts(file, { extraTextCalls: ROUTE_ERROR_TEXT_CALLS, substitutions: options });
    for (const dir of ZOD_TEXT_SOURCE_DIRS) {
      for (const file of walkFiles(dir, isTypeScriptSource)) findValidationMessageTexts(file, { substitutions: options });
    }
    expect([...TEMPLATE_SUBSTITUTION_EXEMPT.keys()].filter((key) => !used.has(key))).toEqual([]);
  });
});
