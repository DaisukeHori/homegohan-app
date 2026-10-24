/**
 * 献立の料理のお気に入りの core (純関数と Zod の正典) の単体テスト (U-1〜U-16)
 * 設計: docs/design/cross/22-dish-favorites.md §7.3・§12 (it 名)・§13 (定数)
 * DB もモックも使わない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DISH_FAVORITE_INGREDIENTS_MAX_ITEMS,
  DISH_FAVORITE_INGREDIENT_MAX_CHARS,
  DISH_FAVORITE_INGREDIENT_NAME_MAX_CHARS,
  DISH_FAVORITE_INGREDIENT_NOTE_MAX_CHARS,
  DISH_FAVORITE_MARKDOWN_MAX_CHARS,
  DISH_FAVORITE_NAME_MAX_CHARS,
  DISH_FAVORITE_NUTRIENT_KEYS,
  DISH_FAVORITE_STEPS_MAX_ITEMS,
  DISH_FAVORITES_QUERY_MAX_CHARS,
  DishFavoriteRowSchema,
  DishFavoriteSchema,
  DishIngredientSchema,
  DishNameSchema,
  DishSnapshotSchema,
  SaveDishFavoriteBodySchema,
  dishFavoritesQueryOf,
  dishJsonByteLength,
  dishNameKeyOf,
  dishSnapshotFromMenuDish,
  displayDishNameOf,
  ingredientInputsOf,
  ingredientLineOf,
  recipeModalDataOf,
  toDishFavorite,
  type DishFavorite,
  type DishIngredientInput,
} from '@/modules/dish-favorites/core';

const ROOT = path.resolve(__dirname, '..');
/** 栄養の項目名の数 (calories_kcal を除く。§13 の DISH_FAVORITE_NUTRIENT_KEYS) */
const NUTRIENT_KEY_COUNT = 29;
/** F-31 (ii) の長い 1 行の材料の本番の最長 (文字) */
const LONG_INGREDIENT_LINE_CHARS = 677;
/** F-30 の材料の本番の最大件数 */
const PROD_MAX_INGREDIENTS = 14;
/** U-12: 日本語 1 文字 (BMP の CJK) の UTF-8 のバイト数 */
const UTF8_BYTES_PER_KANA = 3;
/** 写しの鍵の数 (name・role・calories_kcal・栄養 29・ingredients・ingredients_md・recipe_steps・recipe_steps_md。§13 の「写しの鍵 36」) */
const SNAPSHOT_KEY_COUNT = 36;
/** 「㌀」(U+3300 SQUARE APAATO)。NFKC で「アパート」になり、鍵が表示名より長くなる */
const SQUARE_APAATO = '\u3300';

const ROW_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PLANNED_MEAL_ID = '33333333-3333-4333-8333-333333333333';
const CREATED_AT = '2026-10-25T00:00:00.000Z';
const UPDATED_AT = '2026-10-25T01:00:00.000Z';

describe('dish-favorites core: 名前の正規化', () => {
  it('U-1: displayDishNameOf は空白 (全角を含む) の連続を 1 つの半角空白にまとめ、前後を除く', () => {
    expect(displayDishNameOf('  肉\u3000じゃが \t\n 煮  ')).toBe('肉 じゃが 煮');
    expect(displayDishNameOf('\u3000\u3000鶏の\u3000\u3000照り焼き\u3000')).toBe('鶏の 照り焼き');
    // 幅と大文字小文字はそのまま
    expect(displayDishNameOf('ＡＢＣ Curry')).toBe('ＡＢＣ Curry');
    expect(displayDishNameOf('')).toBe('');
  });

  it('U-2: dishNameKeyOf は NFKC と小文字にそろえる (全角英数・半角カナ・大文字の違いで同じ鍵になる)', () => {
    expect(dishNameKeyOf('ＡＢＣカレー')).toBe('abcカレー');
    expect(dishNameKeyOf('ABCｶﾚｰ')).toBe('abcカレー');
    expect(dishNameKeyOf('abcカレー')).toBe('abcカレー');
    expect(dishNameKeyOf('ポテト１２３')).toBe(dishNameKeyOf('ﾎﾟﾃﾄ123'));
    // 空白の正規化も通る (表示名から鍵を作る)
    expect(dishNameKeyOf('  ＭＡＰＯ\u3000豆腐 ')).toBe('mapo 豆腐');
  });

  it('U-3: DishNameSchema は空白だけ・101 文字・NULL 文字を含む値・鍵 (dishNameKeyOf) が 101 文字以上になる値 (「㌀」× 30) を通さず、正規化した表示名を返す (表示名 100 文字・鍵 100 文字ちょうどは通す)', () => {
    // 通さない
    expect(DishNameSchema.safeParse('   ').success).toBe(false);
    expect(DishNameSchema.safeParse('\u3000\t').success).toBe(false);
    expect(DishNameSchema.safeParse('').success).toBe(false);
    expect(DishNameSchema.safeParse('あ'.repeat(DISH_FAVORITE_NAME_MAX_CHARS + 1)).success).toBe(false);
    expect(DishNameSchema.safeParse('肉\u0000じゃが').success).toBe(false);
    // 「㌀」(U+3300) は NFKC で「アパート」の 4 文字。30 個で表示名 30 文字・鍵 120 文字
    expect(dishNameKeyOf(SQUARE_APAATO)).toBe('アパート');
    expect(dishNameKeyOf(SQUARE_APAATO.repeat(30))).toHaveLength(120);
    expect(DishNameSchema.safeParse(SQUARE_APAATO.repeat(30)).success).toBe(false);
    expect(DishNameSchema.safeParse(123).success).toBe(false);

    // 通す (正規化した表示名を返す)
    expect(DishNameSchema.parse('  肉\u3000じゃが  ')).toBe('肉 じゃが');
    const hundred = 'あ'.repeat(DISH_FAVORITE_NAME_MAX_CHARS);
    expect(DishNameSchema.parse(hundred)).toBe(hundred);
    // 前後の空白は数えない (正規化してから長さを見る)
    expect(DishNameSchema.parse(`  ${hundred}  `)).toBe(hundred);
    // 鍵がちょうど 100 文字 (「㌀」× 25 = 「アパート」× 25)
    const keyHundred = SQUARE_APAATO.repeat(DISH_FAVORITE_NAME_MAX_CHARS / dishNameKeyOf(SQUARE_APAATO).length);
    expect(dishNameKeyOf(keyHundred)).toHaveLength(DISH_FAVORITE_NAME_MAX_CHARS);
    expect(DishNameSchema.parse(keyHundred)).toBe(keyHundred);
  });
});

describe('dish-favorites core: 写しの Zod', () => {
  it('U-4: DishSnapshotSchema は栄養 29 項目・calories_kcal・材料・作り方の既定値 (null・[]) を補い、負の栄養・NaN・材料 51 件・材料 1 行 2001 文字・作り方 31 件・markdown 8001 文字を通さない (材料 1 行 2000 文字ちょうどは通す)', () => {
    const parsed = DishSnapshotSchema.parse({ name: '肉じゃが' });
    expect(parsed.name).toBe('肉じゃが');
    expect(parsed.role).toBeNull();
    expect(parsed.calories_kcal).toBeNull();
    for (const key of DISH_FAVORITE_NUTRIENT_KEYS) expect(parsed[key], key).toBeNull();
    expect(parsed.ingredients).toEqual([]);
    expect(parsed.ingredients_md).toBeNull();
    expect(parsed.recipe_steps).toEqual([]);
    expect(parsed.recipe_steps_md).toBeNull();
    // 既定値を補ったキーの数 = name・role・calories_kcal・栄養 29・材料 / 作り方の 4
    expect(Object.keys(parsed)).toHaveLength(SNAPSHOT_KEY_COUNT);

    // 値はそのまま通る
    const filled = DishSnapshotSchema.parse({ name: 'x', calories_kcal: 320, protein_g: 0, fat_g: 12.5, role: ' main ' });
    expect(filled.calories_kcal).toBe(320);
    expect(filled.protein_g).toBe(0);
    expect(filled.fat_g).toBe(12.5);
    expect(filled.role).toBe('main');

    const base = { name: 'x' };
    const rejected: Array<[string, Record<string, unknown>]> = [
      ['負の栄養', { ...base, protein_g: -1 }],
      ['負の kcal', { ...base, calories_kcal: -0.1 }],
      ['NaN', { ...base, fat_g: Number.NaN }],
      ['Infinity', { ...base, carbs_g: Number.POSITIVE_INFINITY }],
      ['材料 51 件', { ...base, ingredients: Array.from({ length: DISH_FAVORITE_INGREDIENTS_MAX_ITEMS + 1 }, (_, i) => `材料${i}`) }],
      ['材料 1 行 2001 文字', { ...base, ingredients: ['あ'.repeat(DISH_FAVORITE_INGREDIENT_MAX_CHARS + 1)] }],
      ['作り方 31 件', { ...base, recipe_steps: Array.from({ length: DISH_FAVORITE_STEPS_MAX_ITEMS + 1 }, (_, i) => `手順${i}`) }],
      ['材料の markdown 8001 文字', { ...base, ingredients_md: 'x'.repeat(DISH_FAVORITE_MARKDOWN_MAX_CHARS + 1) }],
      ['作り方の markdown 8001 文字', { ...base, recipe_steps_md: 'x'.repeat(DISH_FAVORITE_MARKDOWN_MAX_CHARS + 1) }],
    ];
    for (const [label, value] of rejected) {
      expect(DishSnapshotSchema.safeParse(value).success, label).toBe(false);
    }

    // 上限ちょうどは通す
    expect(DishSnapshotSchema.safeParse({ ...base, ingredients: ['あ'.repeat(DISH_FAVORITE_INGREDIENT_MAX_CHARS)] }).success).toBe(true);
    expect(
      DishSnapshotSchema.safeParse({ ...base, ingredients: Array.from({ length: DISH_FAVORITE_INGREDIENTS_MAX_ITEMS }, (_, i) => `材料${i}`) }).success,
    ).toBe(true);
    expect(
      DishSnapshotSchema.safeParse({ ...base, recipe_steps: Array.from({ length: DISH_FAVORITE_STEPS_MAX_ITEMS }, (_, i) => `手順${i}`) }).success,
    ).toBe(true);
    expect(DishSnapshotSchema.safeParse({ ...base, ingredients_md: 'x'.repeat(DISH_FAVORITE_MARKDOWN_MAX_CHARS) }).success).toBe(true);
  });

  it('U-5: SaveDishFavoriteBodySchema は source_planned_meal_id を省略すると null、uuid でない値を通さない', () => {
    const omitted = SaveDishFavoriteBodySchema.parse({ dish: { name: '肉じゃが' } });
    expect(omitted.source_planned_meal_id).toBeNull();
    expect(omitted.dish.name).toBe('肉じゃが');

    const withId = SaveDishFavoriteBodySchema.parse({ dish: { name: '肉じゃが' }, source_planned_meal_id: PLANNED_MEAL_ID });
    expect(withId.source_planned_meal_id).toBe(PLANNED_MEAL_ID);
    expect(SaveDishFavoriteBodySchema.parse({ dish: { name: 'x' }, source_planned_meal_id: null }).source_planned_meal_id).toBeNull();

    for (const bad of ['not-a-uuid', '', '123', `${PLANNED_MEAL_ID}x`, 42]) {
      expect(SaveDishFavoriteBodySchema.safeParse({ dish: { name: 'x' }, source_planned_meal_id: bad }).success, String(bad)).toBe(false);
    }
    // dish が無い・名前が無い本文も通さない
    expect(SaveDishFavoriteBodySchema.safeParse({}).success).toBe(false);
    expect(SaveDishFavoriteBodySchema.safeParse({ dish: {} }).success).toBe(false);
  });
});

describe('dish-favorites core: 献立の料理 → 写し', () => {
  it('U-6: dishSnapshotFromMenuDish は新形式のキーを優先し、無ければ旧形式 (cal・protein … folicAcid) から埋め、負・NaN・文字列でない値は null にする', () => {
    const snapshot = dishSnapshotFromMenuDish({
      name: '肉じゃが',
      // 新形式を優先
      calories_kcal: 320,
      cal: 999,
      protein_g: 10,
      protein: 99,
      // 新形式が無ければ旧形式
      fat: 5,
      vitaminC: 12,
      folicAcid: 40,
      // 数を表す文字列は数に
      sugar: '3.5',
      // 負・NaN・数でない文字列・文字列でない値は null
      carbs: -1,
      fiber: Number.NaN,
      sodium: 'abc',
      potassium_mg: true,
      calcium_mg: { value: 1 },
      iron_mg: [1],
      zinc_mg: null,
      // 新形式が負なら旧形式を読む
      vitamin_a_ug: -5,
      vitaminA: 7,
    });
    expect(snapshot.calories_kcal).toBe(320);
    expect(snapshot.protein_g).toBe(10);
    expect(snapshot.fat_g).toBe(5);
    expect(snapshot.vitamin_c_mg).toBe(12);
    expect(snapshot.folic_acid_ug).toBe(40);
    expect(snapshot.sugar_g).toBe(3.5);
    expect(snapshot.carbs_g).toBeNull();
    expect(snapshot.fiber_g).toBeNull();
    expect(snapshot.sodium_g).toBeNull();
    expect(snapshot.potassium_mg).toBeNull();
    expect(snapshot.calcium_mg).toBeNull();
    expect(snapshot.iron_mg).toBeNull();
    expect(snapshot.zinc_mg).toBeNull();
    expect(snapshot.vitamin_a_ug).toBe(7);
    // 旧形式に名前の無い項目 (magnesium_mg など) は新形式だけ
    expect(snapshot.magnesium_mg).toBeNull();
    // 栄養の 29 項目すべてのキーがある
    for (const key of DISH_FAVORITE_NUTRIENT_KEYS) expect(snapshot, key).toHaveProperty(key);

    // 旧形式だけの料理 (cal と短いキー)
    const legacy = dishSnapshotFromMenuDish({ name: '旧', cal: 250, protein: 8, vitaminB12: 1.2 });
    expect(legacy.calories_kcal).toBe(250);
    expect(legacy.protein_g).toBe(8);
    expect(legacy.vitamin_b12_ug).toBe(1.2);
  });

  it('U-7: dishSnapshotFromMenuDish は ingredients の空でない文字列 (前後の空白を除く) と name のある構造の形 ({ name, amount_g, note }。amount_g は 0 以上の数か null・note は空なら null) を集めて数・null・name の無いオブジェクトを捨て、recipeSteps の空でない文字列を集め、ingredientsMd・recipeStepsMd を写す。name が無ければ nameFallback', () => {
    const snapshot = dishSnapshotFromMenuDish(
      {
        role: 'main',
        ingredients: [
          '  鶏むね肉 200g ',
          '',
          '   ',
          3,
          null,
          ['配列'],
          { amount_g: 5 },
          { name: '   ', amount_g: 5 },
          { name: '  玉ねぎ ', amount_g: 100, note: 'みじん切り' },
          { name: '塩', amount_g: -1, note: '' },
          { name: '水', note: 5 },
        ],
        recipeSteps: [' 切る ', '', '  ', 1, null, '煮る'],
        ingredientsMd: '| 材料 | 分量 |',
        recipeStepsMd: '1. 切る',
      },
      'モーダルの見出し',
    );
    expect(snapshot.name).toBe('モーダルの見出し');
    expect(snapshot.role).toBe('main');
    expect(snapshot.ingredients).toStrictEqual([
      '鶏むね肉 200g',
      { name: '玉ねぎ', amount_g: 100, note: 'みじん切り' },
      { name: '塩', amount_g: null, note: null },
      { name: '水', amount_g: null, note: null },
    ]);
    expect(snapshot.recipe_steps).toStrictEqual(['切る', '煮る']);
    expect(snapshot.ingredients_md).toBe('| 材料 | 分量 |');
    expect(snapshot.recipe_steps_md).toBe('1. 切る');

    // name があればそれ。空白だけなら nameFallback。nameFallback も無ければ空 (サーバーが 400 にする)
    expect(dishSnapshotFromMenuDish({ name: '肉じゃが' }, '見出し').name).toBe('肉じゃが');
    expect(dishSnapshotFromMenuDish({ name: '   ' }, '見出し').name).toBe('見出し');
    expect(dishSnapshotFromMenuDish({}).name).toBe('');
    // 配列でない材料・作り方・md でない値は空 / null
    const empty = dishSnapshotFromMenuDish({ name: 'x', ingredients: 'a,b', recipeSteps: { 0: 'a' }, ingredientsMd: '  ', recipeStepsMd: 3, role: '' });
    expect(empty.ingredients).toEqual([]);
    expect(empty.recipe_steps).toEqual([]);
    expect(empty.ingredients_md).toBeNull();
    expect(empty.recipe_steps_md).toBeNull();
    expect(empty.role).toBeNull();
  });

  it('U-8: dishSnapshotFromMenuDish の結果は DishSnapshotSchema を通る (本番の 4 つの形 (F-31) を作った例で: 構造の形の材料 14 件 + ingredientsMd / 677 文字の 1 行の材料 1 件 (md なし) / 短い行の配列 / 材料なし。どれも材料が写しに残る)', () => {
    const nutrients = { calories_kcal: 420, protein_g: 21.5, fat_g: 12, carbs_g: 48, sodium_g: 2.1 };
    const structured = Array.from({ length: PROD_MAX_INGREDIENTS }, (_, i) => ({
      name: `材料${i + 1}`,
      amount_g: i + 0.5,
      ...(i % 2 === 0 ? { note: 'みじん切り' } : {}),
    }));
    const longLine = '鶏もも肉、玉ねぎ、にんじん、'.repeat(LONG_INGREDIENT_LINE_CHARS).slice(0, LONG_INGREDIENT_LINE_CHARS);
    const shortLines = ['鶏むね肉 200g', '塩 少々', 'こしょう 適量', 'オリーブ油 大さじ1'];

    const shapes: Array<[string, Record<string, unknown>, number]> = [
      ['(i) 構造の形 14 件 + ingredientsMd', { name: '鶏の照り焼き', role: 'main', ...nutrients, ingredients: structured, ingredientsMd: '| 材料 | 分量 |', recipeSteps: ['焼く'], recipeStepsMd: '1. 焼く' }, PROD_MAX_INGREDIENTS],
      ['(ii) 677 文字の 1 行 (md なし)', { name: '具だくさん煮物', role: 'side', ...nutrients, ingredients: [longLine], recipeSteps: ['煮る'] }, 1],
      ['(iii) 短い行の配列', { name: '鶏むね肉のソテー', role: 'main', ...nutrients, ingredients: shortLines }, shortLines.length],
      ['(iv) 材料なし', { name: '白ごはん', role: 'rice', ...nutrients }, 0],
    ];
    for (const [label, dish, count] of shapes) {
      const result = DishSnapshotSchema.safeParse(dishSnapshotFromMenuDish(dish));
      expect(result.success, label).toBe(true);
      if (!result.success) continue;
      expect(result.data.ingredients, label).toHaveLength(count);
      expect(result.data.calories_kcal, label).toBe(nutrients.calories_kcal);
    }
    const structuredResult = DishSnapshotSchema.parse(dishSnapshotFromMenuDish(shapes[0][1]));
    expect(structuredResult.ingredients[0]).toStrictEqual({ name: '材料1', amount_g: 0.5, note: 'みじん切り' });
    expect(structuredResult.ingredients[1]).toStrictEqual({ name: '材料2', amount_g: 1.5, note: null });
    expect(structuredResult.ingredients_md).toBe('| 材料 | 分量 |');
    const longResult = DishSnapshotSchema.parse(dishSnapshotFromMenuDish(shapes[1][1]));
    expect(longResult.ingredients).toStrictEqual([longLine]);
    expect(longResult.ingredients_md).toBeNull();
    expect(DishSnapshotSchema.parse(dishSnapshotFromMenuDish(shapes[2][1])).ingredients).toStrictEqual(shortLines);
  });
});

/** API の形のお気に入り (構造の形と 1 行の文字列の材料・栄養の一部・role あり) */
function favoriteOf(dish: Record<string, unknown>): DishFavorite {
  return DishFavoriteSchema.parse({
    id: ROW_ID,
    dish_name: typeof dish.name === 'string' ? dish.name : 'x',
    dish,
    source_planned_meal_id: PLANNED_MEAL_ID,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  });
}

describe('dish-favorites core: 写し → 画面', () => {
  it('U-9: recipeModalDataOf は role・calories_kcal・栄養を直下に、ingredientsMd・recipeStepsMd・ingredients・recipeSteps を dishes[0] に、imageUrl は null にし、ingredients と allIngredients は ingredientLineOf の文字列の配列にする', () => {
    const favorite = favoriteOf({
      name: '鶏の照り焼き',
      role: 'main',
      calories_kcal: 420,
      protein_g: 21.5,
      vitamin_c_mg: 3,
      ingredients: [{ name: '鶏もも肉', amount_g: 200, note: '一口大' }, '醤油 大さじ1', { name: '塩', amount_g: null, note: null }],
      ingredients_md: '| 材料 | 分量 |',
      recipe_steps: ['焼く', 'たれを絡める'],
      recipe_steps_md: '1. 焼く',
    });
    const data = recipeModalDataOf(favorite);
    const lines = ['鶏もも肉 200g (一口大)', '醤油 大さじ1', '塩'];

    expect(data.name).toBe('鶏の照り焼き');
    expect(data.role).toBe('main');
    expect(data.calories_kcal).toBe(420);
    expect(data.protein_g).toBe(21.5);
    expect(data.vitamin_c_mg).toBe(3);
    expect(data.fat_g).toBeNull();
    for (const key of DISH_FAVORITE_NUTRIENT_KEYS) expect(data, key).toHaveProperty(key);
    expect(data.imageUrl).toBeNull();
    expect(data.ingredients).toStrictEqual(lines);
    expect(data.allIngredients).toStrictEqual(lines);

    const dishes = data.dishes as Array<Record<string, unknown>>;
    expect(dishes).toHaveLength(1);
    expect(dishes[0].name).toBe('鶏の照り焼き');
    expect(dishes[0].ingredientsMd).toBe('| 材料 | 分量 |');
    expect(dishes[0].recipeStepsMd).toBe('1. 焼く');
    expect(dishes[0].ingredients).toStrictEqual(lines);
    expect(dishes[0].recipeSteps).toStrictEqual(['焼く', 'たれを絡める']);
    expect(dishes[0].calories_kcal).toBe(420);
    expect(dishes[0].role).toBe('main');

    // role・md が null の写しは undefined にする (RecipeModal が「無い」と読む)
    const bare = recipeModalDataOf(favoriteOf({ name: '白ごはん' }));
    expect(bare.role).toBeUndefined();
    const bareDish = (bare.dishes as Array<Record<string, unknown>>)[0];
    expect(bareDish.ingredientsMd).toBeUndefined();
    expect(bareDish.recipeStepsMd).toBeUndefined();
    expect(bare.ingredients).toEqual([]);
    expect(bare.allIngredients).toEqual([]);
  });

  it('U-10: ingredientInputsOf は『鶏むね肉 200g』『塩 少々』を name と amount に分け、分量の無い行は amount null。構造の形は { name, amount: \'<amount_g>g\' } (amount_g が null なら amount null・note は送らない)。同じ行が 2 つあれば 2 件のまま (重複を除かない)', () => {
    const ingredients = DishSnapshotSchema.parse({
      name: 'x',
      ingredients: [
        '鶏むね肉 200g',
        '塩 少々',
        'こしょう 適量',
        'パセリ 適宜',
        'しょうゆ',
        { name: '玉ねぎ', amount_g: 100, note: 'みじん切り' },
        { name: '水', amount_g: null, note: '常温' },
        '鶏むね肉 200g',
      ],
    }).ingredients;
    expect(ingredientInputsOf(ingredients)).toStrictEqual([
      { name: '鶏むね肉', amount: '200g' },
      { name: '塩', amount: '少々' },
      { name: 'こしょう', amount: '適量' },
      { name: 'パセリ', amount: '適宜' },
      { name: 'しょうゆ', amount: null },
      { name: '玉ねぎ', amount: '100g' },
      { name: '水', amount: null },
      { name: '鶏むね肉', amount: '200g' },
    ]);
    expect(ingredientInputsOf([])).toEqual([]);
  });

  it('U-11: toDishFavorite は user_id と dish_name_key を落とす', () => {
    const row = DishFavoriteRowSchema.parse({
      id: ROW_ID,
      user_id: USER_ID,
      dish_name: 'ＡＢＣ カレー',
      dish_name_key: 'abc カレー',
      dish: { name: 'ＡＢＣ カレー' },
      source_planned_meal_id: null,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
    });
    const favorite = toDishFavorite(row);
    expect(favorite).not.toHaveProperty('user_id');
    expect(favorite).not.toHaveProperty('dish_name_key');
    expect(favorite).toStrictEqual({
      id: ROW_ID,
      dish_name: 'ＡＢＣ カレー',
      dish: row.dish,
      source_planned_meal_id: null,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
    });
    expect(DishFavoriteSchema.safeParse(favorite).success).toBe(true);
  });

  it('U-12: dishJsonByteLength は UTF-8 のバイト数 (日本語は 1 文字 3 バイト)', () => {
    const ascii = DishSnapshotSchema.parse({ name: 'a' });
    const kana = DishSnapshotSchema.parse({ name: 'あ' });
    expect(dishJsonByteLength(ascii)).toBe(JSON.stringify(ascii).length);
    expect(dishJsonByteLength(kana) - dishJsonByteLength(ascii)).toBe(UTF8_BYTES_PER_KANA - 1);
    const mixed = DishSnapshotSchema.parse({ name: '肉じゃが', ingredients: ['じゃがいも 2個'], recipe_steps_md: 'abc' });
    expect(dishJsonByteLength(mixed)).toBe(Buffer.byteLength(JSON.stringify(mixed), 'utf8'));
  });

  it('U-13: DISH_FAVORITE_NUTRIENT_KEYS は 29 項目で types/domain.ts の DishDetail の栄養の名前 (calories_kcal を除く) と同じ集合', () => {
    expect(DISH_FAVORITE_NUTRIENT_KEYS).toHaveLength(NUTRIENT_KEY_COUNT);
    expect(new Set(DISH_FAVORITE_NUTRIENT_KEYS).size).toBe(NUTRIENT_KEY_COUNT);

    // DishDetail の本体を切り出し、単位つきの数の項目 (`名前_<単位>?: number`) を集める
    const source = fs.readFileSync(path.join(ROOT, 'types/domain.ts'), 'utf8');
    const start = source.indexOf('export interface DishDetail {');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end);
    const nutrientNames = [...body.matchAll(/^\s*(\w+_(?:g|mg|ug|kcal))\?:\s*number\s*;/gm)].map((match) => match[1]);
    expect(nutrientNames).toContain('calories_kcal');
    const withoutCalories = nutrientNames.filter((name) => name !== 'calories_kcal');
    expect(new Set(DISH_FAVORITE_NUTRIENT_KEYS)).toEqual(new Set(withoutCalories));
    expect(withoutCalories).toHaveLength(NUTRIENT_KEY_COUNT);
    expect(DISH_FAVORITE_NUTRIENT_KEYS).not.toContain('calories_kcal');
  });

  it('U-14: dishFavoritesQueryOf は null を空に、NULL 文字を除き、前後の空白を除き、101 文字以上を先頭 100 文字に切る', () => {
    expect(dishFavoritesQueryOf(null)).toBe('');
    expect(dishFavoritesQueryOf('')).toBe('');
    expect(dishFavoritesQueryOf('   ')).toBe('');
    expect(dishFavoritesQueryOf('  カ\u0000レー  ')).toBe('カレー');
    expect(dishFavoritesQueryOf('\u0000\u0000')).toBe('');
    expect(dishFavoritesQueryOf('あ'.repeat(DISH_FAVORITES_QUERY_MAX_CHARS + 1))).toBe('あ'.repeat(DISH_FAVORITES_QUERY_MAX_CHARS));
    expect(dishFavoritesQueryOf('あ'.repeat(DISH_FAVORITES_QUERY_MAX_CHARS))).toBe('あ'.repeat(DISH_FAVORITES_QUERY_MAX_CHARS));
    expect(DISH_FAVORITES_QUERY_MAX_CHARS).toBe(DISH_FAVORITE_NAME_MAX_CHARS);
  });

  it('U-15: DishIngredientSchema は 1 行の文字列と構造の形の両方を通し、構造の形のほかのキーを落とし、name が空・101 文字・note が 201 文字・amount_g が負 / NaN の要素を通さない (note の空白だけは null)', () => {
    expect(DishIngredientSchema.parse('鶏むね肉 200g')).toBe('鶏むね肉 200g');
    expect(DishIngredientSchema.parse('  塩 少々 ')).toBe('塩 少々');
    expect(DishIngredientSchema.parse({ name: '玉ねぎ', amount_g: 100, note: 'みじん切り', unit: 'g', extra: 1 })).toStrictEqual({
      name: '玉ねぎ',
      amount_g: 100,
      note: 'みじん切り',
    });
    // amount_g・note が無ければ null
    expect(DishIngredientSchema.parse({ name: '水' })).toStrictEqual({ name: '水', amount_g: null, note: null });
    // note の空白だけは null
    expect(DishIngredientSchema.parse({ name: '水', amount_g: 0, note: '   ' })).toStrictEqual({ name: '水', amount_g: 0, note: null });
    // 上限ちょうどは通す
    expect(DishIngredientSchema.safeParse({ name: 'あ'.repeat(DISH_FAVORITE_INGREDIENT_NAME_MAX_CHARS) }).success).toBe(true);
    expect(DishIngredientSchema.safeParse({ name: 'x', note: 'あ'.repeat(DISH_FAVORITE_INGREDIENT_NOTE_MAX_CHARS) }).success).toBe(true);

    const rejected: Array<[string, unknown]> = [
      ['空の文字列', ''],
      ['空白だけの文字列', '   '],
      ['name が空', { name: '', amount_g: 1 }],
      ['name が空白だけ', { name: '  ' }],
      ['name が 101 文字', { name: 'あ'.repeat(DISH_FAVORITE_INGREDIENT_NAME_MAX_CHARS + 1) }],
      ['note が 201 文字', { name: 'x', note: 'あ'.repeat(DISH_FAVORITE_INGREDIENT_NOTE_MAX_CHARS + 1) }],
      ['amount_g が負', { name: 'x', amount_g: -1 }],
      ['amount_g が NaN', { name: 'x', amount_g: Number.NaN }],
      ['name が無い', { amount_g: 1 }],
      ['数', 3],
      ['null', null],
    ];
    for (const [label, value] of rejected) {
      expect(DishIngredientSchema.safeParse(value).success, label).toBe(false);
    }
  });

  it('U-16: ingredientLineOf は文字列をそのまま返し、構造の形を『名前 分量g (メモ)』にする (分量が null・メモが null の部分は付けない)', () => {
    const cases: Array<[DishIngredientInput, string]> = [
      ['鶏むね肉 200g', '鶏むね肉 200g'],
      [{ name: '玉ねぎ', amount_g: 100, note: 'みじん切り' }, '玉ねぎ 100g (みじん切り)'],
      [{ name: '水', amount_g: 200, note: null }, '水 200g'],
      [{ name: '塩', amount_g: null, note: '少々' }, '塩 (少々)'],
      [{ name: 'こしょう', amount_g: null, note: null }, 'こしょう'],
      [{ name: '砂糖', amount_g: 0.5, note: null }, '砂糖 0.5g'],
    ];
    for (const [input, expected] of cases) {
      expect(ingredientLineOf(DishIngredientSchema.parse(input))).toBe(expected);
    }
  });
});
