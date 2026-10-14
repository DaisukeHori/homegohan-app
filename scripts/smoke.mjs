#!/usr/bin/env node
/**
 * デプロイ後 / DR 復元後の smoke test (#1181)。
 *
 *   npm run test:smoke -- --base-url=https://staging.homegohan.app
 *
 * 確認項目・オプションは --help を参照。本体は scripts/lib/smoke.mjs
 * (単体テストから使えるよう分けてある。この入口は常に main() を実行する)。
 */
import { main } from './lib/smoke.mjs';

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`smoke: 予期しないエラー: ${error?.message ?? error}`);
    process.exitCode = 1;
  },
);
