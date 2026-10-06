//! Nomi for Windows (NOTES §73).
//!
//! One window that shows the live site. Nothing of Nomi is inside this
//! program, so a deploy reaches the window the next time it opens, and what the
//! site keeps on the device (NOTES §71) is kept in the window's own storage, as
//! a browser would keep it.
//!
//! The site is given nothing of the computer. There are no capabilities, so no
//! Tauri command answers it. All it learns is that it is in this window, from
//! `MARK`. tests/windows-app.test.ts holds both.

// No console window behind the app, except in a debug build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::NewWindowResponse;
use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

/// The live site, the same address scripts/deploy-status.ts reads.
const SITE: &str = "https://learning-app-6kk.pages.dev/";

/// Runs before the site's own code, on the site only. src/core/windows-app.ts
/// reads it. Microsoft's WebView2, which draws this window, has no push, so
/// Settings says where reminders go instead of offering them.
const MARK: &str = "if (window.location.origin === 'https://learning-app-6kk.pages.dev') {
  Object.defineProperty(window, 'nomiApp', { value: Object.freeze({ platform: 'windows' }) });
}";

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let site = Url::parse(SITE)?;
            let home = site.origin();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(site))
                .title("Nomi")
                .inner_size(1100.0, 680.0)
                .min_inner_size(360.0, 560.0)
                .center()
                .initialization_script(MARK)
                // Tauri's own drag and drop replaces WebView2's on Windows, and
                // the page's stops working. The page's is the one Nomi uses.
                .disable_drag_drop_handler()
                // Inside Nomi, stay. Anywhere else opens in the person's browser.
                .on_navigation(move |url| {
                    if url.origin() == home {
                        return true;
                    }
                    open_outside(url);
                    false
                })
                // A link Nomi opens in a new tab: the Gemini key page, a source,
                // an email. Left alone it would do nothing at all, because wry
                // drops a new window that nothing answers for.
                .on_new_window(|url, _features| {
                    open_outside(&url);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Nomi could not start");
}

/// Hands a web or email link to Windows, which opens the person's own browser
/// or mail app. Nothing else is ever handed over: not a file, not a program, not
/// any other kind of link.
fn open_outside(url: &Url) {
    if matches!(url.scheme(), "https" | "http" | "mailto") {
        if let Err(err) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
            eprintln!("could not open {url}: {err}");
        }
    }
}
