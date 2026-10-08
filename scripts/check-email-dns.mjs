#!/usr/bin/env node
/**
 * メール送信用の DNS レコード (Resend の DKIM / Return-Path / DMARC) が、公開 DNS から見えているかを確かめる (#1194)。
 *
 *   node scripts/check-email-dns.mjs
 *   node scripts/check-email-dns.mjs --send-domain mail.homegohan.com --from "ほめゴハン <noreply@mail.homegohan.com>"
 *
 * DNS を引くだけで、何も書き換えない。確認項目・オプションは --help を参照。手順の全体は docs/operations/email-domain.md。
 * 本体は scripts/lib/email-dns.mjs (単体テストから使えるよう分けてある。この入口は常に main() を実行する)。
 */
import { main } from './lib/email-dns.mjs';

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`check-email-dns: 予期しないエラー: ${error?.message ?? error}`);
    process.exitCode = 1;
  },
);
