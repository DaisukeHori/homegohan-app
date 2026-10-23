/**
 * Web の Apple のボタン (自作。docs/design/mobile/08-sign-in-with-apple.md §10.2。HIG の「Creating a custom Sign in with Apple button」)。
 *  - 黒い背景に白いロゴと題名。題名は「Appleで続ける」「Appleで登録」だけ (HIG の Continue / Sign up に当たる日本語)
 *  - 高さ 56px・文字 24px (高さの 43%)・ロゴの高さ = ボタンの高さ (ロゴの画像は余白込み。切らない)
 *  - ロゴは Apple が配るロゴだけのボタンの画像 (黒地に白いロゴ・PNG) を public/auth/apple-logo-on-black.png に置く
 *    (取得: https://appleid.cdn-apple.com/appleid/button/logo?size=56&color=black&border=false&border_radius=0&scale=3。設計書 §11.6)
 */
import Image from 'next/image';

/**
 * ボタンの高さ (px)。Google のボタンの style の height にも同じ値を渡してそろえる (Apple のボタンをほかより小さくしない)。
 * 2 つとも px にする (Tailwind の h-14 などは rem で、ブラウザの文字の大きさの設定で変わり、px の高さとずれる。設計書 §10.2)
 */
export const APPLE_SIGN_IN_BUTTON_HEIGHT_PX = 56;
/** 題名の文字の大きさ (px) = 高さの 43% (HIG の例: 56pt / 24pt) */
export const APPLE_SIGN_IN_BUTTON_FONT_PX = 24;
/** ロゴの画像の置き場 (public/ からの道)。画像は Apple の URL から取った PNG (設計書 §11.6) */
export const APPLE_LOGO_SRC = '/auth/apple-logo-on-black.png';
/**
 * ロゴの画像を取るときの scale (Apple の URL の scale。1〜6)。3 倍 = 高解像度の画面 (devicePixelRatio 3 まで) で滲まない。
 * 画像の一辺の画素数 = APPLE_SIGN_IN_BUTTON_HEIGHT_PX × APPLE_LOGO_IMAGE_SCALE (= 168。tests/apple-sign-in-logo-asset.test.ts が確かめる)
 */
export const APPLE_LOGO_IMAGE_SCALE = 3;

export const APPLE_SIGN_IN_TITLES = {
  continue: 'Appleで続ける',
  sign_up: 'Appleで登録',
} as const;

export function AppleSignInButton(props: {
  kind: keyof typeof APPLE_SIGN_IN_TITLES;
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      onClick={props.onClick}
      disabled={props.disabled}
      className="w-full rounded-xl bg-black text-white font-bold flex items-center justify-center gap-2 hover:bg-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      style={{ height: APPLE_SIGN_IN_BUTTON_HEIGHT_PX, fontSize: APPLE_SIGN_IN_BUTTON_FONT_PX }}
    >
      <Image src={APPLE_LOGO_SRC} alt="" aria-hidden width={APPLE_SIGN_IN_BUTTON_HEIGHT_PX} height={APPLE_SIGN_IN_BUTTON_HEIGHT_PX} unoptimized />
      {props.loading ? '処理中...' : APPLE_SIGN_IN_TITLES[props.kind]}
    </button>
  );
}
