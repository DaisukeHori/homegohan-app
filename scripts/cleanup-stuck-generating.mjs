#!/usr/bin/env node
/**
 * is_generating=true のまま残っているレコードをクリーンアップするスクリプト
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ 環境変数が設定されていません: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  console.log('🔍 is_generating=true のレコードを検索中...');

  // is_generating=true のレコードを取得
  const { data: stuckRecords, error: fetchError } = await supabase
    .from('planned_meals')
    .select('id, dish_name, meal_type, is_generating, created_at, updated_at')
    .eq('is_generating', true)
    .order('created_at', { ascending: false });

  if (fetchError) {
    console.error('❌ 取得エラー:', fetchError);
    process.exit(1);
  }

  console.log(`📋 見つかったレコード数: ${stuckRecords?.length || 0}`);

  if (!stuckRecords || stuckRecords.length === 0) {
    console.log('✅ スタックしたレコードはありません');
    return;
  }

  // 各レコードを表示
  for (const record of stuckRecords) {
    console.log(`  - ID: ${record.id}`);
    console.log(`    dish_name: ${record.dish_name}`);
    console.log(`    meal_type: ${record.meal_type}`);
    console.log(`    created_at: ${record.created_at}`);
    console.log('');
  }

  // レコードを更新
  console.log('🔧 is_generating=false に更新中...');

  const ids = stuckRecords.map(r => r.id);

  const { error: updateError, count } = await supabase
    .from('planned_meals')
    .update({
      is_generating: false,
      dish_name: '生成に失敗しました',
      updated_at: new Date().toISOString(),
    })
    .in('id', ids);

  if (updateError) {
    console.error('❌ 更新エラー:', updateError);
    process.exit(1);
  }

  console.log(`✅ ${stuckRecords.length}件のレコードを更新しました`);
}

main().catch(console.error);
