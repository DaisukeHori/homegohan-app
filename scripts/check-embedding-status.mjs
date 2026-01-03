#!/usr/bin/env node

/**
 * 埋め込み再生成の進捗状況を確認して報告
 * LLMがこのスクリプトを実行して進捗を確認できる
 */

import { readFileSync } from 'fs';

const STATUS_FILE = "/tmp/embedding-status.json";

try {
  const status = JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 埋め込みベクトル再生成 - 進捗状況');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  if (status.allDone) {
    console.log('✅ 埋め込みベクトル再生成が完了しました！');
    console.log('   全テーブルの処理が正常に完了しました。\n');
  } else if (status.error) {
    console.log(`⚠️  エラー: ${status.error}\n`);
  } else if (status.currentTable && status.progress) {
    if (status.progress.completed) {
      console.log(`✅ ${status.currentTable}: 完了\n`);
    } else {
      console.log(`🔄 ${status.currentTable}: ${status.progress.current}/${status.progress.total} (${status.progress.percentage}%)`);
      if (status.progress.estimatedMinutesRemaining) {
        console.log(`⏱️  推定残り時間: 約${status.progress.estimatedMinutesRemaining}分\n`);
      }
    }
    
    if (status.tableStatus) {
      const completed = status.tableStatus.filter(t => t.status === 'completed').length;
      const processing = status.tableStatus.filter(t => t.status === 'processing').length;
      console.log(`進行状況: ${completed + processing}/3 テーブル`);
      status.tableStatus.forEach(table => {
        const icon = table.status === 'completed' ? '✅' : table.status === 'processing' ? '🔄' : '⏳';
        console.log(`  ${icon} ${table.name}`);
      });
      console.log('');
    }
  } else {
    console.log('⏸️  処理が開始されていないか、ログが見つかりません\n');
  }
  
  console.log(`最終更新: ${new Date(status.timestamp).toLocaleString('ja-JP')}\n`);
  
} catch (e) {
  if (e.code === 'ENOENT') {
    console.log('❌ ステータスファイルが見つかりません。監視プロセスが起動していない可能性があります。\n');
  } else {
    console.error('❌ エラー:', e.message);
  }
  process.exit(1);
}
