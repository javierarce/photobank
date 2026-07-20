// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod error;
mod exif;
mod import;
mod keys;
mod manifest;
mod photos;
mod pipeline;
mod protocol;
mod refresh;
mod settings;

use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol("photo", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(protocol::handle(app, request).await);
            });
        })
        .setup(|app| {
            let conn = db::init(app.handle())?;
            app.manage(db::Db(Mutex::new(conn)));
            app.manage(settings::S3State::default());
            app.manage(manifest::ManifestState::default());
            app.manage(import::CancelRegistry::default());
            app.manage(refresh::RefreshState::default());

            // Native menu: start from the default macOS menu and slip a
            // "Settings…" item (Cmd+,) into the app submenu, right after About.
            let menu = Menu::default(app.handle())?;
            let settings_item = MenuItem::with_id(
                app.handle(),
                "settings",
                "Settings…",
                true,
                Some("CmdOrCtrl+,"),
            )?;
            if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
                // Position 1 lands it after About and before the existing
                // separator, so it reads: About / Settings… / --- / Services.
                app_menu.insert(&settings_item, 1)?;
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id() == "settings" {
                    let _ = app.emit("menu://settings", ());
                }
            });

            // Build the S3 client from saved settings + Keychain off the main
            // thread; the UI shows "not configured" states until it lands.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                settings::refresh_client(&handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_folders,
            commands::list_photos,
            commands::search_photos,
            commands::list_tags,
            commands::list_search_facets,
            commands::get_photo_tags,
            commands::add_photo_tag,
            commands::remove_photo_tag,
            commands::update_photo,
            commands::rename_folder,
            commands::delete_photo,
            commands::import_photos,
            commands::cancel_import,
            commands::export_photos,
            settings::get_settings,
            settings::save_settings,
            settings::test_connection,
            manifest::rebuild_from_bucket,
            refresh::refresh_library,
            refresh::refresh_pending_count,
            refresh::refresh_status,
            refresh::cancel_refresh,
            refresh::load_photo_metadata,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
