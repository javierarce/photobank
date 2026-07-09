// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod error;

use std::sync::Mutex;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let conn = db::init(app.handle())?;
            app.manage(db::Db(Mutex::new(conn)));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
