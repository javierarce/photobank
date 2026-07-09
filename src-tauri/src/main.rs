// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod error;
mod exif;
mod import;
mod keys;
mod photos;
mod pipeline;
mod protocol;
mod settings;

use std::sync::Mutex;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
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
            commands::get_photo_tags,
            commands::add_photo_tag,
            commands::remove_photo_tag,
            commands::update_photo,
            commands::delete_photo,
            commands::import_photos,
            commands::export_photos,
            settings::get_settings,
            settings::save_settings,
            settings::test_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
