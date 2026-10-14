#!/usr/bin/env node
/**
 * Cron の共有シークレット (CRON_SECRET) が、Supabase の Edge Function secrets・Supabase Vault (app_cron_secret)・
 * Vercel の環境変数で食い違っていないかを、値を表示せずに確かめる (#1196)。
 *
 *   node scripts/check-cron-secret-drift.mjs --project-ref <ref>
 *   node scripts/check-cron-secret-drift.mjs --project-ref <ref> --vault-digest <SQL Editor で得たダイジェスト>
 *
 * どの保管場所も読むだけで、書き換えない。本番の資格情報が要るので、実行するのはオーナー。
 * 確認項目・オプションは --help を参照。使い方は ENV_SETUP.md の「Cron の共有シークレットの保管場所とローテーション」。
 * 本体は scripts/lib/cron-secret-drift.mjs (単体テストから使えるよう分けてある。この入口は常に main() を実行する)。
 */
import { main } from './lib/cron-secret-drift.mjs';

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // 例外の文に何が入っているか分からないので、出さない (値を出力しないため)
    console.error('check-cron-secret-drift: 予期しないエラーで止まりました');
    process.exitCode = 2;
  },
);
