/**
 * #1917 画面の <form> を、ブラウザの送信 (method="POST" / action="/api/...") で API へ送らない
 *
 * このリポジトリの API (src/app/api/**) は本文を JSON (request.json()) で受ける。ブラウザのフォームの送信は本文を
 * application/x-www-form-urlencoded で送るので、API は 400 INVALID_JSON で断り、その JSON がそのまま画面に出る。
 * 実際に、審査の確定 (#1101) と運営の凍結・凍結解除 (#1917) がこの形で動かなかった。どちらもクライアントコンポーネントの
 * fetch で JSON を送る形 (src/components/operator/moderation/ModerationReviewForm.tsx・src/components/admin/UserFreezeForm.tsx) に直した。
 *
 * ここでは src の下の .tsx の <form> の開きタグを全部見て、次の 2 つが無いことを確かめる (コメントは除く):
 *   - method が POST (大文字・小文字を問わない)
 *   - action が /api/ で始まる文字列 (テンプレート文字列を含む)
 * 検索のフォーム (method="GET"・action を付けない) とサーバーアクション (action={関数}) は対象の外。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function listTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsx(full));
    else if (entry.isFile() && entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** ブロックコメント (JSX の {/* … *\/} を含む) と行コメントを外す (https:// の // は残す) */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** <form …> の開きタグ (属性の中の => で止まらない) */
const FORM_OPEN_TAG = /<form\b(?:=>|[^>])*>/g;
const METHOD_POST = /\bmethod\s*=\s*\{?\s*["'`]post["'`]/i;
const ACTION_TO_API = /\baction\s*=\s*\{?\s*["'`]\/api\//;

function nativeApiFormTags(source: string): string[] {
  const tags = stripComments(source).match(FORM_OPEN_TAG) ?? [];
  return tags.filter((tag) => METHOD_POST.test(tag) || ACTION_TO_API.test(tag));
}

describe('#1917 画面の <form> をブラウザの送信で API へ送らない', () => {
  it('src の下の .tsx に、method="POST" や action="/api/..." の <form> が無い', () => {
    const offenders = listTsx(SRC).flatMap((file) =>
      nativeApiFormTags(fs.readFileSync(file, 'utf8')).map((tag) => `${path.relative(ROOT, file)}: ${tag}`),
    );
    expect(offenders).toEqual([]);
  });

  it('凍結の画面のページ自身は <form> を持たず、UserFreezeForm を描く', () => {
    const page = stripComments(fs.readFileSync(path.join(SRC, 'app/admin/users/[id]/freeze/page.tsx'), 'utf8'));
    expect(page).not.toMatch(/<form\b/);
    expect(page).toMatch(/<UserFreezeForm\b/);
  });

  describe('見張りが以前の形を見つける (見張りの検出力)', () => {
    it.each([
      ['以前の凍結のフォーム', '<form action={`/api/admin/users/${id}/freeze`} method="POST">'],
      ['小文字の post', '<form method="post" className="x">'],
      ['action だけ (method を省くと GET だが API へ飛ぶ)', '<form action="/api/admin/moderation/food/1">'],
      ['=> を含む属性の後ろの method', '<form onReset={() => setX(1)} method="POST">'],
    ])('%s', (_label, tag) => {
      expect(nativeApiFormTags(tag)).toHaveLength(1);
    });

    it.each([
      ['検索のフォーム', '<form method="GET" className="mb-4">'],
      ['fetch で送るフォーム', '<form onSubmit={handleSubmit} noValidate>'],
      ['サーバーアクション', '<form action={signOut}>'],
      ['コメントの中', '{/* 以前は <form method="POST" action="/api/x"> だった */}'],
    ])('%s は対象の外', (_label, tag) => {
      expect(nativeApiFormTags(tag)).toEqual([]);
    });
  });
});
