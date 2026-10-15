// ハンズオンツアーの呼びかけ ({nickname} さん) に出す名前 (モバイル。#1635)
// Canonical: docs/design/family/09-onboarding-handson-tour/02-step0-welcome.md §7.2 (nickname 表示時の防御)
//
// 以前は 5 つの画面 (app/handson-tour/{index,photo,menu,badges,graduate}.tsx) が同じ関数を 1 つずつ持ち、
// 前後の空白を除くだけだったので、名前が無いときにアプリが入れる仮置きの 'Guest' を「Guest さん」と呼びかけていた。
// 名前が無いかどうかは Web のプロフィール画面・GET /api/onboarding/status と同じ
// @homegohan/shared の normalizeProfileName (前後の空白を除いて 'Guest' と厳密一致・空・空白だけは名前なし) で決める。

import { normalizeProfileName } from '@homegohan/shared';

/** 名前が無いときの呼びかけ (設計書 §7.2 と同じ) */
export const HANDSON_TOUR_NICKNAME_FALLBACK = 'あなた';

/** 呼びかけに出す名前の最大の文字数。長い名前で吹き出しが崩れないよう、これを超えたら切って「…」を付ける (設計書 §7.2) */
export const HANDSON_TOUR_NICKNAME_MAX_LENGTH = 30;

/** 呼びかけに出す名前を決める。名前が無い (仮置きの 'Guest'・空・空白だけ) なら 'あなた' */
export function safeNickname(raw: string | null | undefined): string {
  const name = normalizeProfileName(raw);
  if (!name) return HANDSON_TOUR_NICKNAME_FALLBACK;
  if (name.length > HANDSON_TOUR_NICKNAME_MAX_LENGTH) return `${name.slice(0, HANDSON_TOUR_NICKNAME_MAX_LENGTH)}…`;
  return name;
}
