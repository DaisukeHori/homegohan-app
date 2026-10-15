// ハンズオンツアーの Spotlight の対象を画面の中へ自動でスクロールする (#1604)。
//
// 設計書 docs/design/family/09-onboarding-handson-tour/05-step3-badges.md §7.2 / §7.3:
//   - Spotlight の対象が画面の外なら、表示エリアへ自動でスクロールする (scrollIntoView, block: 'center')
//   - 通常は smooth、reduce-motion のときは instant (behavior: 'auto')
// ツアー中は全面のオーバーレイ (position: fixed) が画面にかぶさり、利用者はホイールやタッチで下の一覧をスクロールできない。
// 吹き出しは対象のカードの下に出るので、カードが画面の下にあると吹き出しの [次へ] が画面の外に出て先へ進めなかった
// (#846 の E2E で発見。既定の 1280x720 で planner / tutorial_complete のカード)。

/**
 * data-testid が testId の要素を、画面の中央へスクロールする。
 * @returns 要素が見つかってスクロールを指示したら true。見つからなければ false (何もしない)
 */
export function scrollTourTargetIntoView(testId: string, reducedMotion: boolean): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  return true;
}
