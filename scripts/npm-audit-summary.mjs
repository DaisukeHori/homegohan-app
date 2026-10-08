#!/usr/bin/env node
/**
 * scripts/npm-audit-summary.mjs — `npm audit --json` の結果を、GitHub Actions の Summary 用の Markdown にまとめる
 * (.github/workflows/security.yml の npm-audit ジョブから呼ぶ。テストは tests/npm-audit-summary.test.ts)
 *
 *   node scripts/npm-audit-summary.mjs <npm-audit.json> >> "$GITHUB_STEP_SUMMARY"
 *
 * `npm audit` の通常の出力は、重大度を問わず全件を数百行で出す。ここでは件数と、critical のパッケージ
 * (何が critical で、どう直せるか) だけを表にする。
 * この結果で PR を止めるかどうかはワークフロー側で決める。ここは Markdown を出すだけで、
 * 結果のファイルが読めない・npm audit が失敗していたときも、その旨を書いて終了コード 0 で終わる。
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 件数の表に出す重大度 (重い順) */
export const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];

/** 表の 1 つのセルに入れる、脆弱性の題名の最大数と、1 つの題名の最大の長さ */
export const MAX_TITLES = 3;
export const MAX_TITLE_LENGTH = 90;

/** Markdown の表のセルに入れても崩れないようにする (改行・縦線・山括弧を無害にして、長いものは切る) */
function cell(value, maxLength = Infinity) {
  let text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
  return text.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** npm audit の fixAvailable (true / false / { name, version, isSemVerMajor }) を、直し方の文にする */
export function describeFix(fixAvailable) {
  if (fixAvailable === true) return '`npm audit fix` で直せる';
  if (fixAvailable && typeof fixAvailable === 'object') {
    const target = `\`${cell(fixAvailable.name)}@${cell(fixAvailable.version)}\``;
    return fixAvailable.isSemVerMajor ? `${target} に上げる (メジャー更新)` : `${target} に上げる`;
  }
  return '直った版がまだ無い';
}

/** critical のパッケージを、表に出す形にそろえる */
export function criticalPackages(report) {
  const vulnerabilities = report && typeof report.vulnerabilities === 'object' ? report.vulnerabilities : {};
  return Object.entries(vulnerabilities)
    .filter(([, v]) => v && v.severity === 'critical')
    .map(([name, v]) => {
      const via = Array.isArray(v.via) ? v.via : [];
      // critical と判定された理由 (critical の脆弱性の題名)。無ければ「どのパッケージ経由か」を出す
      const titles = [
        ...new Set(
          via
            .filter((x) => x && typeof x === 'object' && x.severity === 'critical' && x.title)
            .map((x) => cell(x.title, MAX_TITLE_LENGTH)),
        ),
      ];
      const through = via.filter((x) => typeof x === 'string').map((x) => cell(x));
      return {
        name,
        isDirect: v.isDirect === true,
        titles,
        through,
        fix: describeFix(v.fixAvailable),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** npm audit --json の結果 (読み込み済みのオブジェクト。読めなかったときは null) を、Summary 用の Markdown にする */
export function renderAuditSummary(report) {
  const lines = ['## npm audit (本番で動く依存パッケージ)', ''];

  if (!report || typeof report !== 'object') {
    lines.push('npm audit の結果を読めませんでした。ジョブのログを見てください。', '');
    return lines.join('\n');
  }

  if (report.error) {
    const reason = cell(report.error.summary || report.error.code || '原因不明', 200);
    lines.push(
      `npm audit を実行できませんでした (${reason})。npm のレジストリに接続できなかった可能性があります。`,
      '',
    );
    return lines.join('\n');
  }

  const counts = (report.metadata && report.metadata.vulnerabilities) || {};
  const critical = criticalPackages(report);

  lines.push(
    ...(critical.length > 0
      ? [
          '> 参考情報です。critical が残っている間は、この結果で PR を止めません (`continue-on-error`)。',
          '> critical が 0 件になったら、止める検査に切り替えます。',
        ]
      : [
          '> critical の脆弱性は 0 件です。`.github/workflows/security.yml` の npm-audit ジョブの `continue-on-error` を外して、',
          '> PR を止める検査に切り替えられます。',
        ]),
    '',
    '| 重大度 | 件数 |',
    '| --- | ---: |',
    ...SEVERITY_ORDER.filter((s) => s !== 'info' || counts.info > 0).map((s) => `| ${s} | ${Number(counts[s] ?? 0)} |`),
    '',
  );

  if (critical.length === 0) return lines.join('\n');

  lines.push(
    '### critical の内訳',
    '',
    '| パッケージ | 直接の依存 | critical の内容 | 直し方 |',
    '| --- | --- | --- | --- |',
  );
  for (const pkg of critical) {
    const reason =
      pkg.titles.length > 0
        ? pkg.titles.slice(0, MAX_TITLES).join('<br>') +
          (pkg.titles.length > MAX_TITLES ? `<br>ほか ${pkg.titles.length - MAX_TITLES} 件` : '')
        : pkg.through.length > 0
          ? `依存先 (${pkg.through.slice(0, MAX_TITLES).join(', ')}) の脆弱性`
          : '(題名なし)';
    lines.push(`| \`${cell(pkg.name)}\` | ${pkg.isDirect ? 'はい' : 'いいえ (他のパッケージ経由)'} | ${reason} | ${pkg.fix} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** CLI: 引数のファイル (npm audit --json の結果) を読み、Markdown を標準出力に出す */
export function main(argv, { read = (file) => readFileSync(file, 'utf8'), write = (s) => process.stdout.write(s) } = {}) {
  const [file] = argv;
  if (!file) {
    console.error('usage: node scripts/npm-audit-summary.mjs <npm-audit.json>');
    return 2;
  }
  let report = null;
  try {
    report = JSON.parse(read(file));
  } catch {
    // 空のファイル・壊れた JSON は、読めなかったものとして扱う
    report = null;
  }
  write(renderAuditSummary(report));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
