// #1045 (F6-05): /handson-tour/layout.tsx は searchParams を受け取れないため、
// ?force=1 の判定を /handson-tour/replay route (Cookie 発行) 経由に切り出す。
// Cookie 名・有効期間をここに集約し、layout / replay route の両方から参照する。
export const HANDSON_TOUR_FORCE_COOKIE = 'handson_tour_force';

// リプレイセッションの許容時間。ツアーは数分で完走できる想定のため 30 分で十分。
export const HANDSON_TOUR_FORCE_COOKIE_MAX_AGE_SECONDS = 30 * 60;
