// @vitest-environment node
/**
 * #2025: planned_meals の 3 列 (is_completed / completed_at / veg_score) を、利用者のセッションの client で書く経路が
 * 本番コードに戻らないことの走査 (設計: docs/design/cross/23-planned-meals-score-integrity.md §7.21)。
 *
 *   1. src・lib・apps/mobile/src・apps/mobile/app の本番コード (.ts / .tsx。テスト・__tests__ は除く) で、
 *      `.from('planned_meals')` に続く insert / update / upsert のオブジェクトリテラルに 3 列の鍵が無い。
 *      例外は無い (service_role で書く週間生成の復元は、行の変数を渡すので鍵は現れない)。
 *      見つけ方が空振りしていないことは、件数の下限ではなく、決まった文面 (DETECTOR_PROBES) を同じ関数に通して確かめる
 *      (オブジェクトリテラルで書く箇所の数はリポジトリの変更で増減するので、数で見張らない)
 *   2. supabase/functions/analyze-meal-photo/index.ts の planned_meals の update は、service_role の client (queueDb。取り消しと同じ client) で行い、
 *      その直前に本人の行の確認 (user_daily_meals!inner(user_id) と eq('user_daily_meals.user_id', userId)) と、
 *      見つからないときに書かずに抜ける throw がある (同じ問い合わせが本物の DB で他人の行を 0 行にすることは
 *      tests/integration/rls/planned-meals-score-integrity.test.ts の I-11 が見る)。文面はコメントを除き、空白と改行を詰めてから比べる
 *      (字下げ・改行の位置は問わない)
 *   3. supabase/functions/_shared/nutrition-pipeline.ts の estimateVegetableScore は vegScoreOfVegetableGrams を呼び、
 *      数の式 (/ 120 * 100) を自分で書かない
 *   4. src/app/api/ai/nutrition/route.ts に veg_score が現れない (本文・プロンプト・update)
 *   5. 完了の RPC を呼ぶ箇所は、名前を PLANNED_MEALS_SET_COMPLETED_RPC で、引数を plannedMealsSetCompletedArgs で書く
 *      (文字列 'planned_meals_set_completed' の直書きは packages/shared だけ)
 *   6. 献立のスナップショットの復元は restoreOwnPlannedMealsSnapshot (本人の日の確認 + service_role) だけ。
 *      restorePlannedMealsSnapshot を直接呼ぶのは src/lib/planned-meals-snapshot.ts の中だけで、
 *      restoreOwnPlannedMealsSnapshot を呼ぶのは週間生成の 4 route で、どれも userDb に supabase、writer に getSupabaseAdmin() を渡す
 *   7. analyze-meal-photo/index.ts の mealId の経路 (planned_meals に書く背景の処理) は、利用者が送った解析の結果
 *      (prefetchedGeminiResult) を使わない: 背景の処理の登録 (analyzeMealPhotoBackgroundTask の呼び出し) の引数に無く、
 *      背景の処理の関数の中にその語が無く、関数の中の analyzeWithEvidence は 3 引数 (4 つ目の prefetch を渡さない)。AST で見る
 *      (Next.js の route が mealId のときに Edge へ渡さないことは tests/image-route-contracts.test.ts の追記の it が振る舞いで見る)
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PLANNED_MEALS_SERVER_ONLY_COLUMNS, PLANNED_MEALS_SET_COMPLETED_RPC } from '@homegohan/shared';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 1 件のテストの中でリポジトリのソースを全部構文木にする (TypeScript の構文木によるリポジトリの走査) ので、負荷の高い機械で
// vitest の既定の時間切れ (テスト 5 秒) を超えうる (#2093 の同じ型)。このファイルだけ延ばす (根拠と環境変数での上書きは
// tests/helpers/heavy-unit-test-timeout.ts。#1488 の続き)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'lib', 'apps/mobile/src', 'apps/mobile/app'] as const;
const PHOTO_FUNCTION = 'supabase/functions/analyze-meal-photo/index.ts';
const PIPELINE = 'supabase/functions/_shared/nutrition-pipeline.ts';
const NUTRITION_ROUTE = 'src/app/api/ai/nutrition/route.ts';
const SHARED_MODULE = 'packages/shared/src/planned-meals-integrity.ts';
const SNAPSHOT_LIB = 'src/lib/planned-meals-snapshot.ts';
/** 写真の解析の背景の処理の関数の名前と、その中で呼ぶ解析の関数の名前 (§7.15) */
const PHOTO_BACKGROUND_TASK = 'analyzeMealPhotoBackgroundTask';
const PHOTO_ANALYZE_FUNCTION = 'analyzeWithEvidence';
/** 利用者が送る解析の結果の鍵 (mealId の経路では使わない。§7.15) */
const PREFETCHED_RESULT_KEY = 'prefetchedGeminiResult';
/** analyzeWithEvidence(images, mealType, supabase) の引数の数 (4 つ目の prefetch を渡さない) */
const PHOTO_ANALYZE_ARGUMENT_COUNT = 3;
/** 献立のスナップショットを復元する route (§7.12) */
const SNAPSHOT_RESTORE_ROUTES = [
  'src/app/api/ai/menu/weekly/request/route.ts',
  'src/app/api/ai/menu/weekly/status/route.ts',
  'src/app/api/ai/menu/weekly/pending/route.ts',
  'src/app/api/ai/menu/weekly/cleanup/route.ts',
] as const;
const WRITE_METHODS = new Set(['insert', 'update', 'upsert']);
/**
 * 項目 1 の見つけ方の自己点検: 1 行の連鎖・改行した連鎖・insert / upsert の 3 通りで、3 列の鍵を拾えること
 * (src・lib・apps/mobile に今あるオブジェクトリテラルの書き込みの数に頼らない)
 */
const DETECTOR_PROBES: ReadonlyArray<{ source: string; keys: string[] }> = [
  { source: "await supabase.from('planned_meals').update({ is_completed: true, dish_name: 'x' }).eq('id', id);", keys: ['is_completed', 'dish_name'] },
  { source: "await supabase\n  .from('planned_meals')\n  .insert({ veg_score: 100 })\n  .select();", keys: ['veg_score'] },
  { source: "await db.from(\"planned_meals\").upsert({ completed_at: now, memo });", keys: ['completed_at', 'memo'] },
];

/** ブロックコメントと行コメントを除く (URL の :// は残す)。注に関数名が出てきても呼び出しと数えない */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '.next') continue;
      out.push(...listSources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** `.from('planned_meals')` を含む式の連鎖の中の insert / update / upsert のオブジェクトリテラルの鍵 */
function plannedMealsWriteKeys(sf: ts.SourceFile): Array<{ line: number; keys: string[] }> {
  const found: Array<{ line: number; keys: string[] }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && WRITE_METHODS.has(node.expression.name.text)) {
      const chain = node.expression.expression.getText(sf);
      if (/\.from\(\s*['"]planned_meals['"]\s*\)/.test(chain)) {
        const [arg] = node.arguments;
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const keys = arg.properties.flatMap((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : []);
          found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, keys });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('#2025 利用者のセッションで 3 列を書く経路が無い', () => {
  it('1: src・lib・apps/mobile の planned_meals の insert / update / upsert に is_completed / completed_at / veg_score の鍵が無い', () => {
    // 見つけ方が空振りしていないこと (決まった文面で 3 通りの書き方を拾える)
    for (const probe of DETECTOR_PROBES) {
      const sf = ts.createSourceFile('probe.ts', probe.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      expect(plannedMealsWriteKeys(sf).map((write) => write.keys), probe.source).toEqual([probe.keys]);
    }
    const offenders: string[] = [];
    let scannedFiles = 0;
    for (const root of SCAN_ROOTS) {
      for (const file of listSources(path.join(ROOT, root))) {
        scannedFiles += 1;
        for (const write of plannedMealsWriteKeys(parse(file))) {
          const hit = write.keys.filter((k) => (PLANNED_MEALS_SERVER_ONLY_COLUMNS as readonly string[]).includes(k));
          if (hit.length > 0) offenders.push(`${path.relative(ROOT, file)}:${write.line} ${hit.join(', ')}`);
        }
      }
    }
    expect(scannedFiles).toBeGreaterThan(0);
    expect(offenders, '3 列は RPC (完了) か service_role (野菜スコア) でしか書けない').toEqual([]);
  });

  it('2: analyze-meal-photo の planned_meals の update は service_role の queueDb で、直前に本人の行の確認がある', () => {
    // コメントを除き、空白と改行を 1 つの空白に詰める (字下げ・改行の位置は問わない)
    const code = stripComments(fs.readFileSync(path.join(ROOT, PHOTO_FUNCTION), 'utf8')).replace(/\s+/g, ' ');
    expect(code).toMatch(
      /const queueDb = createClient\( ?Deno\.env\.get\('SUPABASE_URL'\) \?\? '', ?Deno\.env\.get\('SERVICE_ROLE_JWT'\) \?\? Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\) \?\? '',? ?\)/,
    );
    const ownership = code.search(/await queueDb ?\.from\('planned_meals'\) ?\.select\('id, user_daily_meals!inner\(user_id\)'\)/);
    const update = code.search(/await queueDb ?\.from\('planned_meals'\) ?\.update\(\{/);
    expect(ownership).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(ownership);
    const between = code.slice(ownership, update);
    expect(between).toMatch(/\.eq\('id', mealId\) ?\.eq\('user_daily_meals\.user_id', userId\)/);
    // 見つからなければ書かずに抜ける (他人の mealId・消えた献立)
    expect(between).toContain('if (!owned) throw new Error(PLANNED_MEAL_NOT_FOUND_CODE)');
    // planned_meals の update は queueDb の 1 か所だけ (利用者の client (supabase) で update しない)
    expect(code.match(/\.from\('planned_meals'\) ?\.update\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/await supabase ?\.from\('planned_meals'\) ?\.update\(/);
  });

  it('3: estimateVegetableScore は vegScoreOfVegetableGrams を呼び、数の式を自分で書かない', () => {
    const text = fs.readFileSync(path.join(ROOT, PIPELINE), 'utf8');
    const fn = /export function estimateVegetableScore\([\s\S]*?\n\}/.exec(text)?.[0] ?? '';
    expect(fn).toContain('return vegScoreOfVegetableGrams(vegetableGrams)');
    expect(fn).not.toMatch(/\/ 120|\* 100|clamp\(/);
    expect(text).toMatch(/import \{\s*vegScoreOfVegetableGrams\s*\} from ['"]\.\/veg-score\.ts['"]/);
  });

  it('4: POST /api/ai/nutrition に veg_score が現れない', () => {
    expect(fs.readFileSync(path.join(ROOT, NUTRITION_ROUTE), 'utf8')).not.toMatch(/veg_score/);
  });

  it('5: 完了の RPC の名前の直書きは packages/shared だけ', () => {
    const offenders: string[] = [];
    for (const root of [...SCAN_ROOTS, 'packages/shared/src']) {
      for (const file of listSources(path.join(ROOT, root))) {
        const rel = path.relative(ROOT, file);
        if (rel === SHARED_MODULE) continue;
        if (fs.readFileSync(file, 'utf8').includes(`'${PLANNED_MEALS_SET_COMPLETED_RPC}'`)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('6: 献立のスナップショットの復元は restoreOwnPlannedMealsSnapshot だけで、4 route は userDb に supabase、writer に getSupabaseAdmin() を渡す', () => {
    const direct: string[] = [];
    const callers: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of listSources(path.join(ROOT, root))) {
        const rel = path.relative(ROOT, file);
        if (rel === SNAPSHOT_LIB) continue;
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        if (/\brestorePlannedMealsSnapshot\s*\(/.test(code)) direct.push(rel);
        if (/\brestoreOwnPlannedMealsSnapshot\s*\(/.test(code)) callers.push(rel);
      }
    }
    expect(direct, '利用者のセッションで 3 列を含む行を INSERT すると 42501 で戻らない').toEqual([]);
    expect(callers.sort()).toEqual([...SNAPSHOT_RESTORE_ROUTES].sort());
    for (const route of SNAPSHOT_RESTORE_ROUTES) {
      expect(stripComments(fs.readFileSync(path.join(ROOT, route), 'utf8')), route).toMatch(
        /restoreOwnPlannedMealsSnapshot\(\{\s*userDb: supabase,\s*writer: getSupabaseAdmin\(\),/,
      );
    }
  });

  it('7: analyze-meal-photo の mealId の経路 (背景の処理) は prefetchedGeminiResult を使わない', () => {
    const sf = parse(path.join(ROOT, PHOTO_FUNCTION));
    const registrations: ts.CallExpression[] = [];
    const tasks: ts.FunctionDeclaration[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === PHOTO_BACKGROUND_TASK) registrations.push(node);
      if (ts.isFunctionDeclaration(node) && node.name?.text === PHOTO_BACKGROUND_TASK) tasks.push(node);
      ts.forEachChild(node, visit);
    };
    visit(sf);
    // 登録は 1 か所で、引数のオブジェクトリテラルに prefetchedGeminiResult の鍵が無い
    expect(registrations).toHaveLength(1);
    const [arg] = registrations[0].arguments;
    expect(arg !== undefined && ts.isObjectLiteralExpression(arg)).toBe(true);
    const keys = arg !== undefined && ts.isObjectLiteralExpression(arg)
      ? arg.properties.flatMap((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : []))
      : [];
    expect(keys).toContain('mealId');
    expect(keys).not.toContain(PREFETCHED_RESULT_KEY);
    // 背景の処理の関数は 1 本で、その中にその語が無い (引数・型・呼び出しのどれにも)
    expect(tasks).toHaveLength(1);
    expect(stripComments(tasks[0].getText(sf))).not.toContain(PREFETCHED_RESULT_KEY);
    // 関数の中の解析の呼び出しは 1 か所で、3 引数
    const analyzeCalls: ts.CallExpression[] = [];
    const visitTask = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === PHOTO_ANALYZE_FUNCTION) analyzeCalls.push(node);
      ts.forEachChild(node, visitTask);
    };
    visitTask(tasks[0]);
    expect(analyzeCalls.map((call) => call.arguments.length)).toEqual([PHOTO_ANALYZE_ARGUMENT_COUNT]);
  });
});
