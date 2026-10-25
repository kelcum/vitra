mod auth;
mod capture;
mod clips;
mod content;
mod cosmetics;
mod discord;
mod error;
mod importer;
mod instances;
mod java;
mod memories;
mod minecraft;
mod modpack;
mod modrinth;
mod net;
mod optifine;
mod packs;
mod presence;
mod servers;
mod settings;
mod skins;
mod state;
mod system;
mod tasks;
mod util;

use std::sync::Arc;

use tauri::Manager;

use crate::state::AppState;

pub(crate) fn allow_asset_dirs(state: &AppState) {
    let scope = state.app.asset_protocol_scope();
    let _ = scope.allow_directory(&state.root, true);
    let _ = scope.allow_directory(state.data_dir(), true);
    for inst in instances::list_all(state) {
        if let Some(dir) = inst.game_dir {
            let _ = scope.allow_directory(dir, true);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            let state = AppState::new(app.handle().clone(), root)?;
            allow_asset_dirs(&state);
            let _ = std::fs::remove_dir_all(state.cache_dir().join("clips"));
            presence::start(state.clone());
            app.manage::<Arc<AppState>>(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            settings::reset_settings,
            tasks::list_tasks,
            tasks::cancel_task,
            instances::list_instances,
            instances::get_instance,
            instances::create_instance,
            instances::update_instance,
            instances::duplicate_instance,
            instances::delete_instance,
            instances::backup_instance,
            instances::list_worlds,
            instances::recent_worlds,
            instances::recent_screenshots,
            instances::instance_covers,
            importer::find_external_instances,
            importer::import_external_instance,
            servers::list_servers,
            servers::add_server,
            servers::edit_server,
            servers::remove_server,
            servers::set_server_hidden,
            servers::ping_server,
            minecraft::install::list_game_versions,
            minecraft::install::latest_release,
            minecraft::install::install_instance_cmd,
            minecraft::loaders::list_loader_versions,
            minecraft::loaders::list_loader_game_versions,
            minecraft::launch::launch_instance,
            minecraft::launch::stop_instance,
            minecraft::launch::running_instances,
            minecraft::launch::inject_game_log,
            memories::list_memories,
            memories::set_memory_favorite,
            memories::delete_memory,
            memories::delete_memory_clip,
            memories::reveal_memory,
            java::list_java,
            java::inspect_java,
            java::install_java_runtime,
            auth::list_accounts,
            auth::set_active_account,
            auth::remove_account,
            auth::begin_sign_in,
            auth::cancel_sign_in,
            auth::check_active_account,
            skins::list_skins,
            skins::import_skin,
            skins::update_skin,
            skins::delete_skin,
            skins::get_profile,
            skins::apply_skin,
            skins::set_cape,
            skins::save_current_skin,
            skins::find_player_skin,
            skins::name_change_info,
            skins::check_names,
            skins::change_name,
            skins::fetch_skin_link,
            skins::save_found_skin,
            optifine::optifine_cape,
            optifine::open_optifine_cape_editor,
            cosmetics::cosmetics_supported,
            cosmetics::cosmetics_status,
            cosmetics::set_vitra_cape,
            cosmetics::delete_vitra_data,
            modrinth::modrinth_search,
            modrinth::modrinth_project,
            modrinth::modrinth_versions,
            modrinth::modrinth_categories,
            content::list_content,
            content::set_content_enabled,
            content::remove_content,
            content::list_trash,
            content::restore_trash,
            content::empty_trash,
            content::plan_install,
            content::apply_plan,
            content::check_updates,
            content::import_content_files,
            packs::get_game_options,
            packs::set_game_options,
            packs::list_resource_packs,
            packs::set_resource_packs,
            packs::shader_state,
            packs::set_active_shader,
            modpack::import_modpack_file,
            modpack::install_modpack,
            modpack::export_modpack,
            system::system_info,
            system::patch_notes,
            system::patch_note_body,
            system::panorama,
            system::import_background,
            system::open_path,
            system::open_instance_folder,
            system::open_url,
            system::list_logs,
            system::read_log,
            system::read_crash_report,
            system::storage_info,
            system::clear_cache,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Vitra")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    tauri::async_runtime::block_on(presence::shutdown(&state));
                }
            }
        });
}
