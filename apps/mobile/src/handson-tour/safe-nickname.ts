// ハンズオンツアーの呼びかけ ({nickname} さん) に出す名前 (モバイル。#1635)
// Canonical: docs/design/family/09-onboarding-handson-tour/02-step0-welcome.md §7.2 (nickname 表示時の防御)
//
// 以前は 5 つの画面 (app/handson-tour/{index,photo,menu,badges,graduate}.tsx) が同じ関数を 1 つずつ持ち、
// 前後の空白を除くだけだったので、名前が無いときにアプリが入れる仮置きの 'Guest' を「Guest さん」と呼びかけていた。
// 規則の本体は Web と共通の @homegohan/shared (packages/shared/src/handson-tour-nickname.ts。#1649) に置き、
// ここはモバイルの 5 つの画面のために同じものを safeNickname の名前で読み直すだけで、規則を持たない。

export {
  HANDSON_TOUR_NICKNAME_FALLBACK,
  HANDSON_TOUR_NICKNAME_MAX_LENGTH,
  handsonTourNickname as safeNickname,
} from '@homegohan/shared';
