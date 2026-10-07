// Typed wrappers for every backend command. Components never call `invoke`
// directly, so the IPC surface is visible in one place.

import { invoke } from "@tauri-apps/api/core";
import type * as T from "./types";

export const api = {
  // settings
  getSettings: () => invoke<T.Settings>("get_settings"),
  saveSettings: (settings: T.Settings) => invoke<T.Settings>("save_settings", { settings }),
  resetSettings: () => invoke<T.Settings>("reset_settings"),

  // tasks
  listTasks: () => invoke<T.TaskSnapshot[]>("list_tasks"),
  cancelTask: (id: string) => invoke<void>("cancel_task", { id }),

  // instances
  listInstances: () => invoke<T.InstanceView[]>("list_instances"),
  getInstance: (id: string) => invoke<T.InstanceView>("get_instance", { id }),
  createInstance: (req: { name: string; gameVersion: string; loader: T.Loader; loaderVersion: string | null; icon?: string }) =>
    invoke<T.InstanceView>("create_instance", { req }),
  updateInstance: (instance: T.Instance) => invoke<T.InstanceView>("update_instance", { instance }),
  duplicateInstance: (id: string, name: string) => invoke<T.InstanceView>("duplicate_instance", { id, name }),
  deleteInstance: (id: string) => invoke<void>("delete_instance", { id }),
  backupInstance: (id: string) => invoke<string>("backup_instance", { id }),
  listWorlds: (id: string) => invoke<T.WorldInfo[]>("list_worlds", { id }),
  recentWorlds: (limit: number) => invoke<T.WorldInfo[]>("recent_worlds", { limit }),
  recentScreenshots: (limit: number) => invoke<string[]>("recent_screenshots", { limit }),
  instanceCovers: () => invoke<Record<string, T.InstanceCover>>("instance_covers"),
  findExternalInstances: (folder: string | null) => invoke<T.ExternalInstance[]>("find_external_instances", { folder }),
  importExternalInstance: (path: string) => invoke<T.InstanceView>("import_external_instance", { path }),

  // versions / install / launch
  listGameVersions: () => invoke<T.GameVersion[]>("list_game_versions"),
  latestRelease: () => invoke<string>("latest_release"),
  installInstance: (id: string, verify: boolean) => invoke<string>("install_instance_cmd", { id, verify }),
  listLoaderVersions: (loader: T.Loader, gameVersion: string) =>
    invoke<T.LoaderVersion[]>("list_loader_versions", { loader, gameVersion }),
  listLoaderGameVersions: (loader: T.Loader) => invoke<string[]>("list_loader_game_versions", { loader }),
  launch: (id: string, options?: { world?: string | null; server?: string | null; demo?: boolean }) => invoke<void>("launch_instance", { id, options }),
  stop: (id: string) => invoke<void>("stop_instance", { id }),
  runningInstances: () => invoke<T.RunningInfo[]>("running_instances"),

  // java
  listJava: () => invoke<T.JavaInstall[]>("list_java"),
  inspectJava: (path: string) => invoke<T.JavaInstall>("inspect_java", { path }),
  installJavaRuntime: (component: string, major: number) => invoke<string>("install_java_runtime", { component, major }),

  // accounts
  listAccounts: () => invoke<T.Account[]>("list_accounts"),
  setActiveAccount: (uuid: string) => invoke<void>("set_active_account", { uuid }),
  removeAccount: (uuid: string) => invoke<void>("remove_account", { uuid }),
  beginSignIn: () => invoke<T.DeviceCodeInfo>("begin_sign_in"),
  cancelSignIn: () => invoke<void>("cancel_sign_in"),
  checkActiveAccount: () => invoke<T.Account | null>("check_active_account"),

  // skins
  listSkins: () => invoke<T.SavedSkin[]>("list_skins"),
  importSkin: (path: string, name: string, model: string) => invoke<T.SavedSkin>("import_skin", { path, name, model }),
  updateSkin: (id: string, name: string, model: string) => invoke<void>("update_skin", { id, name, model }),
  deleteSkin: (id: string) => invoke<void>("delete_skin", { id }),
  getProfile: () => invoke<T.ProfileView>("get_profile"),
  applySkin: (id: string) => invoke<T.ProfileView>("apply_skin", { id }),
  setCape: (capeId: string | null) => invoke<T.ProfileView>("set_cape", { capeId }),
  saveCurrentSkin: () => invoke<T.SavedSkin>("save_current_skin"),
  findPlayerSkin: (name: string) => invoke<T.FoundSkin>("find_player_skin", { name }),
  nameChangeInfo: () => invoke<T.NameChangeInfo>("name_change_info"),
  checkNames: (names: string[], want: number) => invoke<T.NameCheck>("check_names", { names, want }),
  changeName: (name: string) => invoke<T.ProfileView>("change_name", { name }),
  fetchSkinLink: (url: string) => invoke<T.FoundSkin>("fetch_skin_link", { url }),
  saveFoundSkin: (name: string, model: string, dataUrl: string) => invoke<T.SavedSkin>("save_found_skin", { name, model, dataUrl }),
  optifineCape: () => invoke<string | null>("optifine_cape"),
  openOptifineCapeEditor: () => invoke<void>("open_optifine_cape_editor"),
  cosmeticsSupported: (loader: string, gameVersion: string) => invoke<boolean>("cosmetics_supported", { loader, gameVersion }),
  deleteVitraData: () => invoke<void>("delete_vitra_data"),
  cosmeticsStatus: () => invoke<T.CosmeticsStatus>("cosmetics_status"),
  /** A preset, an uploaded cape (base64 PNG of stacked frames), or neither to take the cape off. */
  setVitraCape: (args: { preset?: string; image?: string; frames?: number; delay?: number }) =>
    invoke<T.VitraCape | null>("set_vitra_cape", { preset: null, image: null, frames: null, delay: null, ...args }),

  // modrinth & content
  search: (params: {
    query: string;
    projectType: T.ProjectType;
    loader?: string | null;
    gameVersion?: string | null;
    categories?: string[];
    sort?: string;
    offset: number;
    limit: number;
  }) => invoke<T.SearchResult>("modrinth_search", { params: { categories: [], ...params } }),
  project: (id: string) => invoke<T.MrProjectDetail>("modrinth_project", { id }),
  projectVersions: (id: string, loader?: string | null, gameVersion?: string | null) =>
    invoke<T.MrVersion[]>("modrinth_versions", { id, loader, gameVersion }),
  categories: () => invoke<{ name: string; project_type: string; header: string; icon: string }[]>("modrinth_categories"),
  listContent: (id: string, projectType: T.ProjectType) => invoke<T.ContentItem[]>("list_content", { id, projectType }),
  setContentEnabled: (id: string, key: string, enabled: boolean) => invoke<void>("set_content_enabled", { id, key, enabled }),
  removeContent: (id: string, keys: string[]) => invoke<void>("remove_content", { id, keys }),
  listTrash: (id: string) => invoke<T.TrashItem[]>("list_trash", { id }),
  restoreTrash: (id: string, trashName: string) => invoke<void>("restore_trash", { id, trashName }),
  emptyTrash: (id: string) => invoke<void>("empty_trash", { id }),
  planInstall: (id: string, requests: T.PlanRequest[]) => invoke<T.InstallPlan>("plan_install", { id, requests }),
  applyPlan: (plan: T.InstallPlan) => invoke<void>("apply_plan", { plan }),
  checkUpdates: (id: string, projectType: T.ProjectType) => invoke<T.UpdateInfo[]>("check_updates", { id, projectType }),
  importContentFiles: (id: string, projectType: T.ProjectType, paths: string[]) =>
    invoke<number>("import_content_files", { id, projectType, paths }),

  // packs & options
  getGameOptions: (id: string) => invoke<Record<string, string>>("get_game_options", { id }),
  setGameOptions: (id: string, values: Record<string, string>) => invoke<void>("set_game_options", { id, values }),
  listResourcePacks: (id: string) => invoke<T.ResourcePack[]>("list_resource_packs", { id }),
  setResourcePacks: (id: string, enabled: string[]) => invoke<void>("set_resource_packs", { id, enabled }),
  shaderState: (id: string) => invoke<T.ShaderState>("shader_state", { id }),
  setActiveShader: (id: string, pack: string | null) => invoke<void>("set_active_shader", { id, pack }),

  // servers
  listServers: () => invoke<T.ServerEntry[]>("list_servers"),
  addServer: (name: string, address: string) => invoke<T.ServerEntry>("add_server", { name, address }),
  editServer: (id: string, name: string, address: string) => invoke<void>("edit_server", { id, name, address }),
  removeServer: (id: string) => invoke<void>("remove_server", { id }),
  setServerHidden: (id: string, hidden: boolean) => invoke<void>("set_server_hidden", { id, hidden }),
  pingServer: (address: string) => invoke<T.ServerStatus>("ping_server", { address }),

  // modpacks
  importModpackFile: (path: string) => invoke<T.InstanceView>("import_modpack_file", { path }),
  installModpack: (projectId: string, versionId: string | null, title: string, iconUrl: string | null) =>
    invoke<T.InstanceView>("install_modpack", { projectId, versionId, title, iconUrl }),
  exportModpack: (
    id: string,
    options: { name: string; version: string; summary?: string; include: string[]; outPath: string },
  ) => invoke<string>("export_modpack", { id, options }),

  // system
  systemInfo: () => invoke<T.SystemInfo>("system_info"),
  patchNotes: (limit: number) => invoke<T.PatchNote[]>("patch_notes", { limit }),
  patchNoteBody: (contentPath: string) => invoke<T.TextBlock[]>("patch_note_body", { contentPath }),
  panorama: () => invoke<string[]>("panorama"),
  importBackground: (path: string) => invoke<string>("import_background", { path }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  openInstanceFolder: (id: string, sub?: string) => invoke<void>("open_instance_folder", { id, sub }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  listLogs: (id: string) => invoke<T.LogFile[]>("list_logs", { id }),
  readLog: (id: string, name: string, kind: string) => invoke<string>("read_log", { id, name, kind }),
  readCrashReport: (path: string) => invoke<string>("read_crash_report", { path }),
  storageInfo: () => invoke<T.StorageInfo>("storage_info"),
  clearCache: () => invoke<void>("clear_cache"),
};

/** Backend errors arrive as strings; some carry a machine-readable prefix. */
export function parseError(e: unknown): { code: string | null; message: string } {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  const m = raw.match(/^([A-Z_]{4,}):\s*([\s\S]*)$/);
  return m ? { code: m[1], message: m[2] } : { code: null, message: raw };
}

export const errorMessage = (e: unknown) => parseError(e).message;
