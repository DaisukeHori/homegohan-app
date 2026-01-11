import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * 冷蔵庫写真解析結果をpantry_itemsに保存
 *
 * mode:
 * - 'append': 既存のアイテムに追加（同名のアイテムは更新）
 * - 'replace': 全削除してから新規作成
 */

interface IngredientInput {
  name: string;
  amount?: string;
  category?: string;
  expirationDate?: string;  // YYYY-MM-DD
  freshness?: 'fresh' | 'good' | 'expiring_soon' | 'expired';
  daysRemaining?: number;
}

// カテゴリのマッピング（analyze-fridgeの出力からpantry_itemsのcategory値へ）
function mapCategory(category: string | undefined): string {
  if (!category) return 'other';

  const mapping: Record<string, string> = {
    '野菜': 'vegetable',
    '肉類': 'meat',
    '魚介類': 'fish',
    '乳製品': 'dairy',
    '卵': 'dairy',
    '調味料': 'other',
    '飲料': 'other',
    'その他': 'other',
    // 英語の場合
    'vegetable': 'vegetable',
    'meat': 'meat',
    'fish': 'fish',
    'dairy': 'dairy',
    'other': 'other',
  };

  return mapping[category] || 'other';
}

// 賞味期限を推定（daysRemainingから）
function estimateExpirationDate(daysRemaining: number | undefined): string | null {
  if (daysRemaining === undefined || daysRemaining < 0) return null;

  const date = new Date();
  date.setDate(date.getDate() + daysRemaining);
  return date.toISOString().split('T')[0];
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { ingredients, mode = 'append', imageUrl } = body as {
      ingredients: IngredientInput[];
      mode: 'append' | 'replace';
      imageUrl?: string;
    };

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return NextResponse.json({ error: 'Ingredients array is required' }, { status: 400 });
    }

    // mode='replace' の場合、既存アイテムを全削除
    if (mode === 'replace') {
      const { error: deleteError } = await supabase
        .from('pantry_items')
        .delete()
        .eq('user_id', user.id);

      if (deleteError) {
        console.error('Failed to delete existing pantry items:', deleteError);
        return NextResponse.json({ error: 'Failed to clear pantry' }, { status: 500 });
      }
    }

    // 処理結果
    const results = {
      created: 0,
      updated: 0,
      skipped: 0,
      items: [] as any[],
    };

    // 各アイテムを処理
    for (const ingredient of ingredients) {
      if (!ingredient.name) {
        results.skipped++;
        continue;
      }

      const category = mapCategory(ingredient.category);
      const expirationDate = ingredient.expirationDate || estimateExpirationDate(ingredient.daysRemaining);

      if (mode === 'replace') {
        // replace モードでは単純にINSERT
        const { data: inserted, error: insertError } = await supabase
          .from('pantry_items')
          .insert({
            user_id: user.id,
            name: ingredient.name,
            amount: ingredient.amount || null,
            category,
            expiration_date: expirationDate,
            added_at: new Date().toISOString().split('T')[0],
          })
          .select()
          .single();

        if (insertError) {
          console.error('Failed to insert pantry item:', insertError);
          results.skipped++;
        } else {
          results.created++;
          results.items.push(inserted);
        }
      } else {
        // append モードでは既存チェック → upsert
        const { data: existing } = await supabase
          .from('pantry_items')
          .select('id')
          .eq('user_id', user.id)
          .eq('name', ingredient.name)
          .maybeSingle();

        if (existing) {
          // 既存アイテムを更新
          const { data: updated, error: updateError } = await supabase
            .from('pantry_items')
            .update({
              amount: ingredient.amount || null,
              category,
              expiration_date: expirationDate,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id)
            .select()
            .single();

          if (updateError) {
            console.error('Failed to update pantry item:', updateError);
            results.skipped++;
          } else {
            results.updated++;
            results.items.push(updated);
          }
        } else {
          // 新規作成
          const { data: inserted, error: insertError } = await supabase
            .from('pantry_items')
            .insert({
              user_id: user.id,
              name: ingredient.name,
              amount: ingredient.amount || null,
              category,
              expiration_date: expirationDate,
              added_at: new Date().toISOString().split('T')[0],
            })
            .select()
            .single();

          if (insertError) {
            console.error('Failed to insert pantry item:', insertError);
            results.skipped++;
          } else {
            results.created++;
            results.items.push(inserted);
          }
        }
      }
    }

    // スナップショットを保存（履歴）
    if (imageUrl || results.created + results.updated > 0) {
      await supabase
        .from('fridge_snapshots')
        .insert({
          user_id: user.id,
          image_url: imageUrl || null,
          extracted_ingredients: ingredients,
          model_used: 'gemini-2.0-flash-exp',
        });
    }

    return NextResponse.json({
      success: true,
      mode,
      results,
    });

  } catch (error: any) {
    console.error("Pantry Save Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
