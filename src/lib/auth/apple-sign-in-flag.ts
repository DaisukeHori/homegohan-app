/**
 * Web で Apple のボタンを出すか (docs/design/mobile/08-sign-in-with-apple.md §10.2)。NEXT_PUBLIC_APPLE_SIGN_IN が on のときだけ。
 * 名前を直接書いて読む (Next.js はこの形だけをブラウザのバンドルで値に置き換える。src/lib/env-required.ts の注)。React に依存しない。
 */
import { isAppleSignInFlagOn } from '@homegohan/shared';

export function isAppleSignInEnabled(): boolean {
  return isAppleSignInFlagOn(process.env.NEXT_PUBLIC_APPLE_SIGN_IN);
}
