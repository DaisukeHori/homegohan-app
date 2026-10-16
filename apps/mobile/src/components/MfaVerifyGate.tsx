/**
 * 運営ロールの MFA (二段階認証) — 認証アプリの 6 桁を入れて、ネイティブのセッションを aal2 に上げる (#1176 / #1707 段 D)
 *
 * 正典: docs/design/cross/12-operator-mfa.md §16.3。使うのは NativeMfaVerifyModal (§16.4.5) だけ。
 * 取り消しのボタンは持たない (モーダルを閉じるのはモーダルの [閉じる])。
 * 表示時に supabase.auth.mfa.listFactors() の totp (verified な TOTP だけが入る) の先頭を使い、
 * 無ければブラウザでの登録を案内する (登録はアプリの中ではできない §16.4)。
 * verify は端末のセッションで行う。apps/mobile/src/lib/api.ts は毎回 getSession() の token を使うので、verify の後の Bearer は aal2。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Text } from './ui/Text';

import { Button, Input } from './ui';
import { MOBILE_MFA_ENROLL_ON_WEB_MESSAGE, MOBILE_TOTP_CODE_PATTERN } from '../lib/mfa-gate';
import { supabase } from '../lib/supabase';
import { colors, spacing, typography } from '../theme';

/** 6 桁が合わない (Supabase の verify の失敗) */
export const MFA_VERIFY_MISMATCH_MESSAGE = '確認コードが正しくありません。認証アプリの最新のコードを入力してください。';
/** Supabase の回数制限に当たった */
export const MFA_VERIFY_RATE_LIMITED_MESSAGE = '試行回数が多すぎます。しばらくしてから再度お試しください。';
/** それ以外 (通信の失敗など) */
export const MFA_VERIFY_NETWORK_MESSAGE = '通信に失敗しました。再度お試しください。';

/** Supabase Auth が 6 桁の不一致に返す error.code */
const MFA_VERIFICATION_FAILED_CODE = 'mfa_verification_failed';
/** 不一致・形式の誤りとして扱う HTTP の status (Supabase Auth の verify の 400 / 422) */
const MFA_VERIFY_MISMATCH_STATUSES: readonly number[] = [400, 422];
/** 回数制限の HTTP の status */
const HTTP_TOO_MANY_REQUESTS = 429;
/** 認証アプリの 6 桁の桁数 (入力欄の maxLength。判定は MOBILE_TOTP_CODE_PATTERN) */
const TOTP_CODE_LENGTH = 6;

type VerifyError = { code?: unknown; status?: unknown } | null | undefined;

/** challengeAndVerify の失敗を、画面の文言にする (§16.3) */
export function mfaVerifyErrorMessage(error: VerifyError): string {
  const status = typeof error?.status === 'number' ? error.status : null;
  if (error?.code === MFA_VERIFICATION_FAILED_CODE || (status !== null && MFA_VERIFY_MISMATCH_STATUSES.includes(status))) {
    return MFA_VERIFY_MISMATCH_MESSAGE;
  }
  if (status === HTTP_TOO_MANY_REQUESTS) return MFA_VERIFY_RATE_LIMITED_MESSAGE;
  return MFA_VERIFY_NETWORK_MESSAGE;
}

type FactorState =
  | { kind: 'loading' }
  | { kind: 'ready'; factorId: string }
  | { kind: 'none' }
  | { kind: 'error' };

type Props = {
  onVerified: () => void | Promise<void>;
};

export function MfaVerifyGate({ onVerified }: Props) {
  const [factor, setFactor] = useState<FactorState>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 送信中は二重に送らない (state の更新より先に 2 回押されても、ref で止める)
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadFactor = useCallback(async () => {
    setFactor({ kind: 'loading' });
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (!mountedRef.current) return;
      if (error || !data) {
        setFactor({ kind: 'error' });
        return;
      }
      const first = data.totp[0];
      setFactor(first ? { kind: 'ready', factorId: first.id } : { kind: 'none' });
    } catch {
      if (mountedRef.current) setFactor({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    void loadFactor();
  }, [loadFactor]);

  const canSubmit = factor.kind === 'ready' && MOBILE_TOTP_CODE_PATTERN.test(code) && !submitting;

  const submit = async () => {
    if (factor.kind !== 'ready' || !MOBILE_TOTP_CODE_PATTERN.test(code) || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);
    let verified = false;
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.factorId, code });
      if (error) {
        if (mountedRef.current) setErrorMessage(mfaVerifyErrorMessage(error));
      } else {
        verified = true;
      }
    } catch {
      if (mountedRef.current) setErrorMessage(MFA_VERIFY_NETWORK_MESSAGE);
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
    if (verified) await onVerified();
  };

  if (factor.kind === 'loading') {
    return (
      <View testID="mfa-verify-loading" style={{ padding: spacing.lg, alignItems: 'center' }}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (factor.kind === 'none') {
    return (
      <View testID="mfa-verify-enroll-on-web" style={{ padding: spacing.lg }}>
        <Text style={{ ...typography.body, color: colors.text }}>{MOBILE_MFA_ENROLL_ON_WEB_MESSAGE}</Text>
      </View>
    );
  }

  if (factor.kind === 'error') {
    return (
      <View style={{ padding: spacing.lg, gap: spacing.md }}>
        <Text testID="mfa-verify-error" style={{ ...typography.body, color: colors.dangerText }}>
          {MFA_VERIFY_NETWORK_MESSAGE}
        </Text>
        <Button testID="mfa-verify-reload" variant="secondary" onPress={() => void loadFactor()}>
          再試行
        </Button>
      </View>
    );
  }

  return (
    <View style={{ padding: spacing.lg, gap: spacing.md }}>
      <Text style={{ ...typography.body, color: colors.text }}>
        認証アプリに表示されている 6 桁の確認コードを入力してください。
      </Text>
      <Input
        testID="mfa-verify-code-input"
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={TOTP_CODE_LENGTH}
        editable={!submitting}
        placeholder="123456"
      />
      {errorMessage ? (
        <Text testID="mfa-verify-error" style={{ ...typography.body, color: colors.dangerText }}>
          {errorMessage}
        </Text>
      ) : null}
      <Button testID="mfa-verify-submit" onPress={() => void submit()} disabled={!canSubmit} loading={submitting}>
        確認する
      </Button>
    </View>
  );
}
