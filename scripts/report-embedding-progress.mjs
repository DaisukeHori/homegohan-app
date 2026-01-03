#!/usr/bin/env node

/**
 * 埋め込み再生成の進捗を確認して報告し、5分後に再実行をスケジュール
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATUS_FILE = "/tmp/embedding-status.json";
const LOG_FILE = "/tmp/embedding-resume.log";
const REPORT_FILE = "/tmp/embedding-report.txt";

function checkProgress() {
  try {
    // ログファイルから最新の進捗を取得
    const logContent = readFileSync(LOG_FILE, 'utf-8');
    const lines = logContent.split('\n');
    
    let currentTable = null;
    let progress = null;
    let allDone = false;
    
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
      if (line.includes('🎉 All done!')) {
        allDone = true;
      }
    }
    
    const now = new Date().toLocaleString('ja-JP');
    let report = `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    report += `📊 進捗レポート - ${now}\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    if (allDone) {
      report += `✅ 埋め込みベクトル再生成が完了しました！\n`;
      report += `   全テーブルの処理が正常に完了しました。\n\n`;
      writeFileSync(REPORT_FILE, report, 'utf-8');
      console.log(report);
      return false; // 完了したので再スケジュールしない
    }
    
    if (!currentTable || !progress) {
      report += `⏸️  処理が開始されていないか、ログが見つかりません\n\n`;
      writeFileSync(REPORT_FILE, report, 'utf-8');
      console.log(report);
      return true; // 続行
    }
    
    report += `🔄 ${currentTable}: ${progress.current}/${progress.total} (${progress.percentage}%)\n\n`;
    
    // 全体の進捗
    const tables = ['dataset_ingredients', 'dataset_recipes', 'dataset_menu_sets'];
    const currentIndex = tables.indexOf(currentTable);
    
    if (currentIndex >= 0) {
      report += `進行状況: ${currentIndex + 1}/3 テーブル\n`;
      tables.forEach((table, i) => {
        if (i < currentIndex) {
          report += `  ✅ ${table}\n`;
        } else if (i === currentIndex) {
          report += `  🔄 ${table} (処理中)\n`;
        } else {
          report += `  ⏳ ${table}\n`;
        }
      });
      report += `\n`;
    }
    
    // エラーチェック
    const errorLines = lines.filter(line => 
      line.toLowerCase().includes('error') || 
      line.includes('❌')
    );
    if (errorLines.length > 0) {
      report += `⚠️  エラーが検出されました:\n`;
      errorLines.slice(-3).forEach(line => report += `   ${line}\n`);
      report += `\n`;
    }
    
    writeFileSync(REPORT_FILE, report, 'utf-8');
    console.log(report);
    
    return true; // 続行
  } catch (e) {
    if (e.code === 'ENOENT') {
      const report = `⏸️  ログファイルが見つかりません。処理が開始されるまで待機します...\n\n`;
      writeFileSync(REPORT_FILE, report, 'utf-8');
      console.log(report);
      return true;
    } else {
      const report = `❌ エラー: ${e.message}\n\n`;
      writeFileSync(REPORT_FILE, report, 'utf-8');
      console.error(report);
      return true;
    }
  }
}

// 進捗を確認
const shouldContinue = checkProgress();

// 完了していない場合、5分後に再実行をスケジュール
if (shouldContinue) {
  const wrapperPath = resolve(__dirname, 'report-embedding-progress-wrapper.sh');
  
  // atコマンドで5分後に実行
  // ラッパースクリプトを使うことで、出力をターミナルに表示
  const atCommand = `echo '${wrapperPath}' | at now + 5 minutes 2>&1`;
  
  try {
    const result = execSync(atCommand, { encoding: 'utf-8' });
    console.log('⏰ 5分後に再実行をスケジュールしました');
    if (result.trim()) {
      console.log(`   ${result.trim()}\n`);
    } else {
      console.log('');
    }
  } catch (e) {
    // atコマンドが使えない場合、バックグラウンドでsleepしてから実行
    console.log('⏰ バックグラウンドで5分待機してから再実行します...\n');
    const bgCommand = `(sleep 300 && ${wrapperPath}) &`;
    execSync(bgCommand, { stdio: 'inherit' });
  }
}
