/**
 * new-ai-usage-grant.test.tsx
 * #1149 (T40) の是正: 写真の「オート」は 1 回の操作を 1 回と数える (モバイルの食事の新規作成 app/meals/new.tsx)
 *
 * 判別 (POST /api/ai/classify-photo) は、数えたあとに「数え済みの印」(aiUsageGrant) を応答で返す。画面は続く解析
 * (analyze-meal-photo / analyze-fridge / analyze-health-checkup / analyze-weight-scale) の本文の aiUsageGrant に入れて送り、
 * サーバーはその解析を数えない (印の確かめと 1 回だけ使えることはサーバーの仕事。tests/ai-usage-photo-auto-grant.test.ts)。
 *   - オートで判別できた: 続く解析の本文に、判別が返した印をそのまま入れる
 *   - オートで判別できず、種類を手で選んだ: その解析にも判別の印を入れる (判別の続き)
 *   - 種類を最初から選んだ (判別しない): 印を入れない (サーバーが数える)
 *   - 新しい操作 (もう一度「解析」を押す) では、前の判別の印を使わない
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: jest.fn(() => ({})),
  useNavigation: jest.fn(() => ({ isFocused: () => true })),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({ canceled: false, assets: [{ uri: 'file://test/photo.jpg' }] }),
  launchCameraAsync: jest.fn().mockResolvedValue({ canceled: false, assets: [{ uri: 'file://test/camera.jpg' }] }),
}));

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({ uri: 'file://test/resized.jpg', base64: 'base64encodedimage' }),
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost, del: jest.fn(), patch: jest.fn() }),
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) }, from: jest.fn() },
}));

import MealNewPage from '../../app/meals/new';

/** 判別が返す数え済みの印 (中身はサーバーが確かめる。画面はそのまま送るだけ) */
const GRANT = 'g1.1760000000.0f8fad5b-d9cb-469f-a165-70867728950e.' + 'a'.repeat(64);
/** 判別の確からしさ (画面が判別できたとみなす値より上 / 下) */
const CONFIDENT = 0.9;
const UNSURE = 0.3;

const ANALYZE_PATHS = {
  meal: '/api/ai/analyze-meal-photo',
  fridge: '/api/ai/analyze-fridge',
  health_checkup: '/api/ai/analyze-health-checkup',
  weight_scale: '/api/ai/analyze-weight-scale',
} as const;
type Kind = keyof typeof ANALYZE_PATHS;

/** 解析の API の応答 (どの種類でも結果の画面へ進める形) */
const ANALYZE_RESPONSE = { dishes: [{ name: 'カレー' }], detailedIngredients: [], extractedData: { weight: 60 }, weight: 60 };

function postsTo(path: string): Array<Record<string, unknown>> {
  return mockPost.mock.calls.filter((call) => call[0] === path).map((call) => call[1] as Record<string, unknown>);
}

async function choosePhotoAndAnalyze(mode: 'auto' | Kind) {
  fireEvent.press(screen.getByTestId(`meal-mode-${mode.replace(/_/g, '-')}`));
  fireEvent.press(screen.getByText('撮影へ進む'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('camera-gallery-button'));
  });
  await waitFor(() => expect(screen.getByText('選択した写真 (1枚)')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByText(mode === 'auto' ? 'AIが判別して解析' : 'AIで解析する'));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ products: [] });
});

describe('写真の「オート」: 判別の数え済みの印を、続く解析に 1 回だけ付ける (#1149)', () => {
  it.each(Object.keys(ANALYZE_PATHS) as Kind[])('判別できた (%s): 続く解析の本文の aiUsageGrant に、判別が返した印を入れる', async (kind) => {
    const mealAnalysis = { dishes: [{ name: 'カレー', role: 'main' }] };
    mockPost.mockImplementation(async (path: string) => {
      if (path === '/api/ai/classify-photo') return { type: kind, confidence: CONFIDENT, candidates: [], mealAnalysis, aiUsageGrant: GRANT };
      return ANALYZE_RESPONSE;
    });
    render(<MealNewPage />);
    await choosePhotoAndAnalyze('auto');

    await waitFor(() => expect(postsTo(ANALYZE_PATHS[kind])).toHaveLength(1));
    expect(postsTo(ANALYZE_PATHS[kind])[0].aiUsageGrant).toBe(GRANT);
    if (kind === 'meal') expect(postsTo(ANALYZE_PATHS.meal)[0].prefetchedGeminiResult).toEqual(mealAnalysis);
  });

  it('判別できず、種類を手で選んだ: その解析にも判別の印を入れる (判別の続き)', async () => {
    mockPost.mockImplementation(async (path: string) => {
      if (path === '/api/ai/classify-photo') return { type: 'unknown', confidence: UNSURE, candidates: [], aiUsageGrant: GRANT };
      return ANALYZE_RESPONSE;
    });
    render(<MealNewPage />);
    await choosePhotoAndAnalyze('auto');
    await waitFor(() => expect(screen.getByTestId('meal-classify-failed-view')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByText('冷蔵庫として続ける'));
    });
    await waitFor(() => expect(postsTo(ANALYZE_PATHS.fridge)).toHaveLength(1));
    expect(postsTo(ANALYZE_PATHS.fridge)[0].aiUsageGrant).toBe(GRANT);
  });

  it('判別が印を返さなかった (数えていない): 解析に印を入れない', async () => {
    mockPost.mockImplementation(async (path: string) => {
      if (path === '/api/ai/classify-photo') return { type: 'fridge', confidence: CONFIDENT, candidates: [] };
      return ANALYZE_RESPONSE;
    });
    render(<MealNewPage />);
    await choosePhotoAndAnalyze('auto');
    await waitFor(() => expect(postsTo(ANALYZE_PATHS.fridge)).toHaveLength(1));
    expect(postsTo(ANALYZE_PATHS.fridge)[0].aiUsageGrant).toBeUndefined();
  });

  it.each(Object.keys(ANALYZE_PATHS) as Kind[])('種類を最初から選んだ (%s。判別しない): 解析に印を入れない', async (kind) => {
    mockPost.mockResolvedValue(ANALYZE_RESPONSE);
    render(<MealNewPage />);
    await choosePhotoAndAnalyze(kind);
    await waitFor(() => expect(postsTo(ANALYZE_PATHS[kind])).toHaveLength(1));
    expect(postsTo(ANALYZE_PATHS[kind])[0].aiUsageGrant).toBeUndefined();
    expect(postsTo('/api/ai/classify-photo')).toHaveLength(0);
  });

  it('印は 1 回だけ付ける: 判別できずに種類を選んだ解析が失敗したあと、もう一度押した解析には印を付けない', async () => {
    mockPost.mockImplementation(async (path: string) => {
      if (path === '/api/ai/classify-photo') return { type: 'unknown', confidence: UNSURE, candidates: [], aiUsageGrant: GRANT };
      if (path === ANALYZE_PATHS.fridge) throw new Error('HTTP 500 Internal Server Error: {}');
      return ANALYZE_RESPONSE;
    });
    render(<MealNewPage />);
    await choosePhotoAndAnalyze('auto');
    await waitFor(() => expect(screen.getByTestId('meal-classify-failed-view')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByText('冷蔵庫として続ける'));
    });
    await waitFor(() => expect(postsTo(ANALYZE_PATHS.fridge)).toHaveLength(1));
    expect(postsTo(ANALYZE_PATHS.fridge)[0].aiUsageGrant).toBe(GRANT);

    // 解析に失敗して撮影の画面へ戻った (種類は冷蔵庫のまま)。もう一度押した解析は新しい操作なので、使った印を付けない (サーバーが数える)
    await waitFor(() => expect(screen.getByTestId('camera-screen')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByText('AIで解析する'));
    });
    await waitFor(() => expect(postsTo(ANALYZE_PATHS.fridge)).toHaveLength(2));
    expect(postsTo(ANALYZE_PATHS.fridge)[1].aiUsageGrant).toBeUndefined();
  });
});
