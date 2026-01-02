#!/usr/bin/env node

/**
 * DBからログを読み取るスクリプト
 * 
 * 使い方:
 *   node scripts/read-logs.mjs                     # 最新50件
 *   node scripts/read-logs.mjs --level error       # エラーのみ
 *   node scripts/read-logs.mjs --source edge-function  # Edge Functionsのみ
 *   node scripts/read-logs.mjs --function generate-weekly-menu-v2
 *   node scripts/read-logs.mjs --since 1h          # 過去1時間
 *   node scripts/read-logs.mjs --tail              # リアルタイムポーリング
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// .env.local を読み込む
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ 環境変数 NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定してください');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// コマンドライン引数をパース
const args = process.argv.slice(2);
let level = null;
let source = null;
let functionName = null;
let sinceHours = 24;
let tailMode = false;
let limit = 50;
let userId = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--level' && args[i + 1]) {
    level = args[i + 1];
    i++;
  } else if (args[i] === '--source' && args[i + 1]) {
    source = args[i + 1];
    i++;
  } else if (args[i] === '--function' && args[i + 1]) {
    functionName = args[i + 1];
    i++;
  } else if (args[i] === '--user' && args[i + 1]) {
    userId = args[i + 1];
    i++;
  } else if (args[i] === '--since' && args[i + 1]) {
    const match = args[i + 1].match(/^(\d+)([hmd])$/);
    if (match) {
      const value = parseInt(match[1]);
      if (match[2] === 'h') sinceHours = value;
      else if (match[2] === 'm') sinceHours = value / 60;
      else if (match[2] === 'd') sinceHours = value * 24;
    }
    i++;
  } else if (args[i] === '--tail') {
    tailMode = true;
  } else if (args[i] === '--limit' && args[i + 1]) {
    limit = parseInt(args[i + 1]);
    i++;
  }
}

async function fetchLogs(afterTimestamp = null) {
  const startTime = afterTimestamp || new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  
  let query = supabase
    .from('app_logs')
    .select('*')
    .gte('created_at', startTime)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (level) query = query.eq('level', level);
  if (source) query = query.eq('source', source);
  if (functionName) query = query.eq('function_name', functionName);
  if (userId) query = query.eq('user_id', userId);

  const { data, error } = await query;

  if (error) {
    console.error('❌ クエリエラー:', error.message);
    return [];
  }

  return data || [];
}

function formatLog(log) {
  const levelColors = {
    'error': '\x1b[31m',   // 赤
    'warn': '\x1b[33m',    // 黄
    'info': '\x1b[36m',    // シアン
    'debug': '\x1b[90m',   // グレー
  };
  const sourceColors = {
    'edge-function': '\x1b[35m',  // マゼンタ
    'api-route': '\x1b[34m',      // 青
    'client': '\x1b[32m',         // 緑
  };
  
  const color = levelColors[log.level] || '\x1b[0m';
  const srcColor = sourceColors[log.source] || '\x1b[0m';
  const reset = '\x1b[0m';

  let output = `${color}[${log.created_at}] [${log.level.toUpperCase()}]${reset} `;
  output += `${srcColor}[${log.source}]${reset} `;
  
  if (log.function_name) {
    output += `[${log.function_name}] `;
  }
  
  if (log.user_id) {
    output += `[user:${log.user_id.substring(0, 8)}...] `;
  }
  
  output += log.message;
  
  if (log.error_message) {
    output += `\n  └─ Error: ${log.error_message}`;
  }
  
  if (log.metadata && Object.keys(log.metadata).length > 0) {
    output += `\n  └─ Metadata: ${JSON.stringify(log.metadata)}`;
  }

  return output;
}

async function main() {
  console.log('🔍 アプリケーションログを取得中...');
  console.log(`   期間: 過去${sinceHours}時間`);
  if (level) console.log(`   レベル: ${level}`);
  if (source) console.log(`   ソース: ${source}`);
  if (functionName) console.log(`   関数: ${functionName}`);
  console.log('');

  if (tailMode) {
    console.log('📡 Tail モード（3秒ごとにポーリング）- Ctrl+C で終了');
    console.log('─'.repeat(80));
    
    let lastTimestamp = new Date(Date.now() - 60000).toISOString(); // 1分前から開始
    const seenIds = new Set();
    
    while (true) {
      const logs = await fetchLogs(lastTimestamp);
      
      // 新しいログを逆順で表示（古い順）
      const newLogs = logs.filter(log => !seenIds.has(log.id)).reverse();
      
      for (const log of newLogs) {
        console.log(formatLog(log));
        seenIds.add(log.id);
        lastTimestamp = log.created_at;
      }
      
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } else {
    const logs = await fetchLogs();
    
    if (logs.length === 0) {
      console.log('📭 ログが見つかりませんでした');
    } else {
      console.log(`📋 ${logs.length} 件のログ:`);
      console.log('─'.repeat(80));
      
      // 古い順で表示
      for (const log of logs.reverse()) {
        console.log(formatLog(log));
      }
    }
  }
}

main().catch(console.error);
