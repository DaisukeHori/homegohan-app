#!/usr/bin/env node

/**
 * 埋め込み再生成の進捗を5分おきに監視
 */

import { readFileSync, writeFileSync } from 'fs';

const LOG_FILE = "/tmp/embedding-resume.log";
const STATUS_FILE = "/tmp/embedding-status.json"; // 進捗状況を保存するファイル
const CHECK_INTERVAL = 5 * 60 * 1000; // 5分

function parseProgress(logContent) {
  const lines = logContent.split('\n');
  
  // 最新の進捗行を探す
  let currentTable = null;
  let progress = null;
  
  for (const line of lines) {
    if (line.includes('Processing dataset_')) {
      const match = line.match(/Processing (dataset_\w+)/);
      if (match) currentTable = match[1];
    }
    if (line.includes('Progress:')) {
      const match = line.match(/Progress: (\d+)\/(\d+) \(([0-9.]+)%\)/);
      if (match) {
        progress = {
          current: parseInt(match[1]),
          total: parseInt(match[2]),
          percentage: parseFloat(match[3]),
        };
      }
    }
    if (line.includes('Completed')) {
      const match = line.match(/Completed (dataset_\w+)/);
      if (match) {
        currentTable = match[1];
        progress = { completed: true };
      }
    }
    // "All done!" で完了を検出
    if (line.includes('🎉 All done!')) {
      progress = { allDone: true };
    }
  }
  
  return { currentTable, progress };
}

const startTime = Date.now();

function saveStatus(status) {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), 'utf-8');
  } catch (e) {
    console.error('❌ ステータスファイルの書き込みエラー:', e.message);
  }
}

function checkProgress() {
  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    const { currentTable, progress } = parseProgress(content);
    
    const now = new Date().toLocaleTimeString('ja-JP');
    const timestamp = new Date().toISOString();
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📊 進捗レポート - ${now}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    let status = {
      timestamp,
      currentTable: null,
      progress: null,
      allDone: false,
      error: null
    };
    
    if (!currentTable) {
      console.log('⏸️  処理が開始されていないか、ログが見つかりません');
      status.currentTable = null;
      saveStatus(status);
      return;
    }
    
    if (progress?.allDone) {
      console.log(`\n🎉 埋め込みベクトル再生成が完了しました！`);
      console.log(`   全テーブルの処理が正常に完了しました。`);
      status.allDone = true;
      status.currentTable = 'all';
      saveStatus(status);
      process.exit(0);
    } else if (progress?.completed) {
      console.log(`✅ ${currentTable}: 完了`);
      status.currentTable = currentTable;
      status.progress = { completed: true };
    } else if (progress) {
      console.log(`🔄 ${currentTable}: ${progress.current}/${progress.total} (${progress.percentage}%)`);
      
      // 残り時間を推定
      const elapsedMinutes = (Date.now() - startTime) / 60000;
      let estimatedMinutesRemaining = null;
      if (progress.current > 0 && progress.percentage > 0 && elapsedMinutes > 0) {
        const itemsRemaining = progress.total - progress.current;
        const itemsPerMinute = progress.current / elapsedMinutes;
        const minutesRemaining = itemsRemaining / itemsPerMinute;
        
        if (minutesRemaining > 0 && minutesRemaining < 1000) {
          estimatedMinutesRemaining = Math.round(minutesRemaining);
          console.log(`⏱️  推定残り時間: 約${estimatedMinutesRemaining}分`);
        }
      }
      
      status.currentTable = currentTable;
      status.progress = {
        ...progress,
        estimatedMinutesRemaining
      };
    }
    
    // 全体の進捗
    const tables = ['dataset_ingredients', 'dataset_recipes', 'dataset_menu_sets'];
    const currentIndex = tables.indexOf(currentTable);
    
    if (currentIndex >= 0) {
      console.log(`\n進行状況: ${currentIndex + 1}/3 テーブル`);
      tables.forEach((table, i) => {
        if (i < currentIndex) {
          console.log(`  ✅ ${table}`);
        } else if (i === currentIndex) {
          console.log(`  🔄 ${table} (処理中)`);
        } else {
          console.log(`  ⏳ ${table}`);
        }
      });
      
      status.tableStatus = tables.map((table, i) => ({
        name: table,
        status: i < currentIndex ? 'completed' : i === currentIndex ? 'processing' : 'pending'
      }));
    }
    
    saveStatus(status);
    
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('⏸️  ログファイルが見つかりません。処理が開始されるまで待機します...');
      saveStatus({
        timestamp: new Date().toISOString(),
        error: 'ログファイルが見つかりません'
      });
    } else {
      console.error('❌ エラー:', e.message);
      saveStatus({
        timestamp: new Date().toISOString(),
        error: e.message
      });
    }
  }
}

console.log('🚀 埋め込み再生成の監視を開始します');
console.log(`   5分おきに進捗をチェックします`);
console.log(`   ログ: ${LOG_FILE}`);

// 初回実行
checkProgress();

// 5分おきに実行
setInterval(checkProgress, CHECK_INTERVAL);

// エラー検出も追加
setInterval(() => {
  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    const errorLines = content.split('\n').filter(line => 
      line.toLowerCase().includes('error') || 
      line.includes('❌')
    );
    if (errorLines.length > 0) {
      console.log('\n⚠️  エラーが検出されました:');
      errorLines.slice(-5).forEach(line => console.log(`   ${line}`));
    }
  } catch (e) {
    // ログファイルが存在しない場合は無視
  }
}, CHECK_INTERVAL);
