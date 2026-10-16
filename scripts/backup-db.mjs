#!/usr/bin/env node
/**
 * scripts/backup-db.mjs — 本番 DB の論理バックアップの入口 (#1129 / #1191)
 * (.github/workflows/db-backup.yml から呼ぶ。本体と使い方は scripts/lib/backup-db.mjs。設計は docs/design/cross/17-backup-automation.md)
 *
 *   node scripts/backup-db.mjs run [--tier auto|daily|weekly|annual] [--result-file <path>]
 *   node scripts/backup-db.mjs restore --key <R2 のキー> --identity-file <path> [--slot <枠>]
 *   node scripts/backup-db.mjs roundtrip-local [--slot <枠>]
 *   node scripts/backup-db.mjs report-issue --result-file <path> --run-outcome <outcome> --run-url <url>
 *   node scripts/backup-db.mjs r2-config --bucket <name> --out-dir <dir>
 *
 * リポジトリの直下で動かす (scripts/・supabase/ を相対のパスで読む)。
 */

import { pathToFileURL } from 'node:url';

import { installSignalCleanup, runCli } from './lib/backup-db.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installSignalCleanup();
  process.exitCode = await runCli(process.argv.slice(2));
}
