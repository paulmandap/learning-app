import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_MARK, isWindowsApp } from '../src/core/windows-app';
import { reminderSupport } from '../src/data/reminders';

/**
 * Nomi for Windows (NOTES §73): a Tauri window that shows the live site, built
 * by .github/workflows/windows-app.yml because the owner's PC has no Rust.
 * Nothing here can compile it. These hold the parts that must agree with each
 * other, and the rules that keep the site from reaching into the computer.
 */

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8').replace(/\r\n/g, '\n');

const main = read('src-tauri', 'src', 'main.rs');
const cargo = read('src-tauri', 'Cargo.toml');
const workflow = read('.github', 'workflows', 'windows-app.yml');
const config = JSON.parse(read('src-tauri', 'tauri.conf.json')) as {
  version: string;
  identifier: string;
  app: { windows: unknown[]; withGlobalTauri?: boolean; security?: { capabilities?: unknown } };
  bundle: { targets: string[]; icon: string[] };
};

/** A `const NAME: &str = "…";` from main.rs. None of them holds an escape. */
function rustConst(name: string): string {
  const found = new RegExp(`const ${name}: &str = "([^"]*)";`).exec(main);
  if (!found) throw new Error(`main.rs has no const ${name}`);
  return found[1]!;
}

/** Runs main.rs's MARK on a stand-in for the page, as WebView2 would before the site's code. */
function markPage(origin: string): Record<string, unknown> {
  const page: Record<string, unknown> = { location: { origin } };
  new Function('window', rustConst('MARK'))(page);
  return page;
}

describe('the mark the window leaves', () => {
  it('is read as the Windows app only when it says so', () => {
    expect(isWindowsApp({ [APP_MARK]: { platform: 'windows' } })).toBe(true);
    expect(isWindowsApp({})).toBe(false);
    expect(isWindowsApp(null)).toBe(false);
    expect(isWindowsApp(undefined)).toBe(false);
    expect(isWindowsApp({ [APP_MARK]: true })).toBe(false);
    expect(isWindowsApp({ [APP_MARK]: { platform: 'android' } })).toBe(false);
  });

  it("is what main.rs writes, and only on Nomi's own site", () => {
    const site = new URL(rustConst('SITE')).origin;
    expect(isWindowsApp(markPage(site))).toBe(true);
    // Any other page the window might show is not told it is Nomi.
    expect(isWindowsApp(markPage('https://example.com'))).toBe(false);
  });

  it('is put on the site deploy-status reads as live', () => {
    const live = /const LIVE_URL = '([^']+)'/.exec(read('scripts', 'deploy-status.ts'))?.[1];
    expect(rustConst('SITE')).toBe(live);
  });
});

describe('what the site is given', () => {
  it('nothing of the computer: no capabilities, no Tauri object on the page', () => {
    // With no capability, no Tauri command answers the site. Granting one
    // would hand a web page a way into the computer; decide that on its own.
    expect(existsSync(join('src-tauri', 'capabilities'))).toBe(false);
    expect(config.app.security?.capabilities).toBeUndefined();
    expect(config.app.withGlobalTauri).not.toBe(true);
  });

  it('one window, made in main.rs with its rules for links', () => {
    // A window listed in the config would open without them: links to other
    // sites would load inside Nomi, and a new tab would do nothing at all.
    expect(config.app.windows).toEqual([]);
    expect(main).toMatch(/\.on_navigation\(move \|url\|/);
    expect(main).toMatch(/\.on_new_window\(\|url, _features\|/);
  });

  it('only web and email links are handed to Windows', () => {
    expect(main).toContain('matches!(url.scheme(), "https" | "http" | "mailto")');
  });
});

describe('the window on a PC (NOTES §74)', () => {
  it('opens at the size and place it was left, without a jump', () => {
    // Built hidden, and shown by the plugin once it has moved the window back
    // (or at once, with nothing saved). Without the plugin it would never show.
    expect(main).toContain('.visible(false)');
    expect(main).toContain('.plugin(tauri_plugin_window_state::Builder::new().build())');
    expect(cargo).toMatch(/^tauri-plugin-window-state = "/m);
  });

  it('hides the page while minimized, as a browser hides a tab', () => {
    // WebView2 does not notice a minimized window on its own (Microsoft's
    // IsVisible docs). Visible, a minimized Nomi kept animating and polling.
    expect(main).toMatch(/if let WindowEvent::Resized\(_\) = event/);
    expect(main).toContain('webview.hide()');
    expect(main).toContain('webview.show()');
  });
});

describe('the installer', () => {
  it('names the same app as the phone apps', () => {
    // The identifier also names the folder the window keeps its storage in.
    // Changing it would sign everyone out and drop the screens kept on the device.
    const expo = (JSON.parse(read('app.json')) as { expo: { ios: { bundleIdentifier: string }; android: { package: string } } })
      .expo;
    expect(config.identifier).toBe(expo.ios.bundleIdentifier);
    expect(config.identifier).toBe(expo.android.package);
  });

  it('has one version, in both places it is written', () => {
    expect(/^version = "([^"]+)"/m.exec(cargo)?.[1]).toBe(config.version);
  });

  it('is built by the CLI that matches the tauri crate', () => {
    const crate = /^tauri = \{ version = "([^"]+)"/m.exec(cargo)?.[1];
    const cli = /TAURI_CLI: '@tauri-apps\/cli@([^']+)'/.exec(workflow)?.[1];
    expect(crate).toBeDefined();
    expect(cli).toBe(crate);
  });

  it('is one setup .exe, with icons made from the app icon', () => {
    expect(config.bundle.targets).toEqual(['nsis']);
    expect(config.bundle.icon.every((icon) => icon.startsWith('icons/'))).toBe(true);
    expect(workflow).toContain('icon assets/icon.png');
    // `tauri icon` refuses a picture that is not square.
    const png = readFileSync(join('assets', 'icon.png'));
    expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20));
  });
});

describe('reminders in the Windows app', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A Windows browser that says it can do push, as WebView2 may. */
  function windowsPage(page: Record<string, unknown>) {
    vi.stubGlobal('window', { PushManager: class {}, Notification: {}, matchMedia: () => ({ matches: false }), ...page });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
      platform: 'Win32',
      maxTouchPoints: 0,
      serviceWorker: {},
    });
    vi.stubGlobal('Notification', { permission: 'default' });
  }

  it('are not offered: WebView2 has no push, whatever it says', () => {
    windowsPage({ [APP_MARK]: { platform: 'windows' } });
    expect(reminderSupport()).toBe('windows-app');
  });

  it('are offered as before in a browser on the same computer', () => {
    windowsPage({});
    expect(reminderSupport()).toBe('ready');
  });
});
