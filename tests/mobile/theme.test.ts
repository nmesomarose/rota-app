import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Automatic System-Controlled Light/Dark Mode Regression Suite', () => {
  const rootDir = process.cwd();
  const mobileDir = path.resolve(rootDir, 'mobile');

  it('1. Expo configuration (app.json) specifies userInterfaceStyle: automatic for iOS and Android', () => {
    const appJsonPath = path.resolve(mobileDir, 'app.json');
    assert.ok(fs.existsSync(appJsonPath), 'mobile/app.json must exist');

    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    assert.strictEqual(
      appJson.expo?.userInterfaceStyle,
      'automatic',
      'expo.userInterfaceStyle must be set to "automatic" to support system appearance changes on iOS and Android'
    );
  });

  it('2. Theme tokens export lightColors and darkColors with 100% token key parity', () => {
    const tokensPath = path.resolve(mobileDir, 'src/theme/tokens.ts');
    assert.ok(fs.existsSync(tokensPath), 'tokens.ts must exist');

    const tokensContent = fs.readFileSync(tokensPath, 'utf8');
    assert.ok(tokensContent.includes('export const lightColors'), 'tokens.ts must export lightColors');
    assert.ok(tokensContent.includes('export const darkColors'), 'tokens.ts must export darkColors');
    assert.ok(tokensContent.includes('export const colors'), 'tokens.ts must export colors proxy fallback');

    // Extract keys from lightColors and darkColors
    const extractKeys = (blockName: string): string[] => {
      const match = tokensContent.match(new RegExp(`export const ${blockName}[^{]*\\{([\\s\\S]*?)\\n\\};`));
      assert.ok(match, `Could not find definition for ${blockName}`);
      return Array.from(match[1].matchAll(/^\s+([a-zA-Z0-9_]+):/gm), (m) => m[1]).sort();
    };

    const lightKeys = extractKeys('lightColors');
    const darkKeys = extractKeys('darkColors');

    assert.ok(lightKeys.length >= 25, 'lightColors must define at least 25 tokens');
    assert.deepStrictEqual(
      darkKeys,
      lightKeys,
      'darkColors must have exact 1:1 token key parity with lightColors'
    );

    // Verify brand tokens
    assert.ok(tokensContent.includes("primaryNavy: '#17324D'"), 'Light primaryNavy must preserve brand Navy #17324D');
    assert.ok(tokensContent.includes("primaryTeal: '#0F766E'"), 'Light primaryTeal must preserve brand Teal #0F766E');
    assert.ok(tokensContent.includes("background: '#0B132B'"), 'Dark background must be deep Navy-Slate #0B132B');
    assert.ok(tokensContent.includes("surface: '#1E293B'"), 'Dark surface must be Slate 800 #1E293B');
    assert.ok(tokensContent.includes("primaryTeal: '#14B8A6'"), 'Dark primaryTeal must provide high-contrast Teal #14B8A6');
  });

  it('3. ThemeContext provides ThemeProvider and live useTheme hook', () => {
    const contextPath = path.resolve(mobileDir, 'src/theme/ThemeContext.tsx');
    assert.ok(fs.existsSync(contextPath), 'ThemeContext.tsx must exist');

    const content = fs.readFileSync(contextPath, 'utf8');
    assert.ok(content.includes('export function ThemeProvider'), 'Must export ThemeProvider');
    assert.ok(content.includes('export function useTheme'), 'Must export useTheme');
    assert.ok(content.includes('useColorScheme'), 'Must listen to React Native useColorScheme');
    assert.ok(content.includes('Appearance.addChangeListener'), 'Must listen to live Appearance changes');
  });

  it('4. App.tsx wires ThemeProvider, dynamic NavigationContainer themes, and dynamic StatusBar', () => {
    const appPath = path.resolve(mobileDir, 'App.tsx');
    const content = fs.readFileSync(appPath, 'utf8');

    assert.ok(content.includes('<ThemeProvider>'), 'App.tsx must wrap tree in ThemeProvider');
    assert.ok(content.includes('RotaLightTheme'), 'App.tsx must define RotaLightTheme');
    assert.ok(content.includes('RotaDarkTheme'), 'App.tsx must define RotaDarkTheme');
    assert.ok(
      content.includes('theme={isDark ? RotaDarkTheme : RotaLightTheme}'),
      'NavigationContainer must dynamically select RotaDarkTheme or RotaLightTheme'
    );
    assert.ok(
      content.includes("style={isDark ? 'light' : 'dark'}"),
      'Root StatusBar style must dynamically switch based on isDark'
    );
  });

  it('5. SettingsScreen removes manual Light/Dark/System selector and does not override system appearance', () => {
    const settingsPath = path.resolve(mobileDir, 'src/screens/SettingsScreen.tsx');
    const content = fs.readFileSync(settingsPath, 'utf8');

    // Verify selector UI elements are removed
    assert.doesNotMatch(
      content,
      /theme-selector|theme-option|testID=["']theme-option/i,
      'SettingsScreen must not render manual theme selector testIDs'
    );
    assert.doesNotMatch(
      content,
      /<TouchableOpacity[^>]*>\s*<Text[^>]*>(?:Light|Dark|System)<\/Text>\s*<\/TouchableOpacity>/i,
      'Manual theme selection pills must be removed from SettingsScreen'
    );

    // Verify Appearance Info is displayed instead
    assert.ok(
      content.includes('System default') || content.includes('Appearance: System controlled'),
      'SettingsScreen must display notice that Appearance automatically follows system appearance'
    );

    // Verify theme hook usage
    assert.ok(content.includes('useTheme()'), 'SettingsScreen must consume useTheme()');
  });

  it('6. Core reusable components adapt dynamically via useTheme()', () => {
    const componentsPath = path.resolve(mobileDir, 'src/theme/components.tsx');
    const content = fs.readFileSync(componentsPath, 'utf8');

    assert.ok(content.includes('useTheme()'), 'Theme components must consume useTheme()');
    assert.ok(content.includes('export function Button'), 'Must export dynamic Button');
    assert.ok(content.includes('export function Card'), 'Must export dynamic Card');
    assert.ok(content.includes('export function Badge'), 'Must export dynamic Badge');
    assert.ok(content.includes('export function InputField'), 'Must export dynamic InputField');
  });

  it('7. Navigation components (RootNavigator, HamburgerDrawer) adapt dynamically via useTheme()', () => {
    const rootNavPath = path.resolve(mobileDir, 'src/navigation/RootNavigator.tsx');
    const rootNavContent = fs.readFileSync(rootNavPath, 'utf8');
    assert.ok(rootNavContent.includes('useTheme()'), 'RootNavigator must consume useTheme()');
    assert.ok(rootNavContent.includes('headerStyle:'), 'RootNavigator must set headerStyle dynamically');

    const drawerPath = path.resolve(mobileDir, 'src/navigation/HamburgerDrawer.tsx');
    const drawerContent = fs.readFileSync(drawerPath, 'utf8');
    assert.ok(drawerContent.includes('useTheme()'), 'HamburgerDrawer must consume useTheme()');
  });

  it('8. All application screens consume useTheme() and createStyles()', () => {
    const screens = [
      'LoginScreen.tsx',
      'ForgotPasswordScreen.tsx',
      'ResetPasswordScreen.tsx',
      'BusinessSelectScreen.tsx',
      'ScheduleScreen.tsx',
      'FeedScreen.tsx',
      'TeamScreen.tsx',
      'BillingScreen.tsx',
      'SettingsScreen.tsx',
    ];

    for (const screen of screens) {
      const screenPath = path.resolve(mobileDir, 'src/screens', screen);
      assert.ok(fs.existsSync(screenPath), `${screen} must exist`);
      const content = fs.readFileSync(screenPath, 'utf8');

      assert.ok(
        content.includes('useTheme()'),
        `${screen} must consume useTheme() for automatic appearance response`
      );
      assert.ok(
        content.includes('createStyles'),
        `${screen} must use createStyles(colors, isDark) to re-render styles on appearance change`
      );

      // Verify no hardcoded static <StatusBar style="dark" /> remains
      assert.doesNotMatch(
        content,
        /<StatusBar\s+style="dark"\s*\/>/,
        `${screen} must not have hardcoded static <StatusBar style="dark" />`
      );
    }
  });
});
