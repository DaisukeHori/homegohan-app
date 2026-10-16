/**
 * font-family-guard.test.ts — モバイルの文字を Noto Sans JP にそろえる (#588) の見張り
 *
 *  1. app/ と src/ の画面は、react-native の Text / TextInput を直接使わない (src/components/ui/Text.tsx を使う)。
 *     直接使うと、その文字だけ fontWeight のまま (Android では太字の字形にならない)・システムの字形で描かれるため。
 *  2. 字形のファイルは、字形ごとの入口 (@expo-google-fonts/noto-sans-jp/400Regular など) から読む。
 *     パッケージの入口から読むと、使わない 6 つの字形 (1 つ約 5.7 MB) もアプリと OTA の更新に入るため。
 *  3. 字形はネイティブに埋め込まない (app.json に expo-font のプラグインを置かない)。OTA の更新で届けるため。
 *  4. ライブラリが中で Text を描く style (tabBarLabelStyle など) に、fontWeight を直に書かない (useFontStyle を通す)。
 *  5. app/ の navigator (Stack / Tabs) は、ライブラリが描く文字の style を必ず渡し、その値は useFontStyle / useFontFaceStyle で作る:
 *     ヘッダを出す (headerShown: false でない) なら headerTitleStyle と headerBackTitleStyle、Tabs なら tabBarLabelStyle。
 *     渡さないと、その文字だけシステムの字形で描かれるため。値が字形に置き換わることは __tests__/app/navigator-font-styles.test.tsx が描いて確かめる。
 *
 * 拾い方が壊れて 0 件で通らないよう、それぞれ「拾えるはずのもの」(ui/Text.tsx 自身の import など) が拾えることも見る。
 */

import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const SOURCE_DIRS = [path.join(MOBILE_ROOT, 'app'), path.join(MOBILE_ROOT, 'src')];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const TEXT_COMPONENT_FILE = path.join(MOBILE_ROOT, 'src/components/ui/Text.tsx');
const FONT_SOURCES_FILE = path.join(MOBILE_ROOT, 'src/theme/fontSources.ts');

const FONT_PACKAGE = '@expo-google-fonts/noto-sans-jp';
/** 読み込む字形 (src/theme/fonts.ts の fontFamilies と同じ 3 つ) */
const FONT_SUBPATHS = ['400Regular', '500Medium', '700Bold'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/** 型だけでない (import type でない) react-native からの import の、名前の一覧 */
function valueImportsFromReactNative(source: string): string[] {
  const names: string[] = [];
  const pattern = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]react-native['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) continue;
    for (const raw of match[2].split(',')) {
      const name = raw.trim();
      if (!name || name.startsWith('type ')) continue;
      // `Text as RNText` は元の名前 (Text) で数える
      names.push(name.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

/** react-native の Text / TextInput を直接読んでいる箇所 (require・名前空間の import を含む) */
function directTextUses(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const hits: string[] = valueImportsFromReactNative(source).filter((name) => name === 'Text' || name === 'TextInput');
  if (/require\(\s*['"]react-native['"]\s*\)\.(Text|TextInput)\b/.test(source)) hits.push('require');
  if (/import\s+\*\s+as\s+\w+\s+from\s+['"]react-native['"]/.test(source)) hits.push('namespace');
  return hits.map((hit) => `${path.relative(MOBILE_ROOT, file)}: ${hit}`);
}

const SOURCE_FILES = SOURCE_DIRS.flatMap((dir) => walk(dir));

describe('react-native の Text / TextInput を直接使わない (#588)', () => {
  it('拾い方の確認: 共通の部品 (ui/Text.tsx) 自身の import は拾える', () => {
    expect(directTextUses(TEXT_COMPONENT_FILE)).toEqual([
      'src/components/ui/Text.tsx: Text',
      'src/components/ui/Text.tsx: TextInput',
    ]);
  });

  it('app/ と src/ のほかのファイルは、src/components/ui/Text.tsx の Text / TextInput を使う', () => {
    const offenders = SOURCE_FILES.filter((file) => file !== TEXT_COMPONENT_FILE).flatMap(directTextUses);
    expect(offenders).toEqual([]);
  });
});

describe('字形のファイルの読み方 (#588)', () => {
  it('パッケージの入口からは読まない (使わない字形をアプリに入れない)', () => {
    const rootImport = new RegExp(`['"]${FONT_PACKAGE.replace('/', '\\/')}['"]`);
    const offenders = SOURCE_FILES.filter((file) => rootImport.test(fs.readFileSync(file, 'utf8'))).map((file) =>
      path.relative(MOBILE_ROOT, file),
    );
    expect(offenders).toEqual([]);
  });

  it('拾い方の確認: src/theme/fontSources.ts は Regular / Medium / Bold の入口から読む', () => {
    const source = fs.readFileSync(FONT_SOURCES_FILE, 'utf8');
    const subpaths = [...source.matchAll(new RegExp(`from '${FONT_PACKAGE}/(\\w+)'`, 'g'))].map((match) => match[1]);
    expect(subpaths).toEqual(FONT_SUBPATHS);
  });

  it('ほかのファイルは字形のファイルを読まない (読むのは src/theme/fontSources.ts だけ)', () => {
    const offenders = SOURCE_FILES.filter(
      (file) => file !== FONT_SOURCES_FILE && fs.readFileSync(file, 'utf8').includes(FONT_PACKAGE),
    ).map((file) => path.relative(MOBILE_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('ネイティブに埋め込まない: app.json に expo-font のプラグインが無い (OTA の更新で届ける)', () => {
    const appJson = JSON.parse(fs.readFileSync(path.join(MOBILE_ROOT, 'app.json'), 'utf8')) as {
      expo: { plugins?: Array<string | [string, unknown]> };
    };
    const pluginNames = (appJson.expo.plugins ?? []).map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
    expect(pluginNames.length).toBeGreaterThan(0);
    expect(pluginNames).not.toContain('expo-font');
  });
});

describe('ライブラリが中で Text を描く style (#588)', () => {
  /** react-navigation の見出しなどの style の props (〜LabelStyle・〜TitleStyle) に、オブジェクトを直に書いて fontWeight を入れている */
  const RAW_LIBRARY_TEXT_STYLE = /\w+(?:Label|Title)Style\s*:\s*\{[^}]*fontWeight/;

  it('拾い方の確認: 直に書いた形は拾える', () => {
    expect(RAW_LIBRARY_TEXT_STYLE.test('tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },')).toBe(true);
    expect(RAW_LIBRARY_TEXT_STYLE.test('tabBarLabelStyle,')).toBe(false);
  });

  it('fontWeight を直に書かず、useFontStyle で字形に置き換えて渡す', () => {
    const offenders = SOURCE_FILES.flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => RAW_LIBRARY_TEXT_STYLE.test(line))
        .map(({ line, index }) => `${path.relative(MOBILE_ROOT, file)}:${index + 1}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('navigator (Stack / Tabs) がライブラリの描く文字に字形を渡す (#588)', () => {
  const APP_DIR = path.join(MOBILE_ROOT, 'app');
  const LAYOUT_FILES = walk(APP_DIR).filter((file) => path.basename(file) === '_layout.tsx');

  interface NavigatorUse {
    navigator: 'Stack' | 'Tabs';
    /** screenOptions={...} の {...} の中身。screenOptions が無ければ null */
    options: string | null;
  }

  /** JSX の <Stack ...> / <Tabs ...> (Stack.Screen などは除く) と、その screenOptions の中身 */
  function navigatorUses(source: string): NavigatorUse[] {
    const uses: NavigatorUse[] = [];
    for (const match of source.matchAll(/<(Stack|Tabs)\b(?!\.)/g)) {
      const start = (match.index ?? 0) + match[0].length;
      let depth = 0;
      let end = start;
      // タグの終わり (波括弧の外の '>') まで
      while (end < source.length && !(depth === 0 && source[end] === '>')) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}') depth -= 1;
        end += 1;
      }
      const tag = source.slice(start, end);
      const optionsAt = tag.indexOf('screenOptions={');
      let options: string | null = null;
      if (optionsAt >= 0) {
        const open = optionsAt + 'screenOptions='.length;
        let level = 0;
        let close = open;
        do {
          if (tag[close] === '{') level += 1;
          else if (tag[close] === '}') level -= 1;
          close += 1;
        } while (level > 0 && close < tag.length);
        options = tag.slice(open + 1, close - 1);
      }
      uses.push({ navigator: match[1] as NavigatorUse['navigator'], options });
    }
    return uses;
  }

  /** そのファイルで、key の値が useFontStyle / useFontFaceStyle で作った変数として渡されているか */
  function passesFontHookValue(source: string, options: string, key: string): boolean {
    const value = options.match(new RegExp(`\\b${key}\\b\\s*(:\\s*([A-Za-z_$][\\w$]*))?\\s*(?=[,}\\s]|$)`));
    if (!value) return false;
    const variable = value[2] ?? key;
    return new RegExp(`const\\s+${variable}\\s*=\\s*useFont(?:Face)?Style\\(`).test(source);
  }

  /** ライブラリが描く文字の style のうち、渡していない・useFontStyle / useFontFaceStyle を通していないもの */
  function missingFontStylesOf(source: string): string[] {
    return navigatorUses(source).flatMap(({ navigator, options }) => {
      const keys: string[] = [];
      const headerShown = options === null || !/\bheaderShown\s*:\s*false\b/.test(options);
      if (headerShown) keys.push('headerTitleStyle', 'headerBackTitleStyle');
      if (navigator === 'Tabs') keys.push('tabBarLabelStyle');
      return keys
        .filter((key) => options === null || !passesFontHookValue(source, options, key))
        .map((key) => `<${navigator}> ${key}`);
    });
  }

  function missingFontStyles(file: string): string[] {
    return missingFontStylesOf(fs.readFileSync(file, 'utf8')).map((hit) => `${path.relative(MOBILE_ROOT, file)}: ${hit}`);
  }

  it('拾い方の確認: 全ての _layout.tsx の navigator を拾い、ヘッダを出す区画とタブを見分ける', () => {
    const found = LAYOUT_FILES.flatMap((file) =>
      navigatorUses(fs.readFileSync(file, 'utf8')).map(({ navigator, options }) => ({
        file: path.relative(MOBILE_ROOT, file),
        navigator,
        headerShown: options === null || !/\bheaderShown\s*:\s*false\b/.test(options),
      })),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        { file: 'app/(public)/_layout.tsx', navigator: 'Stack', headerShown: true },
        { file: 'app/(tabs)/_layout.tsx', navigator: 'Tabs', headerShown: false },
        { file: 'app/_layout.tsx', navigator: 'Stack', headerShown: false },
      ]),
    );
  });

  it('拾い方の確認: 渡していない・字形に置き換えずに渡した形は拾える', () => {
    const plain = 'export default () => <Stack screenOptions={{ headerShown: true }} />;';
    expect(navigatorUses(plain)).toEqual([{ navigator: 'Stack', options: '{ headerShown: true }' }]);
    expect(missingFontStylesOf(plain)).toEqual(['<Stack> headerTitleStyle', '<Stack> headerBackTitleStyle']);
    const constOnly =
      'const TAB = { fontWeight: "600" } as const;\n<Tabs screenOptions={{ headerShown: false, tabBarLabelStyle: TAB }}>';
    expect(passesFontHookValue(constOnly, navigatorUses(constOnly)[0].options ?? '', 'tabBarLabelStyle')).toBe(false);
    const hooked =
      'const tabBarLabelStyle = useFontStyle(TAB);\n<Tabs screenOptions={{ headerShown: false, tabBarLabelStyle }}>';
    expect(passesFontHookValue(hooked, navigatorUses(hooked)[0].options ?? '', 'tabBarLabelStyle')).toBe(true);
  });

  it('ヘッダを出す区画は headerTitleStyle / headerBackTitleStyle を、Tabs は tabBarLabelStyle を字形に置き換えて渡す', () => {
    expect(LAYOUT_FILES.flatMap(missingFontStyles)).toEqual([]);
  });
});
