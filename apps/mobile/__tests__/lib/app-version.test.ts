/**
 * app-version.test.ts
 * アプリの版を Expo の設定 (app.json の expo.version) から取る (apps/mobile/src/lib/app-version.ts。#1660)
 *
 * 確かめること:
 *   - readExpoAppVersion: Constants.expoConfig.version をそのまま返す。無い・空・取得で例外なら null
 *   - getAnalyticsAppVersion: "x.y.z" ならその値。取れない・形が違う ("1.0" など) なら APP_VERSION_UNKNOWN (analytics の schema を満たす)
 *   - ハンズオンツアーの画面に app_version: '1.0.0' の直書きが残っていない
 *   - 画面と共通の部品 (src/handson-tour。useLeaveTour など) の analytics に app_version・platform の文字列の直書きが無い
 */
import fs from 'fs';
import path from 'path';

import { CommonPropertiesSchema } from '@homegohan/handson-tour-shared';

jest.mock('expo-constants', () => ({ __esModule: true, default: {} }));

import { APP_VERSION_UNKNOWN, getAnalyticsAppVersion, readExpoAppVersion } from '../../src/lib/app-version';

type ConstantsMock = { expoConfig?: unknown };

function constantsMock(): ConstantsMock {
  return jest.requireMock('expo-constants').default as ConstantsMock;
}

function setExpoConfig(expoConfig: unknown): void {
  constantsMock().expoConfig = expoConfig;
}

afterEach(() => {
  delete constantsMock().expoConfig;
});

describe('readExpoAppVersion', () => {
  it('Constants.expoConfig.version を返す', () => {
    setExpoConfig({ version: '2.3.4' });
    expect(readExpoAppVersion()).toBe('2.3.4');
  });

  it.each([
    ['expoConfig が無い', undefined],
    ['version が無い', {}],
    ['version が空', { version: '' }],
    ['version が文字列でない', { version: 1 }],
  ])('%s → null', (_label, expoConfig) => {
    setExpoConfig(expoConfig);
    expect(readExpoAppVersion()).toBeNull();
  });

  it('取得で例外が出ても投げずに null', () => {
    Object.defineProperty(constantsMock(), 'expoConfig', {
      configurable: true,
      get() {
        throw new Error('manifest unavailable');
      },
    });
    expect(readExpoAppVersion()).toBeNull();
  });
});

describe('getAnalyticsAppVersion', () => {
  it('"x.y.z" の版はそのまま (直書きの 1.0.0 ではなく設定の値)', () => {
    setExpoConfig({ version: '0.1.0' });
    expect(getAnalyticsAppVersion()).toBe('0.1.0');
    setExpoConfig({ version: '12.34.56' });
    expect(getAnalyticsAppVersion()).toBe('12.34.56');
  });

  it.each([
    ['取れない', undefined],
    ['"x.y" の形', { version: '1.0' }],
    ['接尾辞つき', { version: '1.0.0-beta' }],
  ])('%s → APP_VERSION_UNKNOWN', (_label, expoConfig) => {
    setExpoConfig(expoConfig);
    expect(getAnalyticsAppVersion()).toBe(APP_VERSION_UNKNOWN);
  });

  it('APP_VERSION_UNKNOWN も analytics の schema (app_version) を満たす', () => {
    expect(CommonPropertiesSchema.shape.app_version.safeParse(APP_VERSION_UNKNOWN).success).toBe(true);
  });
});

describe('ハンズオンツアーの画面に app_version の直書きが無い', () => {
  const TOUR_DIR = path.resolve(__dirname, '../../app/handson-tour');
  const files = fs.readdirSync(TOUR_DIR).filter((name) => name.endsWith('.tsx'));

  it('画面のファイルを集められている (集め方の番兵)', () => {
    expect(files).toEqual(expect.arrayContaining(['index.tsx', 'photo.tsx', 'menu.tsx', 'badges.tsx', 'graduate.tsx']));
  });

  it.each(files)('%s: app_version は getAnalyticsAppVersion() から取る', (name) => {
    const source = fs.readFileSync(path.join(TOUR_DIR, name), 'utf8');
    expect(source).not.toMatch(/app_version:\s*['"`]/);
  });
});

/** コメント (行コメント・ブロックコメント) を除いたソース。コメントの中の説明 (「以前は platform: 'ios' を…」など) を拾わないため */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ツアーの analytics を送る共通の部品 (src/handson-tour)。#1642 の useLeaveTour (handson_tour_skipped) と、
// #1660 の画面の記録 (menu.tsx の reportMenuTourProfileFailure など) が合わさったときに直書きが戻らないことを確かめる (#1642 の取り込みで '1.0.0' / 'ios' が残った実例がある)
describe('ハンズオンツアーの analytics の共通の項目に直書きが無い (画面と共通の部品)', () => {
  const TOUR_DIR = path.resolve(__dirname, '../../app/handson-tour');
  const SHARED_DIR = path.resolve(__dirname, '../../src/handson-tour');
  const sources = [
    ...fs
      .readdirSync(TOUR_DIR)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => path.join(TOUR_DIR, name)),
    ...fs
      .readdirSync(SHARED_DIR)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => path.join(SHARED_DIR, name)),
  ];
  const relative = (file: string) => path.relative(path.resolve(__dirname, '../..'), file);

  it('共通の部品 (useLeaveTour.ts) も集められている (集め方の番兵)', () => {
    expect(sources.map(relative)).toEqual(
      expect.arrayContaining(['src/handson-tour/useLeaveTour.ts', 'app/handson-tour/menu.tsx']),
    );
  });

  it.each(sources.map((file) => [relative(file), file]))(
    '%s: app_version も platform も文字列の直書きにしない',
    (_name, file) => {
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      expect(source).not.toMatch(/app_version:\s*['"`]/);
      expect(source).not.toMatch(/platform:\s*['"`]/);
    },
  );
});
