/**
 * push-notifications.test.ts
 * apps/mobile/src/lib/pushNotifications.ts のテスト
 * - 権限拒否 → null 返却
 * - Supabase upsert 成功 → トークン保存確認
 * - Supabase upsert 失敗 → エラーをスローする
 * - Android チャンネル作成パス
 * - isDevice=false → null 返却
 * - #1038 F7-09: EAS project ID の解決 (展開されなかった "$VAR" を読み飛ばして app.json へ) / 失敗の観測
 * - #1038 F7-10: ログアウト時に「この端末の行だけ」を user_push_tokens から消す
 * - #1413: 登録・削除の異常を、サーバーログ (POST /api/log → app_logs) にも残す (決まった値だけ。トークンの値・エラーの本文は送らない)
 */

// --- モック設定 ---

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
    from: jest.fn(() => ({ upsert: jest.fn().mockResolvedValue({ error: null }) })),
  },
}));

// サーバーログ (POST /api/log) の送り先。エラー境界の記録 (error-report.ts) と同じ getApi() を使う (#1413)
const mockPost = jest.fn();
const mockGetApi = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => mockGetApi(),
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { DEFAULT: 3 },
}));

jest.mock('expo-device', () => ({
  __esModule: true,
  isDevice: true,
}));

jest.mock('expo-constants', () => ({
  default: {},
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { supabase } from '../../src/lib/supabase';
import {
  PUSH_ISSUE_LOG_TIMEOUT_MS,
  PUSH_TOKEN_CLAIM_API_PATH,
  PUSH_TOKEN_VALUE_KEY_PREFIX,
  ensurePushTokenRegistered,
  registerAndSaveExpoPushToken,
  resolveEasProjectId,
  unregisterExpoPushToken,
} from '../../src/lib/pushNotifications';
import { PUSH_ISSUE_SERVER_METADATA_KEYS } from '../../src/lib/push-issue-log';

// 型キャスト用
const mockGetUser = supabase.auth.getUser as jest.Mock;
const mockFrom = supabase.from as jest.Mock;
const mockGetPermissionsAsync = Notifications.getPermissionsAsync as jest.Mock;
const mockRequestPermissionsAsync = Notifications.requestPermissionsAsync as jest.Mock;
const mockGetExpoPushTokenAsync = Notifications.getExpoPushTokenAsync as jest.Mock;
const mockSetNotificationChannelAsync = Notifications.setNotificationChannelAsync as jest.Mock;

// 登録・削除の異常は、端末のコンソール (console.warn) にだけ出す。PostHog などの外部には送らない (#1166)
let warnSpy: jest.SpyInstance;

/** console.warn に出された「[pushNotifications] <イベント名>」の異常。イベント名と詳細を返す */
function loggedPushIssues(): Array<{ event: string; details: unknown }> {
  const prefix = '[pushNotifications] ';
  return warnSpy.mock.calls
    .filter(([label]) => typeof label === 'string' && label.startsWith(prefix))
    .map(([label, details]) => ({ event: (label as string).slice(prefix.length), details }));
}

/** upsert モックを作り直して from に設定するヘルパー */
function setupUpsert(returnValue: { error: Error | null }) {
  const mockUpsert = jest.fn().mockResolvedValue(returnValue);
  mockFrom.mockReturnValue({ upsert: mockUpsert });
  return mockUpsert;
}

beforeEach(async () => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await AsyncStorage.clear();

  // project ID の出どころを毎回まっさらにする
  delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  const ConstantsMock = jest.requireMock('expo-constants');
  delete ConstantsMock.expoConfig;
  delete ConstantsMock.easConfig;

  // expo-device mock を物理端末状態にリセット
  const DeviceMock = jest.requireMock('expo-device');
  DeviceMock.isDevice = true;

  // react-native Platform を iOS にリセット
  const RNMock = jest.requireMock('react-native');
  RNMock.Platform.OS = 'ios';

  // デフォルト: 認証済みユーザー
  mockGetUser.mockResolvedValue({
    data: { user: { id: 'user-123' } },
  });

  // デフォルト: 既に権限付与済み
  mockGetPermissionsAsync.mockResolvedValue({ status: 'granted' });

  // デフォルト: トークン取得成功
  mockGetExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[test-token]' });

  // デフォルト: upsert 成功
  setupUpsert({ error: null });

  // デフォルト: サーバーログ (POST /api/log) への送信は成功
  mockPost.mockResolvedValue({ success: true });
  mockGetApi.mockReturnValue({ post: mockPost });
});

afterEach(() => {
  warnSpy.mockRestore();
  // どのテストでも、サーバーログに送った metadata のキーは、送ってよいキーの一覧 (push-issue-log.ts) の中だけ。
  // 一覧の各キーが sanitizeLogEntry にマスクされないこと (キー名に token などを含まないこと) は
  // tests/push-issue-log-sanitizer.test.ts (vitest) が本物の sanitizeLogEntry で確かめる (#1413)
  const allowed = new Set<string>(PUSH_ISSUE_SERVER_METADATA_KEYS);
  const sentKeys = mockPost.mock.calls.flatMap(([, body]) => Object.keys((body as { metadata?: object } | undefined)?.metadata ?? {}));
  expect(sentKeys.filter((key) => !allowed.has(key))).toEqual([]);
});

describe('registerAndSaveExpoPushToken — 権限拒否', () => {
  it('権限が拒否された場合、null を返す', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'denied' });
    mockRequestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    const result = await registerAndSaveExpoPushToken();

    expect(result).toBeNull();
    // upsert は呼ばれない
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('初回権限未決定のとき requestPermissionsAsync を呼び、denied なら null を返す', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    mockRequestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    const result = await registerAndSaveExpoPushToken();

    expect(mockRequestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });
});

describe('registerAndSaveExpoPushToken — 権限のダイアログを出すとき (#1038 F7-09)', () => {
  it('起動時の自動登録 (引数なし): 一度拒否された端末 (Android 13 以降は canAskAgain が true のまま) では、ダイアログを出さない', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: true });

    const result = await registerAndSaveExpoPushToken();

    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('起動時の自動登録: 一度も尋ねていない (undetermined) 端末では、尋ねる。許可されたら登録まで進む', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
    mockRequestPermissionsAsync.mockResolvedValue({ status: 'granted' });

    const result = await registerAndSaveExpoPushToken();

    expect(mockRequestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(result).toBe('ExponentPushToken[test-token]');
  });

  it('許可済みの端末では、尋ねずに登録する', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true });

    await registerAndSaveExpoPushToken();

    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledTimes(1);
  });

  it('利用者がボタンを押した登録 (userInitiated): 拒否済みでも OS がまだ尋ねられる (canAskAgain) なら、ダイアログを出す', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: true });
    mockRequestPermissionsAsync.mockResolvedValue({ status: 'granted' });

    const result = await registerAndSaveExpoPushToken({ userInitiated: true });

    expect(mockRequestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(result).toBe('ExponentPushToken[test-token]');
  });

  it('利用者がボタンを押した登録: OS がもう尋ねられない (canAskAgain が false) なら、ダイアログを出さない', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });

    const result = await registerAndSaveExpoPushToken({ userInitiated: true });

    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe('registerAndSaveExpoPushToken — Supabase upsert 成功', () => {
  it('upsert が成功した場合、トークンを返す', async () => {
    const mockUpsert = setupUpsert({ error: null });

    const result = await registerAndSaveExpoPushToken();

    expect(result).toBe('ExponentPushToken[test-token]');
    expect(mockFrom).toHaveBeenCalledWith('user_push_tokens');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-123',
        expo_push_token: 'ExponentPushToken[test-token]',
      }),
      expect.objectContaining({ onConflict: 'user_id,expo_push_token' })
    );
  });

  it('getExpoPushTokenAsync が呼ばれてトークンが取得される', async () => {
    const result = await registerAndSaveExpoPushToken();

    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    expect(result).toBe('ExponentPushToken[test-token]');
  });
});

describe('registerAndSaveExpoPushToken — Supabase upsert 失敗', () => {
  it('upsert が失敗した場合、エラーをスローする', async () => {
    const upsertError = new Error('DB upsert failed');
    setupUpsert({ error: upsertError });

    await expect(registerAndSaveExpoPushToken()).rejects.toThrow('DB upsert failed');
  });
});

describe('registerAndSaveExpoPushToken — Android チャンネル作成', () => {
  it('Android の場合、setNotificationChannelAsync が呼ばれる', async () => {
    jest.requireMock('react-native').Platform.OS = 'android';

    await registerAndSaveExpoPushToken();

    expect(mockSetNotificationChannelAsync).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ name: 'default' })
    );
  });

  it('iOS の場合、setNotificationChannelAsync は呼ばれない', async () => {
    // beforeEach で 'ios' に設定済み

    await registerAndSaveExpoPushToken();

    expect(mockSetNotificationChannelAsync).not.toHaveBeenCalled();
  });
});

describe('registerAndSaveExpoPushToken — 物理端末チェック', () => {
  it('isDevice が false のとき null を返す', async () => {
    jest.requireMock('expo-device').isDevice = false;

    const result = await registerAndSaveExpoPushToken();

    expect(result).toBeNull();
    expect(mockGetPermissionsAsync).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1038 F7-09: EAS project ID の解決
// ─────────────────────────────────────────────────────────────────────────────

const APP_JSON_PROJECT_ID = 'ce2a0961-4696-472c-8377-a3f83cecdff5';
const ENV_PROJECT_ID = '11111111-2222-4333-8444-555555555555';

/** expo-constants のモックに app.json 相当の設定を入れる (default import が mock 全体になるため直接書く) */
function setExpoConfig(extra: Record<string, unknown>) {
  jest.requireMock('expo-constants').expoConfig = { extra };
}

describe('resolveEasProjectId — #1038 F7-09', () => {
  it('環境変数が UUID なら最優先で使う', () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = ENV_PROJECT_ID;
    setExpoConfig({ eas: { projectId: APP_JSON_PROJECT_ID } });

    expect(resolveEasProjectId()).toEqual({ projectId: ENV_PROJECT_ID, source: 'env', rejected: [] });
  });

  it('eas.json の "$VAR" が展開されずに文字列のまま入っていても、app.json の projectId に落ちる', () => {
    // eas.json に "EXPO_PUBLIC_EAS_PROJECT_ID": "$EXPO_PUBLIC_EAS_PROJECT_ID" と書いて展開されなかった場合の値
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '$EXPO_PUBLIC_EAS_PROJECT_ID';
    setExpoConfig({ eas: { projectId: APP_JSON_PROJECT_ID } });

    expect(resolveEasProjectId()).toEqual({
      projectId: APP_JSON_PROJECT_ID,
      source: 'expoConfig',
      rejected: ['env'],
    });
  });

  it('プレースホルダー・空文字・UUID でない値は捨て、次の候補を使う', () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = 'PLEASE_SET_VIA_EAS_INIT';
    jest.requireMock('expo-constants').easConfig = { projectId: 'not-a-uuid' };
    setExpoConfig({ eas: { projectId: '' }, projectId: APP_JSON_PROJECT_ID });

    const resolved = resolveEasProjectId();
    expect(resolved.projectId).toBe(APP_JSON_PROJECT_ID);
    expect(resolved.source).toBe('extra');
    expect(resolved.rejected).toEqual(['env', 'easConfig']);
  });

  it('UUID は大文字でも受け付ける', () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = ENV_PROJECT_ID.toUpperCase();
    expect(resolveEasProjectId().projectId).toBe(ENV_PROJECT_ID.toUpperCase());
  });

  it('有効な候補が 1 つも無ければ projectId は undefined', () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '$EXPO_PUBLIC_EAS_PROJECT_ID';
    expect(resolveEasProjectId()).toEqual({ projectId: undefined, source: 'none', rejected: ['env'] });
  });
});

describe('registerAndSaveExpoPushToken — project ID の受け渡し (#1038 F7-09)', () => {
  it('展開されなかった "$VAR" ではなく app.json の projectId で getExpoPushTokenAsync を呼ぶ', async () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '$EXPO_PUBLIC_EAS_PROJECT_ID';
    setExpoConfig({ eas: { projectId: APP_JSON_PROJECT_ID } });

    await registerAndSaveExpoPushToken();

    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: APP_JSON_PROJECT_ID });
  });

  it('有効な projectId が無いときは projectId 抜きで呼ぶ (SDK 側の既定の解決に任せる)', async () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = 'PLEASE_SET_VIA_EAS_INIT';

    await registerAndSaveExpoPushToken();

    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledWith({});
  });
});

describe('registerAndSaveExpoPushToken — 失敗の観測 (#1038 F7-09)', () => {
  it('getExpoPushTokenAsync が失敗したら、例外を再スローしつつ端末のコンソールに出す (トークンやユーザー ID は載せない)', async () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '$EXPO_PUBLIC_EAS_PROJECT_ID';
    const failure = Object.assign(new Error('Invalid uuid for projectId'), { name: 'CodedError' });
    mockGetExpoPushTokenAsync.mockRejectedValue(failure);

    await expect(registerAndSaveExpoPushToken()).rejects.toThrow('Invalid uuid for projectId');

    const issues = loggedPushIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].event).toBe('push_token_registration_failed');
    expect(issues[0].details).toEqual({
      stage: 'get_token',
      platform: 'ios',
      error_name: 'CodedError',
      error_message: 'Invalid uuid for projectId',
      project_id_source: 'none',
      rejected_project_id_sources: 'env',
    });
    expect(JSON.stringify(issues)).not.toContain('user-123');
  });

  it('DB への保存が失敗したときも端末のコンソールに出して再スローする (取得済みのトークンの値やユーザー ID は載せない)', async () => {
    setupUpsert({ error: Object.assign(new Error('permission denied'), { name: 'PostgrestError' }) });

    await expect(registerAndSaveExpoPushToken()).rejects.toThrow('permission denied');

    const issues = loggedPushIssues();
    expect(issues).toEqual([
      {
        event: 'push_token_registration_failed',
        details: expect.objectContaining({ stage: 'save_token', error_name: 'PostgrestError' }),
      },
    ]);
    // この時点で取得済みのトークンの値 (ExponentPushToken[test-token]) とユーザー ID は、出力に含まれない
    expect(JSON.stringify(issues)).not.toContain('ExponentPushToken');
    expect(JSON.stringify(issues)).not.toContain('user-123');
    // 保存に失敗したトークンは控えない
    expect(await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`)).toBeNull();
  });

  it('成功したときは何も出さず、登録した値をユーザー別に控える', async () => {
    await registerAndSaveExpoPushToken();

    expect(loggedPushIssues()).toEqual([]);
    expect(await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`)).toBe('ExponentPushToken[test-token]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1599: 登録の直後に、同じトークンのほかの利用者の行をサーバーで外す (claim)
// ─────────────────────────────────────────────────────────────────────────────

/** mockPost への呼び出しのうち、claim の API へのもの */
function claimCalls(): unknown[][] {
  return mockPost.mock.calls.filter(([path]) => path === PUSH_TOKEN_CLAIM_API_PATH);
}

describe('registerAndSaveExpoPushToken — 同じトークンのほかの利用者の行を外す (#1599)', () => {
  it('API のパスは、サーバーの route (src/app/api/push-tokens/claim/route.ts) と同じ', () => {
    expect(PUSH_TOKEN_CLAIM_API_PATH).toBe('/api/push-tokens/claim');
  });

  it('本人の行の登録 (upsert) が済んでから、同じトークンで claim を呼ぶ (値の控えは claim より先)', async () => {
    const order: string[] = [];
    const mockUpsert = jest.fn(async () => {
      order.push('upsert');
      return { error: null };
    });
    mockFrom.mockReturnValue({ upsert: mockUpsert });
    mockPost.mockImplementation(async (path: string) => {
      order.push(`post:${path}`);
      // claim の時点で、ログアウトで消すための値はもう控えてある
      order.push(`stored:${await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`)}`);
      return { released: 1 };
    });

    const result = await registerAndSaveExpoPushToken();

    expect(result).toBe('ExponentPushToken[test-token]');
    expect(order).toEqual(['upsert', `post:${PUSH_TOKEN_CLAIM_API_PATH}`, 'stored:ExponentPushToken[test-token]']);
    expect(claimCalls()).toEqual([[PUSH_TOKEN_CLAIM_API_PATH, { expo_push_token: 'ExponentPushToken[test-token]' }]]);
  });

  it('権限が無くトークンを取らなかったとき・登録 (upsert) が失敗したときは、claim を呼ばない', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'denied' });
    mockRequestPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await registerAndSaveExpoPushToken();
    expect(claimCalls()).toEqual([]);

    mockGetPermissionsAsync.mockResolvedValue({ status: 'granted' });
    setupUpsert({ error: new Error('DB upsert failed') });
    await expect(registerAndSaveExpoPushToken()).rejects.toThrow('DB upsert failed');
    expect(claimCalls()).toEqual([]);
  });

  it('claim が失敗したら登録の失敗として投げ、起動時の自動登録は次の起動で登録と claim をやり直す', async () => {
    const claimError = new Error('HTTP 500 Internal Server Error: {"error":"処理中にエラーが発生しました"}');
    mockPost.mockImplementation(async (path: string) => {
      if (path === PUSH_TOKEN_CLAIM_API_PATH) throw claimError;
      return { success: true };
    });

    await expect(ensurePushTokenRegistered()).rejects.toBe(claimError);

    // 本人の行は登録済みなので、ログアウトで消せるよう値は控えてある
    expect(await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`)).toBe('ExponentPushToken[test-token]');

    // 次の起動では、登録と claim をもう一度通す
    mockPost.mockResolvedValue({ released: 1 });
    await ensurePushTokenRegistered();
    expect(claimCalls()).toHaveLength(2);
  });

  it('claim の失敗は、段 claim_token と HTTP の状態だけを端末のコンソールとサーバーログに残す (トークンの値・本文は送らない)', async () => {
    mockPost.mockImplementation(async (path: string) => {
      if (path === PUSH_TOKEN_CLAIM_API_PATH) {
        throw new Error(`HTTP 503 Service Unavailable: ${SECRET_ERROR_TEXT}`);
      }
      return { success: true };
    });

    await expect(registerAndSaveExpoPushToken()).rejects.toThrow('HTTP 503');

    expect(loggedPushIssues().map((issue) => issue.event)).toEqual(['push_token_registration_failed']);
    expect(loggedPushIssues()[0].details).toEqual(expect.objectContaining({ stage: 'claim_token' }));
    const logs = serverLogCalls().filter((call) => call.path === '/api/log');
    expect(logs).toHaveLength(1);
    expect(logs[0].body.metadata).toEqual(
      expect.objectContaining({ event: 'push_token_registration_failed', stage: 'claim_token', http_status: 503 }),
    );
    const sentLogs = JSON.stringify(logs);
    expect(sentLogs).not.toContain('ExponentPushToken');
    expect(sentLogs).not.toContain('hunter2');
    expect(sentLogs).not.toContain('user-123');
  });

  it('通信の失敗 (HTTP の状態が無いエラー) では、http_status を送らない', async () => {
    mockPost.mockImplementation(async (path: string) => {
      if (path === PUSH_TOKEN_CLAIM_API_PATH) throw new TypeError('Network request failed');
      return { success: true };
    });

    await expect(registerAndSaveExpoPushToken()).rejects.toThrow('Network request failed');

    const logs = serverLogCalls().filter((call) => call.path === '/api/log');
    expect(logs[0].body.metadata).toEqual(expect.objectContaining({ stage: 'claim_token', error_name: 'TypeError' }));
    expect(logs[0].body.metadata).not.toHaveProperty('http_status');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1038 F7-10: ログアウト時に push token を消す
// ─────────────────────────────────────────────────────────────────────────────

type DeleteResult = { error: unknown; count?: number | null; status?: number };

/**
 * from('user_push_tokens').delete({ count: 'exact' }).eq(...).eq(...)[.setHeader(...)] のチェーンを作る。
 * 最後に await されたとき result を返す (postgrest-js のビルダーと同じく、setHeader は自分自身を返す)
 */
function setupDelete(result: DeleteResult | Promise<DeleteResult> = { error: null }) {
  const pending = Promise.resolve(result);
  const builder = { then: pending.then.bind(pending), setHeader: jest.fn() };
  builder.setHeader.mockReturnValue(builder);
  const eqToken = jest.fn().mockReturnValue(builder);
  const eqUser = jest.fn().mockReturnValue({ eq: eqToken });
  const del = jest.fn().mockReturnValue({ eq: eqUser });
  mockFrom.mockReturnValue({ delete: del });
  return { del, eqUser, eqToken, setHeader: builder.setHeader };
}

describe('unregisterExpoPushToken — #1038 F7-10', () => {
  it('控えておいたトークンについて、user_id と expo_push_token の両方で絞って削除する', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
    const { del, eqUser, eqToken } = setupDelete();

    const result = await unregisterExpoPushToken('user-123');

    expect(result).toBe('deleted');
    expect(mockFrom).toHaveBeenCalledWith('user_push_tokens');
    expect(del).toHaveBeenCalledTimes(1);
    // 消えた行の件数を数える (0 件を見逃さないため)
    expect(del).toHaveBeenCalledWith({ count: 'exact' });
    expect(eqUser).toHaveBeenCalledWith('user_id', 'user-123');
    // 同じユーザーの他の端末の行まで消さない (expo_push_token で必ず絞る)
    expect(eqToken).toHaveBeenCalledWith('expo_push_token', 'ExponentPushToken[this-device]');
    // 控えを使えたので、Expo に問い合わせ直さない
    expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('アクセストークンを渡したら、Authorization ヘッダーをそのトークンで明示して削除する (セッションが先に失効しても、本人の行を消せる)', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
    const { setHeader } = setupDelete();

    const result = await unregisterExpoPushToken('user-123', { accessToken: 'saved-access-token' });

    expect(result).toBe('deleted');
    // supabase-js は Authorization ヘッダーが既にあれば、いまのセッション (消えていれば anon キー) で上書きしない
    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith('Authorization', 'Bearer saved-access-token');
  });

  it('アクセストークンを渡さなければ、ヘッダーは足さない (いまのセッションで認可される。設定画面・マイページのログアウト)', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
    const { setHeader } = setupDelete();

    expect(await unregisterExpoPushToken('user-123')).toBe('deleted');
    expect(await unregisterExpoPushToken('user-123', { accessToken: null })).toBe('deleted');

    expect(setHeader).not.toHaveBeenCalled();
  });

  it('DELETE は通ったが消えた行が 0 件だったら (RLS に弾かれた・行が既に無い。エラーにならない)、no_rows を返して端末のコンソールに出す', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
    setupDelete({ error: null, count: 0 });

    const result = await unregisterExpoPushToken('user-123', { accessToken: 'saved-access-token' });

    expect(result).toBe('no_rows');
    // no_rows の 1 件だけ (push_token_unregister_failed は出ない)。トークンの値やユーザー ID は載せない
    const issues = loggedPushIssues();
    expect(issues).toEqual([
      {
        event: 'push_token_unregister_no_rows',
        details: { platform: 'ios', token_source: 'stored', explicit_access_token: true },
      },
    ]);
    expect(JSON.stringify(issues)).not.toContain('ExponentPushToken');
    expect(JSON.stringify(issues)).not.toContain('user-123');
    expect(JSON.stringify(issues)).not.toContain('saved-access-token');
  });

  it('0 件のとき、取り直したトークンで削除したのか (token_source: refetched) と、アクセストークンを渡さなかったことも区別して出す', async () => {
    setExpoConfig({ eas: { projectId: APP_JSON_PROJECT_ID } });
    mockGetExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[refetched]' });
    setupDelete({ error: null, count: 0 });

    expect(await unregisterExpoPushToken('user-123')).toBe('no_rows');

    expect(loggedPushIssues()).toEqual([
      {
        event: 'push_token_unregister_no_rows',
        details: { platform: 'ios', token_source: 'refetched', explicit_access_token: false },
      },
    ]);
  });

  it.each([
    ['1 件', 1],
    ['2 件', 2],
    ['件数が返らない (undefined)', undefined],
    ['件数が返らない (null)', null],
  ])('消えた行が %s のときは deleted (0 件と断定できないものを、異常として出さない)', async (_label, count) => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
    setupDelete({ error: null, count });

    expect(await unregisterExpoPushToken('user-123')).toBe('deleted');
    expect(loggedPushIssues()).toEqual([]);
  });

  it('userId が無ければ何もしない', async () => {
    expect(await unregisterExpoPushToken(null)).toBe('skipped');
    expect(await unregisterExpoPushToken(undefined)).toBe('skipped');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('控えが無い端末 (この変更より前のビルドで登録済み) は getExpoPushTokenAsync で取り直して削除する', async () => {
    setExpoConfig({ eas: { projectId: APP_JSON_PROJECT_ID } });
    mockGetExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[refetched]' });
    const { eqToken } = setupDelete();

    const result = await unregisterExpoPushToken('user-123');

    expect(result).toBe('deleted');
    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: APP_JSON_PROJECT_ID });
    expect(eqToken).toHaveBeenCalledWith('expo_push_token', 'ExponentPushToken[refetched]');
  });

  it('控えも無く取り直しにも失敗したら、DB には触らず skipped (ログアウトは止めない)', async () => {
    mockGetExpoPushTokenAsync.mockRejectedValue(new Error('offline'));

    expect(await unregisterExpoPushToken('user-123')).toBe('skipped');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('物理端末でない (トークンが無い) 場合も、控えが無ければ skipped', async () => {
    jest.requireMock('expo-device').isDevice = false;

    expect(await unregisterExpoPushToken('user-123')).toBe('skipped');
    expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('DB の削除が失敗したら failed を返し、端末のコンソールに出す (例外は投げない)', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
    setupDelete({ error: { name: 'PostgrestError', code: '42501', message: 'permission denied' } });

    await expect(unregisterExpoPushToken('user-123')).resolves.toBe('failed');

    const issues = loggedPushIssues();
    expect(issues).toEqual([
      {
        event: 'push_token_unregister_failed',
        details: { platform: 'ios', error_name: 'PostgrestError', error_code: '42501' },
      },
    ]);
    expect(JSON.stringify(issues)).not.toContain('ExponentPushToken');
    expect(JSON.stringify(issues)).not.toContain('user-123');
  });

  it('通信が返ってこなくても、待ち時間の上限で failed を返して先へ進める', async () => {
    jest.useFakeTimers();
    try {
      await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
      // 永遠に解決しない
      setupDelete(new Promise(() => {}));

      const pending = unregisterExpoPushToken('user-123', { timeoutMs: 3000 });
      await jest.advanceTimersByTimeAsync(3000);

      await expect(pending).resolves.toBe('failed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('途中で例外が起きても握りつぶして failed を返す', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
    mockFrom.mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(unregisterExpoPushToken('user-123')).resolves.toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1038 F7-09 / #1599: 起動時の登録 (「登録済み」の印で省かない)
// ─────────────────────────────────────────────────────────────────────────────

/** user_push_tokens の行 (テストの中だけの表) */
type FakeTokenRow = { user_id: string; expo_push_token: string };

/**
 * user_push_tokens の upsert と claim (同じトークンのほかの利用者の行を消す) と、ログアウトの削除を、テストの中の表で真似る。
 * サーバーの claim の本物は src/__tests__/api/push-tokens-claim.test.ts (vitest) が確かめる。
 * ここでは、端末の登録の流れが「いまの利用者の行が表にある」状態へ戻すかを見る
 */
function setupFakeTokenTable() {
  const rows: FakeTokenRow[] = [];
  let currentUserId = 'user-123';
  mockGetUser.mockImplementation(async () => ({ data: { user: { id: currentUserId } } }));
  mockFrom.mockReturnValue({
    upsert: jest.fn(async (row: FakeTokenRow) => {
      if (!rows.some((r) => r.user_id === row.user_id && r.expo_push_token === row.expo_push_token)) {
        rows.push({ user_id: row.user_id, expo_push_token: row.expo_push_token });
      }
      return { error: null, status: 201 };
    }),
  });
  mockPost.mockImplementation(async (path: string, body?: { expo_push_token?: string }) => {
    if (path !== PUSH_TOKEN_CLAIM_API_PATH) return { success: true };
    let released = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].expo_push_token === body?.expo_push_token && rows[i].user_id !== currentUserId) {
        rows.splice(i, 1);
        released += 1;
      }
    }
    return { released };
  });
  return {
    rows,
    login(userId: string) {
      currentUserId = userId;
    },
    /** 掃除を通らずにセッションが終わる (印や控えの値は端末に残る) */
    endSessionWithoutCleanup() {
      currentUserId = '';
    },
    /** 通常のログアウトの削除 (この端末のトークンの、この利用者の行だけ) */
    deleteOwnRow(userId: string, token: string) {
      const index = rows.findIndex((r) => r.user_id === userId && r.expo_push_token === token);
      if (index >= 0) rows.splice(index, 1);
    },
  };
}

describe('ensurePushTokenRegistered — #1038 F7-09 / #1599', () => {
  const TOKEN = 'ExponentPushToken[test-token]';

  it('起動のたびに、登録 (upsert) と claim を通す (「登録済み」の印は付けない・読まない)', async () => {
    const mockUpsert = setupUpsert({ error: null });

    await ensurePushTokenRegistered();
    await ensurePushTokenRegistered();

    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledTimes(2);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(claimCalls()).toHaveLength(2);
    // 印は書かない (旧ビルドの印はログアウトで消すだけ: user-storage.ts)
    expect(await AsyncStorage.getItem('push_token_registered_v2:user-123')).toBeNull();
  });

  it('旧ビルドが付けた「登録済み」の印 (v2・v1) が残っていても、登録と claim を通す', async () => {
    // v1: #1038 より前のビルドは、権限を拒否されても印を付けた。v2: #1599 より前のビルドは、印があれば何もしなかった
    await AsyncStorage.setItem('push_token_registered_v1:user-123', '1');
    await AsyncStorage.setItem('push_token_registered_v2:user-123', '1');

    await ensurePushTokenRegistered();

    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    expect(claimCalls()).toEqual([[PUSH_TOKEN_CLAIM_API_PATH, { expo_push_token: TOKEN }]]);
  });

  it('共有の端末: 掃除を通らずにセッションが終わった利用者 A の行を、B の claim が消したあと、A が再びログインすると A の行が戻る', async () => {
    const table = setupFakeTokenTable();

    // (1) A がログインして登録する。旧ビルドなら、ここで A の「登録済み」の印が付いていた
    table.login('user-a');
    await ensurePushTokenRegistered();
    await AsyncStorage.setItem('push_token_registered_v2:user-a', '1');
    expect(table.rows).toEqual([{ user_id: 'user-a', expo_push_token: TOKEN }]);

    // (2) A のセッションが掃除を通らずに終わる (Web の signOut() による全端末の失効で、起動時の更新が失敗して SIGNED_OUT になるなど)
    table.endSessionWithoutCleanup();

    // (3) B が同じ端末でログインして登録する。claim が A の行を消す
    table.login('user-b');
    await ensurePushTokenRegistered();
    expect(table.rows).toEqual([{ user_id: 'user-b', expo_push_token: TOKEN }]);

    // (4) B は通常どおりログアウトし、B の行を消す
    table.deleteOwnRow('user-b', TOKEN);
    expect(table.rows).toEqual([]);

    // (5) A が同じ端末で再びログインする。A の印が残っていても、A の行を登録し直す
    table.login('user-a');
    await ensurePushTokenRegistered();
    expect(table.rows).toEqual([{ user_id: 'user-a', expo_push_token: TOKEN }]);
  });

  it('同じ端末で B のログアウトの削除が失敗しても、A が再びログインすると、トークンは A だけに紐づく', async () => {
    const table = setupFakeTokenTable();

    table.login('user-a');
    await ensurePushTokenRegistered();
    table.endSessionWithoutCleanup();
    table.login('user-b');
    await ensurePushTokenRegistered();
    // B のログアウトの削除が失敗した (オフラインなど): B の行が残る
    table.endSessionWithoutCleanup();

    table.login('user-a');
    await ensurePushTokenRegistered();
    expect(table.rows).toEqual([{ user_id: 'user-a', expo_push_token: TOKEN }]);
  });

  it('権限が拒否されて登録できなかったときは何もしない。後から OS の設定で許可すれば、次の起動で登録される', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'denied' });
    mockRequestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await ensurePushTokenRegistered();

    expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(claimCalls()).toEqual([]);

    // 許可された後の起動では、登録される
    mockGetPermissionsAsync.mockResolvedValue({ status: 'granted' });
    await ensurePushTokenRegistered();
    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    expect(claimCalls()).toHaveLength(1);
  });

  it('起動時の自動登録は、拒否された権限のダイアログを出し直さない (まだ尋ねていないときだけ出す)', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: true });

    await ensurePushTokenRegistered();
    await ensurePushTokenRegistered();

    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('実機でない (Expo Go のシミュレーターなど) 場合は何もしない', async () => {
    jest.requireMock('expo-device').isDevice = false;

    await ensurePushTokenRegistered();

    expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(claimCalls()).toEqual([]);
  });

  it('登録に失敗したら例外を伝える (呼び出し側が握りつぶす)', async () => {
    mockGetExpoPushTokenAsync.mockRejectedValue(new Error('No "projectId" found'));

    await expect(ensurePushTokenRegistered()).rejects.toThrow('No "projectId" found');
    expect(claimCalls()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1413: 登録・削除の異常を、サーバーログ (POST /api/log → app_logs) にも残す
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/log に送った呼び出し (path・本文・指定) */
function serverLogCalls(): Array<{ path: string; body: { level: string; message: string; metadata: Record<string, unknown> }; init: { headers?: Record<string, string>; timeoutMs?: number; retry?: unknown } }> {
  return mockPost.mock.calls.map(([path, body, init]) => ({ path, body, init }));
}

/** 解決を外から決められる Promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 未処理のまま残った Promise の失敗 (送信の失敗を握りつぶし損ねると出る) を数える */
function trackUnhandledRejections() {
  const reasons: unknown[] = [];
  const onRejection = (reason: unknown) => reasons.push(reason);
  process.on('unhandledRejection', onRejection);
  return {
    reasons,
    stop: () => process.off('unhandledRejection', onRejection),
  };
}

const SECRET_ERROR_TEXT = 'permission denied for ExponentPushToken[this-device] password=hunter2';

describe('サーバーログ (POST /api/log) への記録 — 登録の失敗 (#1413)', () => {
  it('トークンを取れなかったら、イベント名・OS・エラーの種類だけを /api/log に送る (エラーの本文・ユーザー ID は送らない)', async () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '$EXPO_PUBLIC_EAS_PROJECT_ID';
    const failure = Object.assign(new Error(`Invalid uuid for projectId ${SECRET_ERROR_TEXT}`), {
      name: 'CodedError',
      code: 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID',
    });
    mockGetExpoPushTokenAsync.mockRejectedValue(failure);

    await expect(registerAndSaveExpoPushToken()).rejects.toBe(failure);

    const calls = serverLogCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/log');
    expect(calls[0].body).toEqual({
      level: 'warn',
      message: 'push token issue: push_token_registration_failed',
      metadata: {
        app: 'mobile',
        event: 'push_token_registration_failed',
        stage: 'get_token',
        platform: 'ios',
        error_name: 'CodedError',
        error_code: 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID',
        project_id_source: 'none',
        rejected_project_id_sources: 'env',
      },
    });
    // 登録はログイン中なので、いまのセッションで認可する (Authorization を明示しない)。記録のために送り直さない
    expect(calls[0].init.headers).toBeUndefined();
    expect(calls[0].init.retry).toBe(false);
    const sent = JSON.stringify(mockPost.mock.calls);
    expect(sent).not.toContain('Invalid uuid');
    expect(sent).not.toContain('hunter2');
    expect(sent).not.toContain('ExponentPushToken');
    expect(sent).not.toContain('user-123');
  });

  it('DB への保存が失敗したら、取得済みのトークンの値もエラーの本文も送らず、コードと HTTP の状態だけを送る', async () => {
    const dbError = Object.assign(new Error(SECRET_ERROR_TEXT), { name: 'PostgrestError', code: '42501' });
    mockFrom.mockReturnValue({ upsert: jest.fn().mockResolvedValue({ error: dbError, status: 403 }) });
    setExpoConfig({ eas: { projectId: APP_JSON_PROJECT_ID } });

    await expect(registerAndSaveExpoPushToken()).rejects.toBe(dbError);

    const calls = serverLogCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.metadata).toEqual({
      app: 'mobile',
      event: 'push_token_registration_failed',
      stage: 'save_token',
      platform: 'ios',
      error_name: 'PostgrestError',
      error_code: '42501',
      http_status: 403,
      project_id_source: 'expoConfig',
      rejected_project_id_sources: 'none',
    });
    const sent = JSON.stringify(mockPost.mock.calls);
    expect(sent).not.toContain('ExponentPushToken');
    expect(sent).not.toContain('permission denied');
    expect(sent).not.toContain('hunter2');
    expect(sent).not.toContain('user-123');
  });

  it('エラーの名前・コードに文が入っていたら (決まった形でなければ)、その値は送らず unknown にする', async () => {
    const failure = Object.assign(new Error('boom'), {
      name: `Error: ${SECRET_ERROR_TEXT}`,
      code: { nested: 'ExponentPushToken[this-device]' },
    });
    mockGetExpoPushTokenAsync.mockRejectedValue(failure);

    await expect(registerAndSaveExpoPushToken()).rejects.toBe(failure);

    const metadata = serverLogCalls()[0].body.metadata;
    expect(metadata.error_name).toBe('unknown');
    expect(metadata.error_code).toBe('unknown');
    expect(JSON.stringify(mockPost.mock.calls)).not.toContain('ExponentPushToken');
  });

  it('Android の端末なら platform は android で送る', async () => {
    jest.requireMock('react-native').Platform.OS = 'android';
    mockGetExpoPushTokenAsync.mockRejectedValue(new Error('offline'));

    await expect(registerAndSaveExpoPushToken()).rejects.toThrow('offline');

    expect(serverLogCalls()[0].body.metadata.platform).toBe('android');
  });

  it('/api/log への送信が失敗しても、登録の失敗はそのまま (元のエラーで) 伝わり、未処理の失敗も残らない', async () => {
    const tracker = trackUnhandledRejections();
    try {
      mockPost.mockRejectedValue(new Error('HTTP 401 Unauthorized'));
      const failure = new Error('No "projectId" found');
      mockGetExpoPushTokenAsync.mockRejectedValue(failure);

      await expect(registerAndSaveExpoPushToken()).rejects.toBe(failure);
      // 送信の失敗が片づくのを待つ
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(tracker.reasons).toEqual([]);
    } finally {
      tracker.stop();
    }
  });

  it('getApi() が例外を投げても (API の基点の環境変数が無いなど)、登録の失敗はそのまま伝わる', async () => {
    mockGetApi.mockImplementation(() => {
      throw new Error('[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL');
    });
    const failure = new Error('No "projectId" found');
    mockGetExpoPushTokenAsync.mockRejectedValue(failure);

    await expect(registerAndSaveExpoPushToken()).rejects.toBe(failure);
  });

  it('登録の失敗では、/api/log の応答を待たずに失敗を返す (利用者の操作を待たせない)', async () => {
    // 永遠に返らない
    mockPost.mockReturnValue(new Promise(() => {}));
    const failure = new Error('No "projectId" found');
    mockGetExpoPushTokenAsync.mockRejectedValue(failure);

    await expect(registerAndSaveExpoPushToken()).rejects.toBe(failure);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('登録できたときは、/api/log に何も送らない', async () => {
    await registerAndSaveExpoPushToken();

    expect(serverLogCalls().filter((call) => call.path === '/api/log')).toEqual([]);
  });
});

describe('サーバーログ (POST /api/log) への記録 — ログアウトの直前の削除 (#1413)', () => {
  beforeEach(async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
  });

  // 控えたアクセストークンを渡されるのは、Web から始まったサインアウト・session-expired のときだけ。そのときはサーバー側のセッションが
  // 先に失効しているので、/api/log (サーバーの getUser() でセッションの存在まで確かめる) は 401 を返し、この記録は app_logs に残らない
  // (本物のサーバーで tests/integration/security/push-issue-log-after-session-revoked.test.ts が確かめる。経路の通しは
  // web-view-auth-messages.real-auth.test.ts)。ここで見るのは、送る要求の形 (本文に入れる値・Authorization の明示) だけ
  it('削除が失敗したら /api/log に送り、控えたアクセストークンがあれば Authorization に明示する (トークンの値・エラーの本文は送らない)', async () => {
    setupDelete({ error: { name: 'PostgrestError', code: '42501', message: SECRET_ERROR_TEXT }, status: 403 });

    expect(await unregisterExpoPushToken('user-123', { accessToken: 'saved-access-token' })).toBe('failed');

    const calls = serverLogCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/log');
    expect(calls[0].body).toEqual({
      level: 'warn',
      message: 'push token issue: push_token_unregister_failed',
      metadata: {
        app: 'mobile',
        event: 'push_token_unregister_failed',
        platform: 'ios',
        reason: 'error',
        error_name: 'PostgrestError',
        error_code: '42501',
        http_status: 403,
        push_value_source: 'stored',
        explicit_auth_header: true,
      },
    });
    // 削除と同じ本人の JWT を Authorization に明示する (端末のセッションのトークンで上書きされない)。
    // 明示しても、サーバー側のセッションが失効していれば /api/log は 401 を返す (上の注記)
    expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer saved-access-token' });
    expect(calls[0].init.retry).toBe(false);
    // 本文 (サーバーログに残るもの) には、push token・アクセストークン・エラーの本文・ユーザー ID を入れない
    const body = JSON.stringify(calls[0].body);
    expect(body).not.toContain('ExponentPushToken');
    expect(body).not.toContain('saved-access-token');
    expect(body).not.toContain('permission denied');
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('user-123');
  });

  it('消えた行が 0 件なら push_token_unregister_no_rows と件数 (0) を送る', async () => {
    setupDelete({ error: null, count: 0 });

    expect(await unregisterExpoPushToken('user-123')).toBe('no_rows');

    const calls = serverLogCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.metadata).toEqual({
      app: 'mobile',
      event: 'push_token_unregister_no_rows',
      platform: 'ios',
      push_value_source: 'stored',
      explicit_auth_header: false,
      deleted_count: 0,
    });
    // アクセストークンを渡されなければ、いまのセッションで認可する (Authorization を明示しない)
    expect(calls[0].init.headers).toBeUndefined();
    expect(JSON.stringify(mockPost.mock.calls)).not.toContain('ExponentPushToken');
  });

  it('/api/log が回数制限 (429) で断っても、削除の結果をそのまま返し、待ちも長引かず、未処理の失敗も残さない (#1493)', async () => {
    const tracker = trackUnhandledRejections();
    try {
      // 共通の HTTP クライアントが 429 の応答から作る Error と同じ形 (POST は自動でやり直さない)
      mockPost.mockRejectedValue(
        new Error('HTTP 429 Too Many Requests: {"error":"リクエストが多すぎます。","code":"RATE_LIMITED","retryAfter":42}'),
      );
      setupDelete({ error: null, count: 0 });

      expect(await unregisterExpoPushToken('user-123', { accessToken: 'saved-access-token' })).toBe('no_rows');
      await new Promise((resolve) => setImmediate(resolve));

      // 送ったのは 1 回だけ (記録のために同じ送信を繰り返さない)
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(serverLogCalls()[0].init.retry).toBe(false);
      expect(tracker.reasons).toEqual([]);
    } finally {
      tracker.stop();
    }
  });

  it('取り直した値で消し、控えたアクセストークンで認可して 0 件なら、push_value_source: refetched と explicit_auth_header: true を送る (キー名に token を含めないので、サーバーでマスクされない。true の行が /api/log の認証を通るかは上の注記)', async () => {
    await AsyncStorage.removeItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`);
    setExpoConfig({ eas: { projectId: APP_JSON_PROJECT_ID } });
    mockGetExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[refetched]' });
    setupDelete({ error: null, count: 0 });

    expect(await unregisterExpoPushToken('user-123', { accessToken: 'saved-access-token' })).toBe('no_rows');

    expect(serverLogCalls().map((c) => c.body.metadata)).toEqual([
      {
        app: 'mobile',
        event: 'push_token_unregister_no_rows',
        platform: 'ios',
        push_value_source: 'refetched',
        explicit_auth_header: true,
        deleted_count: 0,
      },
    ]);
    // 端末のコンソールのキーは以前のまま (サーバーには送らない)
    expect(loggedPushIssues()).toEqual([
      {
        event: 'push_token_unregister_no_rows',
        details: { platform: 'ios', token_source: 'refetched', explicit_access_token: true },
      },
    ]);
    const body = JSON.stringify(serverLogCalls()[0].body);
    expect(body).not.toContain('ExponentPushToken');
    expect(body).not.toContain('saved-access-token');
  });

  it('待ち時間の上限で打ち切ったら、reason: timeout で送る (端末のコンソールにも出す)', async () => {
    jest.useFakeTimers();
    try {
      setupDelete(new Promise(() => {}));

      const pending = unregisterExpoPushToken('user-123', { timeoutMs: 3000 });
      await jest.advanceTimersByTimeAsync(3000);

      await expect(pending).resolves.toBe('failed');
      expect(serverLogCalls().map((c) => c.body.metadata)).toEqual([
        { app: 'mobile', event: 'push_token_unregister_failed', platform: 'ios', reason: 'timeout', explicit_auth_header: false },
      ]);
      expect(loggedPushIssues()).toEqual([
        { event: 'push_token_unregister_failed', details: { platform: 'ios', reason: 'timeout' } },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('途中で例外が起きたら、reason: exception とエラーの名前だけを送る (本文は送らない)', async () => {
    mockFrom.mockImplementation(() => {
      throw Object.assign(new Error(SECRET_ERROR_TEXT), { name: 'TypeError' });
    });

    expect(await unregisterExpoPushToken('user-123')).toBe('failed');

    expect(serverLogCalls().map((c) => c.body.metadata)).toEqual([
      {
        app: 'mobile',
        event: 'push_token_unregister_failed',
        platform: 'ios',
        reason: 'exception',
        error_name: 'TypeError',
        explicit_auth_header: false,
      },
    ]);
    expect(JSON.stringify(mockPost.mock.calls)).not.toContain('hunter2');
  });

  it('削除できたとき・何もしなかったとき (skipped) は、/api/log に何も送らない', async () => {
    setupDelete({ error: null, count: 1 });
    expect(await unregisterExpoPushToken('user-123')).toBe('deleted');
    expect(await unregisterExpoPushToken(null)).toBe('skipped');

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('/api/log の応答を待ってから返る (呼び出し側はこのあとサインアウトするので、端末からのサインアウトではセッションが消える前に送り終える)', async () => {
    setupDelete({ error: null, count: 0 });
    const response = deferred<unknown>();
    mockPost.mockReturnValue(response.promise);

    let settled = false;
    const pending = unregisterExpoPushToken('user-123').then((result) => {
      settled = true;
      return result;
    });

    // /api/log へ送り出したが、応答はまだ
    for (let i = 0; i < 20 && mockPost.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(mockPost).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    response.resolve({ success: true });
    await expect(pending).resolves.toBe('no_rows');
  });

  it('/api/log が返らなくても、送信の待ち時間の上限で先へ進む (ログアウトを止めない)', async () => {
    jest.useFakeTimers();
    try {
      setupDelete({ error: null, count: 0 });
      // 永遠に返らない
      mockPost.mockReturnValue(new Promise(() => {}));

      let settled = false;
      const pending = unregisterExpoPushToken('user-123').then((result) => {
        settled = true;
        return result;
      });

      await jest.advanceTimersByTimeAsync(PUSH_ISSUE_LOG_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toBe('no_rows');
      // 送信には同じ上限を指定する (共通の HTTP クライアントが通信を打ち切る)
      expect(serverLogCalls()[0].init.timeoutMs).toBe(PUSH_ISSUE_LOG_TIMEOUT_MS);
    } finally {
      jest.useRealTimers();
    }
  });

  it('/api/log への送信が失敗しても、例外を投げずに削除の結果を返す', async () => {
    const tracker = trackUnhandledRejections();
    try {
      setupDelete({ error: { name: 'PostgrestError', code: '42501', message: 'denied' } });
      mockPost.mockRejectedValue(new Error('HTTP 401 Unauthorized'));

      await expect(unregisterExpoPushToken('user-123')).resolves.toBe('failed');
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(tracker.reasons).toEqual([]);
    } finally {
      tracker.stop();
    }
  });

  it('getApi() が例外を投げても、例外を投げずに削除の結果を返す', async () => {
    setupDelete({ error: null, count: 0 });
    mockGetApi.mockImplementation(() => {
      throw new Error('[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL');
    });

    await expect(unregisterExpoPushToken('user-123')).resolves.toBe('no_rows');
  });
});
