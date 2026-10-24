import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { Tables } from '@homegohan/shared';
import { addDaysToDate, todayLocal } from '@/lib/date-utils';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

/** 400: 食材の一覧 (ingredients) が無い・空 */
const INGREDIENTS_REQUIRED_MESSAGE = '登録する食材を 1 つ以上指定してください';
/** 500: 置き換えの前の冷蔵庫の中身を読めない・消せない (原因はサーバーのログにだけ残す) */
const PANTRY_REPLACE_FAILED_MESSAGE = '冷蔵庫の中身を置き換えられませんでした。時間をおいて、もう一度お試しください';

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

  // JST の今日から暦の計算でずらす (#1463。parseLocalDate + setDate (ローカル時刻) + formatLocalDate (JST) は、
  // JST より東のタイムゾーンで動くと 1 日前になった)。日数は以前の setDate と同じく 0 の方向へ切り捨てる。
  // 暦の計算で扱える範囲の外に出るほど大きな日数 (AI の出力) は、推定できないとして null にする
  try {
    return addDaysToDate(todayLocal(), Math.trunc(daysRemaining));
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { ingredients, mode = 'append', imageUrl } = body as {
      ingredients: IngredientInput[];
      mode: 'append' | 'replace';
      imageUrl?: string;
    };

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return NextResponse.json({ error: INGREDIENTS_REQUIRED_MESSAGE }, { status: 400 });
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
        return NextResponse.json({ error: PANTRY_REPLACE_FAILED_MESSAGE }, { status: 500 });
      }
      previousPantryItems = snapshotItems ?? [];

      const { error: deleteError } = await supabase
        .from('pantry_items')
        .delete()
        .eq('user_id', user.id);

      if (deleteError) {
        console.error('Failed to delete existing pantry items:', deleteError);
        return NextResponse.json({ error: PANTRY_REPLACE_FAILED_MESSAGE }, { status: 500 });
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
            added_at: todayLocal(),
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
              added_at: todayLocal(),
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
      // rollbackSucceeded をレスポンスに反映し、失敗内容に応じてメッセージを分岐する。
      // - restoreFailed（旧データ復元insert自体が失敗）: 旧データが失われた可能性がある
      //   （delete が成功していれば新旧どちらも無い状態、失敗していても旧データは戻っていない）
      // - rollbackDeleteFailed のみ（旧データ復元は成功、新規挿入分の削除だけ失敗）: 旧データは
      //   無事だが新規挿入分が残留しており、重複している可能性がある（データ消失ではない）
      const rollbackSucceeded = !rollbackDeleteFailed && !restoreFailed;
      const message = rollbackSucceeded
        ? '冷蔵庫の置き換え (replace) が部分的に失敗したため、元のデータへロールバックしました'
        : restoreFailed
          ? '冷蔵庫の置き換え (replace) が部分的に失敗し、旧データの復元にも失敗しました。冷蔵庫データが失われた可能性があります。サポートへ連絡してください'
          : '冷蔵庫の置き換え (replace) が部分的に失敗し、新規追加分の削除ロールバックに失敗しました。旧データは復元済みのため、新規追加分と重複している可能性があります。内容をご確認ください';

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
    return internalError('POST /api/pantry/from-photo', error, { userId: user.id });
  }
}
