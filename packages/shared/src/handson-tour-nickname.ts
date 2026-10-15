// packages/shared/src/handson-tour-nickname.ts
// ハンズオンツアーの呼びかけ ({nickname} さん) に出す名前 (Web・モバイル共通。#1635・#1649)
// Canonical: docs/design/family/09-onboarding-handson-tour/02-step0-welcome.md §7.2 (nickname 表示時の防御)
//
// 以前は Web の 5 つの画面 (src/app/handson-tour/{page,photo,menu,badges,graduate}) がそれぞれ同じ関数を持ち、
// 前後の空白を除くだけだったので、名前が無いときにアプリが入れる仮置きの 'Guest' を「Guest さん」と呼びかけていた (#1649)。
// モバイル (apps/mobile/src/handson-tour/safe-nickname.ts) は #1635 で仮置きを弾いていたので、規則をここ 1 つにまとめ、
// Web とモバイルの両方がこれを読む。名前が無いかどうかは normalizeProfileName (前後の空白を除いて 'Guest' と厳密一致・
// 空・空白だけは名前なし) で決める。
//
// Web のブラウザ・モバイルの両方から読むので、このパッケージの外は import しない。

import { normalizeProfileName } from './profile-name';

/** 名前が無いときの呼びかけ (設計書 §7.2 と同じ) */
export const HANDSON_TOUR_NICKNAME_FALLBACK = 'あなた';

/** 呼びかけに出す名前の最大の文字数。長い名前で吹き出しが崩れないよう、これを超えたら切って「…」を付ける (設計書 §7.2) */
export const HANDSON_TOUR_NICKNAME_MAX_LENGTH = 30;

/** 呼びかけに出す名前を決める。名前が無い (仮置きの 'Guest'・空・空白だけ・null) なら 'あなた' */
export function handsonTourNickname(raw: string | null | undefined): string {
  const name = normalizeProfileName(raw);
  if (!name) return HANDSON_TOUR_NICKNAME_FALLBACK;
  if (name.length > HANDSON_TOUR_NICKNAME_MAX_LENGTH) return `${name.slice(0, HANDSON_TOUR_NICKNAME_MAX_LENGTH)}…`;
  return name;
}
