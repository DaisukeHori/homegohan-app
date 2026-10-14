#!/usr/bin/env node
/**
 * 環境変数の検査 (#1182)。古い check-env.sh の置き換え。
 *
 *   npm run check:env
 *   npm run check:env -- --file=.env.production.local
 *
 * 必須の環境変数 (Supabase の接続情報) が足りなければ終了コード 1。任意の変数の未設定は説明を表示するだけ。
 * 検査の規則は src/lib/env.ts の zod スキーマと同じ。オプションは --help を参照。
 * 本体は scripts/lib/check-env.mjs (単体テストから使えるよう分けてある。この入口は常に main() を実行する)。
 */
import { main } from './lib/check-env.mjs';

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`check-env: 予期しないエラー: ${error?.message ?? error}`);
    process.exitCode = 2;
  },
);
