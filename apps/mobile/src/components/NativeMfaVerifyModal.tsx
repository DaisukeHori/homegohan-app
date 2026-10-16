/**
 * 運営ロールの MFA (二段階認証) — WebView から頼まれた確認 (mfa-verify-required) を、ネイティブで行う確認画面 (#1176 / #1707 段 D)
 *
 * 正典: docs/design/cross/12-operator-mfa.md §16.4.5。
 * WebView の Cookie のセッションはネイティブのセッションの借り物なので、token を発行し直す操作 (6 桁の verify) は
 * 持ち主のネイティブが行う (§16.4)。描画の後に resolveSessionMfaGate() (§16.2) でネイティブのセッションの AAL を読み、
 *   allow         : ネイティブのセッションは既に aal2 (WebView の Cookie だけが古い) → 6 桁を求めずにすぐ onVerified()
 *   verify        : MfaVerifyGate で 6 桁を入れる → onVerified()
 *   enroll_on_web : verified な factor が無い → ブラウザでの登録の案内
 *   読めない      : OperatorMfaGateError → 案内と [再試行]
 * onVerified を受けた WebViewScreen は、モーダルを閉じて WebView を読み込み直す (新しいブリッジは aal2 の access_token を運ぶ)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, View } from 'react-native';
import { Text } from './ui/Text';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MfaVerifyGate } from './MfaVerifyGate';
import { Button } from './ui';
import { MOBILE_MFA_ENROLL_ON_WEB_MESSAGE } from '../lib/mfa-gate';
import { resolveSessionMfaGate } from '../lib/operator-mfa';
import { colors, spacing, typography } from '../theme';

/** AAL を読めなかったときの文 (OperatorMfaGateError の message と同じ) */
export const NATIVE_MFA_VERIFY_GATE_ERROR_MESSAGE = '二段階認証の状態を確認できませんでした。';

type GateState = 'loading' | 'verify' | 'enroll_on_web' | 'error';

type Props = {
  onVerified: () => void;
  onClose: () => void;
};

export function NativeMfaVerifyModal({ onVerified, onClose }: Props) {
  const [state, setState] = useState<GateState>('loading');
  // 最新の onVerified を ref で持つ (判定の effect を props の identity で走らせ直さない)
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resolveGate = useCallback(async () => {
    setState('loading');
    try {
      const gate = await resolveSessionMfaGate();
      if (!mountedRef.current) return;
      if (gate === 'allow') {
        onVerifiedRef.current();
        return;
      }
      setState(gate);
    } catch {
      // OperatorMfaGateError (と想定外の失敗) は再試行を出す。先へは進まない (§16.2)
      if (mountedRef.current) setState('error');
    }
  }, []);

  useEffect(() => {
    void resolveGate();
  }, [resolveGate]);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.card }} edges={['top', 'bottom']}>
        <View testID="native-mfa-verify-modal" style={{ flex: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.md,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Text style={{ ...typography.h3, color: colors.text }}>二段階認証の確認</Text>
            <Button testID="native-mfa-verify-close" variant="ghost" size="sm" onPress={onClose}>
              閉じる
            </Button>
          </View>
          {state === 'loading' ? (
            <View testID="native-mfa-verify-loading" style={{ padding: spacing.lg, alignItems: 'center' }}>
              <ActivityIndicator size="large" color={colors.accent} />
            </View>
          ) : null}
          {state === 'verify' ? <MfaVerifyGate onVerified={() => onVerifiedRef.current()} /> : null}
          {state === 'enroll_on_web' ? (
            <View style={{ padding: spacing.lg }}>
              <Text testID="native-mfa-verify-enroll-on-web" style={{ ...typography.body, color: colors.text }}>
                {MOBILE_MFA_ENROLL_ON_WEB_MESSAGE}
              </Text>
            </View>
          ) : null}
          {state === 'error' ? (
            <View style={{ padding: spacing.lg, gap: spacing.md }}>
              <Text testID="native-mfa-verify-error" style={{ ...typography.body, color: colors.dangerText }}>
                {NATIVE_MFA_VERIFY_GATE_ERROR_MESSAGE}
              </Text>
              <Button testID="native-mfa-verify-retry" variant="secondary" onPress={() => void resolveGate()}>
                再試行
              </Button>
            </View>
          ) : null}
        </View>
      </SafeAreaView>
    </Modal>
  );
}
