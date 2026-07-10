import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { Tables } from '@homegohan/shared';

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
    // #1042: 削除前に旧値をスナップショットしておき、逐次insertが部分的に
    // 失敗した場合は新規分をロールバックして旧データへ復元する（補償ロールバック）。
    let previousPantryItems: Tables<'pantry_items'>[] = [];
    if (mode === 'replace') {
      const { data: snapshotItems, error: snapshotError } = await supabase
        .from('pantry_items')
        .select('*')
        .eq('user_id', user.id);

      if (snapshotError) {
        console.error('Failed to snapshot existing pantry items:', snapshotError);
        return NextResponse.json({ error: 'Failed to prepare pantry replace' }, { status: 500 });
      }
      previousPantryItems = snapshotItems ?? [];

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
      items: [] as Tables<'pantry_items'>[],
    };
    // replace モードで新規挿入したID（ロールバック時の削除対象）と書き込み失敗件数
    const insertedPantryItemIds: string[] = [];
    let replaceWriteFailures = 0;

    // 各アイテムを処理
    for (const ingredient of ingredients) {
      if (!ingredient.name?.trim()) {
        results.skipped++;
        continue;
      }

      const trimmedName = ingredient.name.trim();
      const category = mapCategory(ingredient.category);
      const expirationDate = ingredient.expirationDate || estimateExpirationDate(ingredient.daysRemaining);

      if (mode === 'replace') {
        // replace モードでは単純にINSERT
        const { data: inserted, error: insertError } = await supabase
          .from('pantry_items')
          .insert({
            user_id: user.id,
            name: trimmedName,
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
          replaceWriteFailures++;
        } else {
          results.created++;
          results.items.push(inserted);
          insertedPantryItemIds.push(inserted.id);
        }
      } else {
        // append モードでは既存チェック → upsert
        const { data: existing } = await supabase
          .from('pantry_items')
          .select('id')
          .eq('user_id', user.id)
          .eq('name', trimmedName)
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
              name: trimmedName,
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

    // #1042: replace モードで書き込みが部分的に失敗した場合はロールバックする。
    // 削除済みの旧データと新規データが混在した中途半端な状態を残さないため、
    // 今回新規挿入した分を削除し、退避しておいた旧データを復元する。
    if (mode === 'replace' && replaceWriteFailures > 0) {
      let rollbackDeleteFailed = false;
      let restoreFailed = false;

      if (insertedPantryItemIds.length > 0) {
        const { error: rollbackDeleteError } = await supabase
          .from('pantry_items')
          .delete()
          .in('id', insertedPantryItemIds);
        if (rollbackDeleteError) {
          console.error('Failed to roll back partially inserted pantry items:', rollbackDeleteError);
          rollbackDeleteFailed = true;
        }
      }
      if (previousPantryItems.length > 0) {
        const { error: restoreError } = await supabase
          .from('pantry_items')
          .insert(previousPantryItems);
        if (restoreError) {
          console.error('Failed to restore previous pantry items after partial replace failure:', restoreError);
          restoreFailed = true;
        }
      }

      // #1042: ロールバック（新規分の削除・旧データの復元）自体が失敗した場合、
      // 「元のデータへロールバックしました」という誤ったメッセージを返してはいけない。
      // rollbackSucceeded をレスポンスに反映し、失敗時はデータ消失の可能性を明示する。
      const rollbackSucceeded = !rollbackDeleteFailed && !restoreFailed;
      const message = rollbackSucceeded
        ? 'Pantry replace が部分的に失敗したため、元のデータへロールバックしました'
        : 'Pantry replace が部分的に失敗し、ロールバックにも失敗しました。冷蔵庫データが失われた可能性があります。サポートへ連絡してください';

      return NextResponse.json(
        {
          error: message,
          rollbackSucceeded,
          results,
        },
        { status: 500 },
      );
    }

    // スナップショットを保存（履歴）
    if (imageUrl || results.created + results.updated > 0) {
      await supabase
        .from('fridge_snapshots')
        .insert({
          user_id: user.id,
          image_url: imageUrl || null,
          extracted_ingredients: ingredients,
          model_used: process.env.GEMINI_VISION_MODEL || 'gemini-3.1-flash-lite-preview',
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
