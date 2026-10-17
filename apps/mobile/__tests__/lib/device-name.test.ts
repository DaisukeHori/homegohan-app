/**
 * device-name.test.ts
 * apps/mobile/src/lib/device-name.ts のテスト (#1189。docs/design/cross/16-auth-history-sessions.md §16・§20.4)
 *
 * - 端末名は機種名と OS の名前・版から作り、サーバーの DEVICE_NAME_PATTERN に無い文字を除く。利用者が付けた名前 (Device.deviceName) は使わない
 * - 重ねよけは access token: 同じ token では 1 回だけ PATCH し、別の token (ログインし直し) ではもう一度送る
 * - 失敗しても例外を投げず、同じ token の次の呼び出しで送り直す。warn に token・端末名を出さない
 * モジュールの変数 (最後に送った token) を it ごとに読み直すため、jest.resetModules() のあとに require する。
 */

type DeviceMock = { modelName: string | null; osName: string | null; osVersion: string | null; deviceName: string | null };

const mockDevice: DeviceMock = { modelName: null, osName: null, osVersion: null, deviceName: null };
const mockPatch = jest.fn();

function setupMocks() {
  jest.doMock('expo-device', () => ({
    __esModule: true,
    get modelName() {
      return mockDevice.modelName;
    },
    get osName() {
      return mockDevice.osName;
    },
    get osVersion() {
      return mockDevice.osVersion;
    },
    get deviceName() {
      return mockDevice.deviceName;
    },
  }));
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
  jest.doMock('../../src/lib/sessions-api', () => ({
    patchCurrentDeviceName: (...args: unknown[]) => mockPatch(...args),
  }));
}

function loadModule(): typeof import('../../src/lib/device-name') {
  jest.resetModules();
  setupMocks();
  // it ごとにモジュールの変数 (最後に送った token) を読み直すため require する
  return require('../../src/lib/device-name');
}

let warnSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  mockPatch.mockReset();
  mockPatch.mockResolvedValue(undefined);
  Object.assign(mockDevice, { modelName: 'iPhone 15 Pro', osName: 'iOS', osVersion: '18.0', deviceName: null });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('deviceNameOf', () => {
  it('expo-device の modelName と OS の名前・版から 200 文字以内の端末名を作る (例 iPhone 15 Pro (iOS 18.0))', () => {
    const { deviceNameOf } = loadModule();
    expect(deviceNameOf()).toBe('iPhone 15 Pro (iOS 18.0)');

    mockDevice.modelName = 'A'.repeat(300);
    const long = deviceNameOf();
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.startsWith('AAAA')).toBe(true);
  });

  it('使えない文字 (日本語・’・: / @・改行) を除き、続く空白を 1 つに畳む。Device.deviceName (利用者が付けた名前) は使わない', () => {
    const { deviceNameOf } = loadModule();
    mockDevice.deviceName = '太郎の iPhone';
    mockDevice.modelName = 'Pixel’s 8:/@\n  Pro 日本';
    mockDevice.osName = 'Android';
    mockDevice.osVersion = '14';

    const name = deviceNameOf();
    expect(name).toBe('Pixels 8 Pro (Android 14)');
    expect(name).not.toContain('太郎');
    expect(name).toMatch(/^[A-Za-z0-9 ()._,+-]+$/);
  });

  it('modelName が null なら Platform.OS を使う', () => {
    const { deviceNameOf } = loadModule();
    mockDevice.modelName = null;
    expect(deviceNameOf()).toBe('ios (iOS 18.0)');

    mockDevice.osName = null;
    mockDevice.osVersion = null;
    expect(deviceNameOf()).toBe('ios');
  });
});

describe('registerDeviceName', () => {
  it('同じ access token では 1 回だけ PATCH する (同時に 2 回呼んでも 1 回)', async () => {
    const { registerDeviceName } = loadModule();
    await Promise.all([registerDeviceName('token-a'), registerDeviceName('token-a')]);
    await registerDeviceName('token-a');

    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch).toHaveBeenCalledWith('iPhone 15 Pro (iOS 18.0)');
  });

  it('別の access token (ログアウトしてログインし直した) ではもう一度 PATCH する', async () => {
    const { registerDeviceName } = loadModule();
    await registerDeviceName('token-a');
    await registerDeviceName('token-b');

    expect(mockPatch).toHaveBeenCalledTimes(2);
  });

  it('PATCH が失敗したら例外を投げず、同じ access token の次の呼び出しで送り直す', async () => {
    const { registerDeviceName } = loadModule();
    mockPatch.mockRejectedValueOnce(new Error('HTTP 400 Bad Request: {"code":"VALIDATION_ERROR"}'));

    await expect(registerDeviceName('token-a')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await registerDeviceName('token-a');
    expect(mockPatch).toHaveBeenCalledTimes(2);
  });

  it('warn に access token と端末名を出さない', async () => {
    const { registerDeviceName } = loadModule();
    mockPatch.mockRejectedValueOnce(new Error('failed'));

    await registerDeviceName('secret-access-token-value');

    const printed = JSON.stringify(warnSpy.mock.calls);
    expect(printed).toContain('[device-name]');
    expect(printed).not.toContain('secret-access-token-value');
    expect(printed).not.toContain('iPhone 15 Pro');
  });
});
