/**
 * react-native-purchases (RevenueCat) の Jest モック (billing/03 §8.10)
 *
 * SDK はネイティブモジュール (RNPurchases) を必要とし、本物のストア・RevenueCat に通信するため、Jest 環境では
 * このスタブに差し替える (jest.config.js の moduleNameMapper)。各関数は jest.fn() で、テストが戻り値を決める。
 * INTRO_ELIGIBILITY_STATUS の値は SDK の enum と同じ数 (0〜3)。
 */
const Purchases = {
  configure: jest.fn(),
  setLogLevel: jest.fn(() => Promise.resolve()),
  logIn: jest.fn(() => Promise.resolve({ customerInfo: {}, created: false })),
  logOut: jest.fn(() => Promise.resolve({})),
  isAnonymous: jest.fn(() => Promise.resolve(false)),
  getOfferings: jest.fn(() => Promise.resolve({ all: {}, current: null })),
  purchasePackage: jest.fn(),
  restorePurchases: jest.fn(() => Promise.resolve({})),
  getCustomerInfo: jest.fn(() => Promise.resolve({ managementURL: null })),
  checkTrialOrIntroductoryPriceEligibility: jest.fn(() => Promise.resolve({})),
};

const LOG_LEVEL = {
  VERBOSE: 'VERBOSE',
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

const PURCHASES_ERROR_CODE = {
  UNKNOWN_ERROR: '0',
  PURCHASE_CANCELLED_ERROR: '1',
  STORE_PROBLEM_ERROR: '2',
  PURCHASE_NOT_ALLOWED_ERROR: '3',
  PURCHASE_INVALID_ERROR: '4',
  PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR: '5',
  PRODUCT_ALREADY_PURCHASED_ERROR: '6',
  RECEIPT_ALREADY_IN_USE_ERROR: '7',
  INVALID_RECEIPT_ERROR: '8',
  MISSING_RECEIPT_FILE_ERROR: '9',
  NETWORK_ERROR: '10',
  INVALID_CREDENTIALS_ERROR: '11',
  UNEXPECTED_BACKEND_RESPONSE_ERROR: '12',
  INVALID_APP_USER_ID_ERROR: '14',
  OPERATION_ALREADY_IN_PROGRESS_ERROR: '15',
  UNKNOWN_BACKEND_ERROR: '16',
};

const INTRO_ELIGIBILITY_STATUS = {
  INTRO_ELIGIBILITY_STATUS_UNKNOWN: 0,
  INTRO_ELIGIBILITY_STATUS_INELIGIBLE: 1,
  INTRO_ELIGIBILITY_STATUS_ELIGIBLE: 2,
  INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS: 3,
};

module.exports = {
  __esModule: true,
  default: Purchases,
  LOG_LEVEL,
  PURCHASES_ERROR_CODE,
  INTRO_ELIGIBILITY_STATUS,
};
