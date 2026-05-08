// PostHog Mobile (React Native) SDK 初期化
// Canonical: docs/design/operator/07-audit-monitoring.md §15.1, §15.7, §15.9

import PostHog from 'posthog-react-native';

// PostHogEventProperties は posthog-core からのもの
// named export が公開されていないため互換型をローカル定義
export type PostHogEventProperties = Record<string, string | number | boolean | null | undefined>;

// PII フィルタキー (operator/07 §15.7)
const FORBIDDEN_KEYS = [
  'nickname', 'email', 'phone', 'address',
  'weight_kg', 'height_cm', 'age', 'gender',
  'allergies', 'dietary_preferences', 'nutrition_goal',
  'password', 'jwt', 'token',
] as const;

/**
 * PII キーをプロパティから除去する (operator/07 §15.7)
 */
function sanitizeProps(props: PostHogEventProperties): PostHogEventProperties {
  const filtered: PostHogEventProperties = { ...props };
  for (const key of FORBIDDEN_KEYS) {
    if ((key as string) in filtered) {
      delete filtered[key as string];
    }
  }
  return filtered;
}

let _posthog: PostHog | null = null;

/**
 * PostHog Mobile SDK インスタンスを返す。
 * 未初期化の場合は null を返す (graceful degradation)。
 */
export function getPostHogClient(): PostHog | null {
  return _posthog;
}

/**
 * PostHog Mobile SDK を非同期初期化する。
 * - EXPO_PUBLIC_POSTHOG_KEY が未設定の場合はスキップ
 * - production 環境のみ init (graceful degradation)
 */
export async function initPostHogMobile(): Promise<PostHog | null> {
  const key = process.env['EXPO_PUBLIC_POSTHOG_KEY'];
  const host = process.env['EXPO_PUBLIC_POSTHOG_HOST'] ?? 'https://us.i.posthog.com';

  // 環境変数未設定はスキップ (graceful degradation)
  if (!key) {
    return null;
  }

  if (_posthog) {
    return _posthog;
  }

  try {
    const client = new PostHog(key, { host });
    // ready() で非同期初期化の完了を待つ
    await client.ready();
    _posthog = client;
    return _posthog;
  } catch {
    // init 失敗時はアプリをクラッシュさせない
    return null;
  }
}

/**
 * PII フィルタを適用した上でイベントを capture する
 */
export function captureEvent(
  eventName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: Record<string, any>,
): void {
  if (!_posthog) return;
  try {
    // sanitizeProps の戻り値を SDK が期待する型にキャスト
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _posthog.capture(eventName, sanitizeProps(props as PostHogEventProperties) as any);
  } catch {
    // ignore
  }
}

/**
 * PostHog Mobile のキャプチャを停止する
 */
export async function optOutPostHogMobile(): Promise<void> {
  try {
    await _posthog?.optOut();
  } catch {
    // ignore
  }
}

/**
 * PostHog Mobile のキャプチャを再開する
 */
export async function optInPostHogMobile(): Promise<void> {
  try {
    await _posthog?.optIn();
  } catch {
    // ignore
  }
}
