/**
 * 他の正典の追随表が逐語で決めている書き換えは、対象の文書に「書き換える前の文」か「書き換えた後の文」のどちらかが逐語で残る
 *
 * 追随表 (cross/16 §23・cross/19 §18 など) は、別の文書のある 1 行を「`A` を `B` に」「「A」→「B」」の形で、
 * 誰が・いつ直すか (段 B の PR・オーケストレーターの docs PR) まで決めている。別の改定 (2026-10-16 の現在形化 #1744) が
 * 同じ行を A でも B でもない第 3 の文言に書き換えると、追随表は「無い文を直せ」と指示し、2 冊の正典が同じ行の最後の文言を
 * 別々に決めることになる (main にマージ済みの正典が正、の決まりが壊れる)。ここで、その形を赤にする。
 *   1. 追随表の行が、まだ書き換えの前と後の文を逐語で持っている (行が変わったらこの表を直す)
 *   2. 対象の文書に、前の文か後の文のどちらかが逐語で残っている
 * この検査の限界: 下の OWNED_EDITS に載せた行だけを見る (追随表の書き方が冊ごとに違い、全部を機械で拾えないので)。
 * 追随表に逐語の書き換えの行を足したら、ここにも足す。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

type OwnedEdit = {
  /** 追随表を持つ正典 (リポジトリの根からの相対) */
  owner: string;
  /** 書き換えられる文書 (リポジトリの根からの相対)。追随表の行の 1 列目はこのパスで始まる */
  target: string;
  /** 追随表の行から、1 番目の組 = 前の文・2 番目の組 = 後の文を取り出す */
  pattern: RegExp;
};

const OWNED_EDITS: readonly OwnedEdit[] = [
  {
    // cross/16 v1.8 (#1798) §23: 段 B の追随。§21.3 の段 B の行・§0.2 の段 B の行も同じ書き換えを指す
    owner: 'docs/design/cross/16-auth-history-sessions.md',
    target: 'docs/design/cross/01-auth-session.md',
    pattern: /`(participant Next as Next\.js Edge)` を `(participant Next as Next\.js \(proxy・Node\.js runtime\))` に/,
  },
  {
    // cross/19 §18: オーケストレーターの docs PR が持つ
    owner: 'docs/design/cross/19-private-photo-buckets.md',
    target: 'docs/design/operator/02-api-spec.md',
    pattern: /「(画像ファイル \(`photo_url` \/ `image_url`\) そのものは隠さない[^」]*)」→「([^」]*)」/,
  },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 正典の中の、対象の文書の行 (1 列目が `target` で始まる行)。関係の表と追随表の両方に同じ文書の行があるので、全部を返す */
function rowsOf(ownerText: string, target: string): string[] {
  return ownerText.split('\n').filter((line) => line.startsWith(`| \`${target}`));
}

describe('追随表が逐語で決めた書き換えは、対象の文書に前か後の文のどちらかで残る', () => {
  for (const edit of OWNED_EDITS) {
    describe(`${edit.owner} → ${edit.target}`, () => {
      const rows = rowsOf(read(edit.owner), edit.target);
      const matches = rows.flatMap((line) => {
        const found = line.match(edit.pattern);
        return found ? [found] : [];
      });
      const match = matches[0] ?? null;

      it('追随表の行が前の文と後の文を逐語で持つ', () => {
        expect(rows.length, `${edit.owner} に ${edit.target} の行が無い`).toBeGreaterThan(0);
        expect(matches, `${edit.owner} の ${edit.target} の行の書き方が変わった: ${rows.join('\n')}`).toHaveLength(1);
        expect(match?.[1]).not.toBe(match?.[2]);
      });

      it('対象の文書に前の文か後の文が逐語で残る (第 3 の文言にしない)', () => {
        const [, before, after] = match ?? [];
        const targetText = read(edit.target);
        const remains = [before, after].filter((text): text is string => !!text && targetText.includes(text));
        expect(remains, `${edit.target} に「${before}」も「${after}」も無い`).toHaveLength(1);
      });
    });
  }
});
