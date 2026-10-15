import { invoke } from "@tauri-apps/api/core";
import type { Settings, ApiInfo, DataRootInfo, CloudSyncTarget, CloudSyncResult } from "./types";

export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsSave = (value: Settings) => invoke("settings_save", { value });
/** Why settings.json could not be read, or null when it reads fine. */
export const settingsLoadError = () => invoke<string | null>("settings_load_error");
export const apiInfo = () => invoke<ApiInfo>("api_info");
export const apiRegenerateToken = () => invoke<ApiInfo>("api_regenerate_token");
export const mcpDownload = (dir: string) => invoke<string>("mcp_download", { dir });

export const dataRootGet = () => invoke<DataRootInfo>("data_root_get");
/** Moves the data; progress arrives as `data-migration` events. */
export const dataRootMigrate = (path: string) => invoke<number>("data_root_migrate", { path });

export const cloudSyncStatus = () => invoke<CloudSyncTarget[]>("cloud_sync_status");
/** Empty `dir` goes back to the detected default. */
export const cloudSyncSetTarget = (target: string, dir: string) => invoke("cloud_sync_set_target", { target, dir });
/** `ids` omitted = every profile plus proxies, bookmarks and automation. */
export const cloudSyncPush = (target: string, ids?: string[]) =>
  invoke<CloudSyncResult>("cloud_sync_push", { target, ids });
export const cloudSyncPull = (target: string, ids?: string[]) =>
  invoke<CloudSyncResult>("cloud_sync_pull", { target, ids });
