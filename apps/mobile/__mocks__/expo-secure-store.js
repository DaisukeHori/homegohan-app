/**
 * expo-secure-store Jest モック (メモリ上の Map)
 *
 * 本物はネイティブモジュール (Keychain / Keystore) に依存するため、Jest ではこのスタブに差し替える。
 * apps/mobile/__mocks__ にあるので、jest.mock() を書かなくても自動で使われる。
 *
 * - jest.fn ではなく素の関数にしている: jest.resetAllMocks() で実装が消えてしまうのを避けるため。
 *   呼び出しを検査したいテストは jest.spyOn(SecureStore, 'setItemAsync') を使う
 * - 本物と同じく、キーは英数字と . - _ だけ、値は文字列だけを受け付ける
 *   (チャンク分けしたキー名が規則に合っているかをテストで確かめられる)
 * - テストの間で状態を持ち越さないよう、__reset() で空にできる
 */
const store = new Map();
/**
 * 次の呼び出しから失敗させる操作 (メソッド名 → 投げる Error)。__failWith で置き、__reset で消す。
 * jest.spyOn(SecureStore, ...) は、テストの側の import の写しにしか効かないことがある (babel の import の写し) ので、
 * 保管庫を読めない端末 (iOS で一度もロックを解除していない起動など) を真似るテストはこちらを使う
 */
const failures = new Map();

function failIfRequested(method) {
  const error = failures.get(method);
  if (error) throw error;
}

function ensureValidKey(key) {
  if (typeof key !== 'string' || !/^[\w.-]+$/.test(key)) {
    throw new Error(
      'Invalid key provided to SecureStore. Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".'
    );
  }
}

module.exports = {
  AFTER_FIRST_UNLOCK: 0,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  ALWAYS: 2,
  ALWAYS_THIS_DEVICE_ONLY: 3,
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 4,
  WHEN_UNLOCKED: 5,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,

  async isAvailableAsync() {
    return true;
  },
  async getItemAsync(key) {
    failIfRequested('getItemAsync');
    ensureValidKey(key);
    return store.has(key) ? store.get(key) : null;
  },
  async setItemAsync(key, value) {
    failIfRequested('setItemAsync');
    ensureValidKey(key);
    if (typeof value !== 'string') {
      throw new Error('Invalid value provided to SecureStore. Values must be strings.');
    }
    store.set(key, value);
  },
  async deleteItemAsync(key) {
    failIfRequested('deleteItemAsync');
    ensureValidKey(key);
    store.delete(key);
  },

  // テスト用
  __store: store,
  __reset() {
    store.clear();
    failures.clear();
  },
  /** method を、__reset まで error で失敗させる */
  __failWith(method, error) {
    failures.set(method, error);
  },
};
