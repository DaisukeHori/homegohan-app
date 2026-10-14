#!/usr/bin/env node

/**
 * 埋め込み再生成の進捗を確認して報告し、5分後に再実行をスケジュール
 */

import { readFileSync, writeFileSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { quoteShellArg } from './lib/shell-quote-arg.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATUS_FILE = "/tmp/embedding-status.json";
const LOG_FILE = "/tmp/embedding-resume.log";
const REPORT_FILE = "/tmp/embedding-report.txt";
/** 完了していないときに、次に進捗を見るまでの間隔 (分) */
const RERUN_DELAY_MINUTES = 5;
const SECONDS_PER_MINUTE = 60;


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
  // #1444 (CodeQL js/shell-command-injection-from-environment): パスをシェルのコマンド文字列に埋め込まない。
  // at はシェルを通さずに引数の配列で起動する。at は標準入力をジョブとしてシェルで実行するので、
  // 実行するパスはシェルの 1 語に引用してから標準入力で渡す
  try {
    const at = spawnSync('at', ['now', '+', String(RERUN_DELAY_MINUTES), 'minutes'], {
      encoding: 'utf-8',
      input: `${quoteShellArg(wrapperPath)}\n`,
    });
    if (at.error) throw at.error;
    if (at.status !== 0) throw new Error(`at exited with ${at.status}: ${at.stderr}`);
    // at は「job N at ...」を標準エラーに出す (以前は 2>&1 でまとめて表示していた)
    const result = `${at.stdout}${at.stderr}`;
    console.log('⏰ 5分後に再実行をスケジュールしました');
    if (result.trim()) {
      console.log(`   ${result.trim()}\n`);
    } else {
      console.log('');
    }
  } catch (e) {
    // atコマンドが使えない場合、バックグラウンドでsleepしてから実行
    console.log('⏰ バックグラウンドで5分待機してから再実行します...\n');
    // パスはシェルの文字列に埋め込まず、位置引数 ($1) で渡す
    const child = spawn('sh', ['-c', 'sleep "$0" && exec "$1"', String(RERUN_DELAY_MINUTES * SECONDS_PER_MINUTE), wrapperPath], {
      detached: true,
      stdio: 'inherit',
    });
    child.unref();
  }
}
