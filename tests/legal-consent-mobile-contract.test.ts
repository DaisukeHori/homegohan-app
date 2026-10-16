/**
 * 規約の同意ゲート (#1442 設計書 cross/13b): アプリ (apps/mobile) と Web の契約を固定する (T-W3)
 *
 *   1. アプリの同意画面の route のパス LEGAL_CONSENT_SCREEN_PATH は、Web の同意画面のパス LEGAL_CONSENT_PATH と同じ値
 *      (アプリは WebView でこのパスを開く。食い違うと、アプリが開く画面が Web の同意画面でなくなる)
 *   2. アプリが同意の合図として受ける type LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE は、Web の notifyNativeLegalConsentAccepted が
 *      実際に postMessage で送る type と同じ値 (postMessage を差し替えて実測)
 *
 * apps/mobile/src を直接 import する (tests/design-doc-push-paths-resolve.test.ts と同じ)。
 * src/lib/legal-consent.ts は @homegohan/shared だけを import する純粋なモジュールなので、ルートの vitest で読める。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE,
  LEGAL_CONSENT_SCREEN_PATH,
  parseLegalConsentMessage,
} from '../apps/mobile/src/lib/legal-consent';
import { LEGAL_CONSENT_PATH } from '../lib/onboarding-routing';
import { notifyNativeLegalConsentAccepted } from '../src/lib/native-auth-bridge';

type WindowWithBridge = Window & { ReactNativeWebView?: { postMessage: (message: string) => void } };

afterEach(() => {
  delete (window as WindowWithBridge).ReactNativeWebView;
});

describe('アプリと Web の同意画面の契約 (#1442 T-W3)', () => {
  it('アプリの LEGAL_CONSENT_SCREEN_PATH は Web の LEGAL_CONSENT_PATH と同じ値', () => {
    expect(LEGAL_CONSENT_SCREEN_PATH).toBe(LEGAL_CONSENT_PATH);
  });

  it('アプリの LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE は notifyNativeLegalConsentAccepted が送る type と同じ値 (postMessage を差し替えて実測)', () => {
    const postMessage = vi.fn();
    (window as WindowWithBridge).ReactNativeWebView = { postMessage };

    expect(notifyNativeLegalConsentAccepted()).toBe(true);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(postMessage.mock.calls[0][0] as string) as { type: string };
    expect(sent.type).toBe(LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE);
    // アプリの受け手は、Web が実際に送ったメッセージを同意の合図として受ける
    expect(parseLegalConsentMessage(sent)).toEqual({ type: LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE });
  });
});
