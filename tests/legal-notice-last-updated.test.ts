/**
 * #1912 P8 特定商取引法に基づく表記 (/legal) の最終更新日の見張り
 *
 * 最終更新日は src/lib/legal/legal-notice.ts の LEGAL_NOTICE_LAST_UPDATED 1 か所から出す (ページに日付を直接書かない)。
 * 表の行 (事業者の情報・販売の項目・販売価格) を変えたのに日付を変え忘れることを防ぐため、描画した表の文字の指紋 (SHA-256) と
 * 日付を組で固定する。表を変えると指紋が変わって赤になるので、そのときは公開の日に日付を変え、指紋と一緒に下の組を直す。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { formatLegalEffectiveDate } from '@homegohan/shared';
import { LEGAL_NOTICE_LAST_UPDATED } from '@/lib/legal/legal-notice';
import { stripAllTags } from './helpers/strip-tags';

// next/link は描画に Next.js の実行環境を要らないよう、素の a に置き換える
vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

const { default: LegalPage } = await import('@/app/legal/page');

const ROOT = path.resolve(__dirname, '..');

/** 販売の項目 (#1912 段 C・ba9f8492) を公開した日 (日本時間)。最終更新日をこれより前に戻さない */
const LEGAL_SALE_ROWS_PUBLISHED_ON = '2026-10-22';

/**
 * 表の中身と最終更新日の組。表を変えたら、公開の日を updatedOn に、テストの失敗の文に出る新しい指紋を tableSha256 に書く
 * (updatedOn は LEGAL_NOTICE_LAST_UPDATED と同じ値にする)
 */
const LEGAL_TABLE_REVISION = {
  updatedOn: '2026-10-22',
  tableSha256: '257b74f2fd3a3a08626391f6973034ff165a8362d1a20a4a8246e66d1a5444a8',
} as const;

/** HTML の文字の実体参照を戻す (renderToStaticMarkup が書く 5 つ。&amp; は最後に戻す) */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 表の 1 行ずつの「ラベル\t値」(タグを外し、空白を 1 つに詰める)。React の版で変わりうる注釈 (<!-- -->) や空白の差に依らない */
function tableRowsText(html: string): string {
  const table = /<table[^>]*>([\s\S]*?)<\/table>/.exec(html);
  expect(table, '/legal に表が無い').not.toBeNull();
  const rows = [...table![1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) => {
    const cells = [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) =>
      decodeEntities(stripAllTags(cell[1])).replace(/\s+/g, ' ').trim(),
    );
    return cells.join('\t');
  });
  return rows.join('\n');
}

describe('#1912 P8 /legal の最終更新日', () => {
  const html = renderToStaticMarkup(createElement(LegalPage));
  const text = decodeEntities(stripAllTags(html));

  it('最終更新日は LEGAL_NOTICE_LAST_UPDATED (日本時間の実在する日付) を「YYYY年M月D日」で出し、販売の項目を公開した日 (LEGAL_SALE_ROWS_PUBLISHED_ON) より前にしない', () => {
    expect(LEGAL_NOTICE_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 実在する日付 (2026-02-30 のような値を通さない)
    expect(new Date(`${LEGAL_NOTICE_LAST_UPDATED}T00:00:00Z`).toISOString().slice(0, 10)).toBe(LEGAL_NOTICE_LAST_UPDATED);
    // YYYY-MM-DD は文字の順と日付の順が同じ
    expect(LEGAL_NOTICE_LAST_UPDATED >= LEGAL_SALE_ROWS_PUBLISHED_ON).toBe(true);
    expect(text).toContain(`最終更新日：${formatLegalEffectiveDate(LEGAL_NOTICE_LAST_UPDATED)}`);
    expect(text.split('最終更新日：')).toHaveLength(2);
  });

  it('ページのソースに最終更新日の日付を直接書かない (定数 1 か所だけを直せばよい)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/app/legal/page.tsx'), 'utf8');
    expect(source).toContain('LEGAL_NOTICE_LAST_UPDATED');
    expect(source).not.toMatch(/最終更新日：\s*\d/);
    expect(source).not.toMatch(/\d{4}年\d{1,2}月\d{1,2}日/);
  });

  it('表の中身の指紋と最終更新日は組で固定する (表を変えたら日付も変える。直し方はファイルの冒頭)', () => {
    const rows = tableRowsText(html);
    // 表が空で素通りしないこと (事業者の 7 行 + 販売の 9 行 + 動作環境)
    expect(rows).toContain('販売事業者\t');
    expect(rows).toContain('販売価格\t');
    const sha256 = createHash('sha256').update(rows).digest('hex');
    expect(
      sha256,
      `/legal の表の中身が変わった。公開の日に LEGAL_NOTICE_LAST_UPDATED と LEGAL_TABLE_REVISION.updatedOn を変え、tableSha256 を ${sha256} にする`,
    ).toBe(LEGAL_TABLE_REVISION.tableSha256);
    expect(LEGAL_NOTICE_LAST_UPDATED).toBe(LEGAL_TABLE_REVISION.updatedOn);
  });
});
