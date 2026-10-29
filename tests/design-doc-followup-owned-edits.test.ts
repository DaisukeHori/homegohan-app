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
    // operator/13 §17.1: 02 §5 の delete_* の説明の 1 行。オーケストレーターの docs PR が持つ
    owner: 'docs/design/operator/13-hidden-content-restore.md',
    target: 'docs/design/operator/02-api-spec.md',
    pattern: /「(`approve` \/ `escalate` は何も隠さない[^」]*)」→「([^」]*)」/,
  },
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
  {
    // cross/13b §6.19: 実装 PR 側 (ENV_SETUP.md) の追随。行の 2 列目と 3 列目の「…」が前の文と後の文
    owner: 'docs/design/cross/13b-legal-consent-mobile.md',
    target: 'ENV_SETUP.md',
    pattern: /「([^」]*)」[^「]*「([^」]*)」/,
  },
  {
    // cross/13b §6.19: オーケストレーターの docs PR が持つ
    owner: 'docs/design/cross/13b-legal-consent-mobile.md',
    target: 'CLAUDE.md',
    pattern: /「([^」]*)」[^「]*「([^」]*)」/,
  },
  {
    // operator/12 §15.1: 10 §8.1 の 2 か所 (キー / クールダウン・宛先) の同じ文。オーケストレーターの docs PR が持つ
    owner: 'docs/design/operator/12-cron-secret-drift-monitor.md',
    target: 'docs/design/operator/10-logs-and-mail-retry.md',
    pattern: /「([^」]*)」→「([^」]*)」/,
  },
  {
    // mobile/07 §15.2: 01 §3.1 の表のルーティングの行。オーケストレーターの専権 PATCH が持つ
    // (§15.2 の「同上」の行と「ルート `CLAUDE.md`」の行は 1 列目が対象のパスで始まらないので、この見張りでは拾えない)
    owner: 'docs/design/mobile/07-toolchain-upgrade.md',
    target: 'docs/design/mobile/01-architecture.md',
    pattern: /「(Expo Router v4)」 \| `SDK 58`・`(Expo Router 58)` に/,
  },
  {
    // mobile/07 §15.2: 00-architecture の 17 行。オーケストレーターの専権 PATCH が持つ
    owner: 'docs/design/mobile/07-toolchain-upgrade.md',
    target: 'docs/design/00-architecture.md',
    pattern: /「React Native \((Expo SDK 53)\)」 \| `(Expo SDK 58)` に/,
  },  {
    // family/11 §18.1: cross/20 §6・§7 の 4 文。オーケストレーターの専権の差分が段 C の PR で書き換える
    owner: 'docs/design/family/11-self-dissolve.md',
    target: 'docs/design/cross/20-terms-privacy-text.md',
    pattern: /「(代表者以外のメンバーは、家族グループから退出できます。[^」]*)」→「([^」]*)」/,
  },
  {
    // family/11 §18.1: cross/20 §6・§7 の 4 文。オーケストレーターの専権の差分が段 C の PR で書き換える
    owner: 'docs/design/family/11-self-dissolve.md',
    target: 'docs/design/cross/20-terms-privacy-text.md',
    pattern: /「(組織のオーナーは、オーナーを組織のほかのメンバーへ譲渡するまで[^」]*)」→「([^」]*)」/,
  },
  {
    // family/11 §18.1: cross/20 §6・§7 の 4 文。オーケストレーターの専権の差分が段 C の PR で書き換える
    owner: 'docs/design/family/11-self-dissolve.md',
    target: 'docs/design/cross/20-terms-privacy-text.md',
    pattern: /「(組織のオーナーと家族グループの代表者は、第11条4項と第12条4項のとおり[^」]*)」→「([^」]*)」/,
  },
  {
    // family/11 §18.1: cross/20 §6・§7 の 4 文。オーケストレーターの専権の差分が段 C の PR で書き換える
    owner: 'docs/design/family/11-self-dissolve.md',
    target: 'docs/design/cross/20-terms-privacy-text.md',
    pattern: /「(組織のオーナーと家族グループの代表者は、オーナーまたは代表者を譲渡するまで[^」]*)」→「([^」]*)」/,
  },
  {
    // cross/24 §17: operator/02 §4 の凍結の notify_user の説明の 1 行 (行 192)。実装の PR (段 A) が同じ PR で書き換える。
    // 後の文は件名の入れ子の「【ほめゴハン】…」を含むので、2 番目の組が取るのは最初の 」 まで (後の文の逐語の頭)
    owner: 'docs/design/cross/24-freeze-notify-mail.md',
    target: 'docs/design/operator/02-api-spec.md',
    pattern: /「(`notify_user` \(省略時 true\) は監査の details に残すだけ[^」]*)」→「([^」]*)」/,
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
