import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { toShoppingListItem } from '@/lib/converter';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { getOrCreateActiveShoppingList } from '@/lib/shopping-list/active-list';

type IngredientInput = { name: string; amount: string | null };

function normalizeAmount(amount: unknown): string | null {
  if (typeof amount === 'string') return amount.trim() || null;
  if (typeof amount === 'number' && Number.isFinite(amount)) return String(amount);
  return null;
}

// リクエストの ingredients を検証して正規化する。
// - name が文字列でない要素 (オブジェクトでない・name が無い) が 1 件でもあれば null (= 400)。
//   (name が文字列でないと、後続の categorizeIngredient の name.includes が TypeError になり 500 になっていた)
// - name が空白だけの要素は、買い物リストに載せても意味が無いので取り除く。
//   リクエスト全体は拒否しない (空の材料名が 1 件混ざっていても、他の食材は従来どおり追加できるようにする)。
function parseIngredients(raw: unknown[]): IngredientInput[] | null {
  const parsed: IngredientInput[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return null;
    const { name, amount } = item as { name?: unknown; amount?: unknown };
    if (typeof name !== 'string') return null;
    const trimmedName = name.trim();
    if (trimmedName === '') continue;
    parsed.push({ name: trimmedName, amount: normalizeAmount(amount) });
  }
  return parsed;
}

export async function POST(request: Request) {
  const logger = createLogger('POST /api/shopping-list/add-recipe', generateRequestId());

  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rawIngredients = (body as { ingredients?: unknown } | null)?.ingredients;
  if (!Array.isArray(rawIngredients)) {
    return NextResponse.json({ error: 'ingredients must be an array' }, { status: 400 });
  }
  const ingredients = parseIngredients(rawIngredients);
  if (!ingredients) {
    return NextResponse.json({ error: 'each ingredient must have a string name' }, { status: 400 });
  }

  // 追加する食材が無ければ DB に触れない (空の買い物リストを作らない)
  if (ingredients.length === 0) {
    return NextResponse.json({ items: [] });
  }

  try {
    // アクティブな買い物リストを取得、なければ作成。DB 関数 get_or_create_active_shopping_list に任せる。
    // 同時に 2 件の追加が来ても (#1214)、買い物リストの再生成 (アーカイブ -> 新規作成) と同時に走っても (#1312)、
    // ユーザーごとのロックで 1 件ずつ処理されるので、どちらも一意制約違反 (23505) で失敗しない
    const shoppingList = await getOrCreateActiveShoppingList(supabase, user.id);

    // Create shopping list items from ingredients
    const newItems = ingredients.map((ing) => ({
      shopping_list_id: shoppingList.id,
      item_name: ing.name,
      normalized_name: ing.name, // 手動追加は item_name をそのまま使用
      quantity: ing.amount,
      quantity_variants: ing.amount ? [{ display: ing.amount, unit: '', value: null }] : [],
      selected_variant_index: 0,
      source: 'manual',
      category: categorizeIngredient(ing.name),
      is_checked: false
    }));

    const { data: insertedItems, error: insertError } = await supabase
      .from('shopping_list_items')
      .insert(newItems)
      .select();

    if (insertError) throw insertError;

    return NextResponse.json({
      items: insertedItems.map((item: any) => toShoppingListItem(item))
    });
  } catch (error: unknown) {
    // 生のエラー文 (テーブル名・制約名・行の値を含み得る) はクライアントに返さず、サーバーログにだけ残す (#1172 の方針)。
    // PostgREST のエラーは Error ではなく { code, message, details, hint } のプレーンオブジェクトなので、ログ用に Error へ包む。
    const pgError = error as { code?: unknown; message?: unknown } | null;
    logger.withUser(user.id).error(
      'Add recipe to shopping list failed',
      error instanceof Error ? error : new Error(String(pgError?.message ?? error)),
      { pg_code: typeof pgError?.code === 'string' ? pgError.code : undefined },
    );
    return NextResponse.json({ error: '買い物リストへの追加に失敗しました' }, { status: 500 });
  }
}

// Simple categorization based on ingredient name
function categorizeIngredient(name: string): string {
  const categories: Record<string, string[]> = {
    '野菜': ['キャベツ', 'にんじん', '玉ねぎ', 'ほうれん草', 'もやし', 'トマト', 'レタス', 'きゅうり', 'なす', 'ピーマン', 'ねぎ', '大根', 'じゃがいも', 'ごぼう', 'れんこん', 'ブロッコリー', 'アスパラ'],
    '肉': ['鶏', '豚', '牛', 'ひき肉', 'ベーコン', 'ハム', 'ソーセージ', 'ウインナー'],
    '魚': ['鮭', 'さば', 'あじ', 'いわし', 'まぐろ', 'えび', 'いか', 'たこ', 'かに', '貝'],
    '乳製品': ['牛乳', 'チーズ', 'ヨーグルト', 'バター', '生クリーム'],
    '調味料': ['醤油', '味噌', '塩', '砂糖', '酢', '酒', 'みりん', 'だし', 'ソース', 'ケチャップ', 'マヨネーズ', '油', 'オリーブオイル', 'ごま油'],
    '乾物': ['わかめ', 'ひじき', '昆布', '干ししいたけ', '切り干し大根', 'のり', 'かつお節'],
    '豆腐・大豆': ['豆腐', '油揚げ', '厚揚げ', '納豆', '豆乳'],
    '卵': ['卵', 'たまご'],
    '麺・米': ['米', 'パスタ', 'うどん', 'そば', 'ラーメン', '中華麺']
  };

  for (const [category, keywords] of Object.entries(categories)) {
    if (keywords.some(keyword => name.includes(keyword))) {
      return category;
    }
  }
  return 'その他';
}
