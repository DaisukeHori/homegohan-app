/**
 * #1911: 利用者・公開ページ・運営の画面に、「準備中」「まだできていません」のような未完成・予定を示す文を出さない
 *
 * 未完成の機能は「準備中」と出さずに画面から出さない (選べない・見えない)。予定の告知 (「決まりましたらご案内します」
 * 「確定次第掲載します」など) は書かず、いまの事実だけを書く。読み込み中の表示も「準備中…」とは書かない
 * (「読み込んでいます…」「分析しています…」など、別の言い方は許す)。
 *
 * ここでは、見える文の置き場所 (画面・部品・紹介ページの文・メールの文面・モバイルの画面・API が返す文の定数・
 * 画面が読む hooks・Edge Function が行に書く文) のソースから、コメントを除いた部分に、禁止の語が無いことを確かめる。
 * コメント・テスト・開発者向けの文書は対象外。
 * 見える文はソースの外 (DB の列の既定値) にも置かれる。生成のリクエストの行の progress の既定値の message は
 * 画面に届くので、SQL の既定値に禁止の語があれば、それが progress の既定値 (phase 'pending') であり、
 * 画面に出す前の置き換え (src/lib/request-progress-display.ts) が禁止の語の無い文にすることを確かめる。
 * 問い合わせの状態の「未対応」(まだ対応していない問い合わせ) は未完成の意味ではないので、括弧つきの「（未対応）」だけを禁じる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_DEFAULT_REQUEST_PROGRESS_PHASE, requestProgressForDisplay } from '@/lib/request-progress-display';
import { findProgressDefaults, findSqlDefaultLiterals } from './helpers/db-progress-defaults';

const ROOT = path.resolve(__dirname, '..');

/**
 * 見える文を持つファイルを探すディレクトリ (この下の .ts / .tsx を全部見る。テストは除く)。
 * src/lib・src/hooks・apps/mobile/src は、画面や API の応答に出る文の定数・既定の文を持つ。
 * supabase/functions は、Edge Function が行 (progress・error_message など) に書き、画面がそのまま出す文を持つ。
 */
const SCAN_DIRS = [
  'src/app',
  'src/components',
  'src/lib',
  'src/hooks',
  'apps/mobile/app',
  'apps/mobile/src',
  'supabase/functions',
] as const;

/** ディレクトリの外にあり、画面や API の応答に出る文を持つファイル */
const SCAN_FILES = [
  'src/components/marketing/landing-copy.ts',
  'src/lib/billing/core.ts',
  'src/lib/admin/moderation-backend.ts',
  'src/lib/super-admin/exports-schemas.ts',
  'src/lib/billing/public-plans.ts',
] as const;

/** 未完成・予定を示す語 (#1911) */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /準備中/, reason: '未完成の機能を「準備中」と出さない (読み込み中も別の言い方にする)' },
  { pattern: /販売開始前/, reason: '販売の予定を書かない' },
  { pattern: /近日/, reason: '予定を書かない' },
  { pattern: /公開予定/, reason: '予定を書かない' },
  { pattern: /確定次第/, reason: '予定を書かない' },
  { pattern: /決まり次第/, reason: '予定を書かない' },
  { pattern: /決まりましたら/, reason: '予定を書かない' },
  { pattern: /順次整備/, reason: '予定を書かない' },
  { pattern: /coming soon/i, reason: '予定を書かない' },
  { pattern: /まだ作られて/, reason: '未完成であることを書かない' },
  { pattern: /[（(]未対応[）)]/, reason: '未完成の機能を「（未対応）」と出さない' },
  { pattern: /予定です/, reason: '予定を書かない' },
  { pattern: /できてから選べる/, reason: '予定を書かない' },
];

/** テストのファイル (__tests__ の下・*.test.*) は見ない */
function isScannedSource(relativePath: string): boolean {
  if (!/\.(ts|tsx)$/.test(relativePath)) return false;
  if (relativePath.split(path.sep).includes('__tests__')) return false;
  return !/\.test\.(ts|tsx)$/.test(relativePath);
}

function listSources(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  const found: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      found.push(...listSources(relative));
    } else if (isScannedSource(relative)) {
      found.push(relative);
    }
  }
  return found;
}

/**
 * コメントを取り除く (行の数は保つ)。ブロックコメント (JSX の {\/* *\/} を含む) と行コメント。
 * 行コメントは、直前が「:」(URL の https://) と「\」(正規表現の中) のときは取り除かない。
 */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) => '\n'.repeat(block.split('\n').length - 1));
  return withoutBlocks.replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** ソース (コメントを除く) に出てくる禁止の語。`file:line 語 (理由)` の形 */
function findPendingWording(file: string, source: string): string[] {
  const problems: string[] = [];
  stripComments(source)
    .split('\n')
    .forEach((line, index) => {
      for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
        const match = pattern.exec(line);
        if (match) problems.push(`${file}:${index + 1} 「${match[0]}」(${reason}): ${line.trim().slice(0, 120)}`);
      }
    });
  return problems;
}

const scannedFiles = [...new Set([...SCAN_DIRS.flatMap((dir) => listSources(dir)), ...SCAN_FILES])].sort();

describe('#1911 見える文に「準備中」「まだできていません」のような未完成・予定の文が無い', () => {
  it('走査の対象が空でない (ディレクトリごとに 1 つ以上のファイルを見ている)', () => {
    for (const dir of SCAN_DIRS) {
      expect(scannedFiles.some((file) => file.startsWith(`${dir}${path.sep}`)), `${dir} の下を 1 つも見ていない`).toBe(true);
    }
    for (const file of SCAN_FILES) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} が無い`).toBe(true);
    }
  });

  it('画面・部品・紹介ページの文・メールの文面・モバイルの画面・API の文の定数 (コメントを除く) に禁止の語が無い', () => {
    const problems = scannedFiles.flatMap((file) => findPendingWording(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(problems).toEqual([]);
  });
});

describe('#1911 DB の列の既定値 (画面に届く文) に禁止の語が残っていても、画面には出ない', () => {
  const sqlDefaults = findSqlDefaultLiterals();
  const progressDefaults = findProgressDefaults();

  it('SQL の既定値を拾えている (生成のリクエストの行の progress の既定値が 1 つ以上ある)', () => {
    expect(sqlDefaults).not.toEqual([]);
    expect(progressDefaults).not.toEqual([]);
  });

  it('禁止の語を含む既定値は、すべて progress の既定値 (phase が DB の既定値の phase) である', () => {
    const offending = sqlDefaults.filter((literal) => findPendingWording(literal.file, literal.value).length > 0);
    const notProgressDefault = offending
      .filter((literal) => {
        const progress = progressDefaults.find((p) => p.file === literal.file && p.line === literal.line);
        return !progress || progress.progress.phase !== DB_DEFAULT_REQUEST_PROGRESS_PHASE;
      })
      .map((literal) => `${literal.file}:${literal.line} ${literal.sourceLine.slice(0, 120)}`);
    expect(notProgressDefault).toEqual([]);
  });

  it('progress の既定値は、画面に出す前の置き換えで、禁止の語の無い文になる', () => {
    const problems = progressDefaults.flatMap((literal) => {
      const message = requestProgressForDisplay(literal.progress).message;
      if (typeof message !== 'string' || message === '') return [`${literal.file}:${literal.line} message が空`];
      return findPendingWording(`${literal.file}:${literal.line}`, message);
    });
    expect(problems).toEqual([]);
  });
});

describe('#1911 検査そのものが空振りしていない', () => {
  it('以前の文 (有料プランの準備中・バッジの近日公開予定・組織のチャレンジの (準備中)・運営の（未対応）) を捕まえる', () => {
    const samples = [
      "const PAID_PLAN_PENDING = '有料プランは準備中です（販売開始前）';",
      "{selectedBadge.description || '条件は近日公開予定です。'}",
      "label: '歩数 (準備中)',",
      '<option value="ai_content" disabled>AIコンテンツ（未対応）</option>',
      "const PENDING = '準備中（確定次第掲載します）';",
      '内容・料金・開始時期が決まりましたら、このページでご案内します。',
      '<p>データのエクスポート機能は、まだ作られていません。</p>',
      'このページはモバイル版で順次整備します。',
      '<p>Coming Soon</p>',
      '{"phase": "pending", "message": "準備中..."}',
    ];
    for (const sample of samples) {
      expect(findPendingWording('sample.tsx', sample), sample).not.toEqual([]);
    }
  });

  it('コメントの中の語と、問い合わせの状態の「未対応」・読み込み中の別の言い方は捕まえない', () => {
    const allowed = [
      '// 以前は「準備中」と出していた',
      '/* 有料プランの準備中のカードは #1911 で取り除いた */',
      '{/* 準備中の区切りは出さない */}',
      "  open: '未対応',",
      '<p className="text-sm text-gray-500">読み込んでいます…</p>',
      '<span>分析しています...</span>',
      "const url = 'https://example.com/path'; // 準備中",
    ];
    for (const sample of allowed) {
      expect(findPendingWording('sample.tsx', sample), sample).toEqual([]);
    }
  });
});
