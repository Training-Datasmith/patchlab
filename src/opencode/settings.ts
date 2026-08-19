/** User-global OpenCode settings from ~/.patchlab/configuration.yaml. */
export interface Loaded_OpenCode_Settings {
    copy_host_configuration: boolean;
    copy_host_auth: boolean;
    proxy_local_models: boolean;
    environment: Record<string, string>;
}

export const DEFAULT_LOADED_OPENCODE_SETTINGS: Loaded_OpenCode_Settings = {
    copy_host_configuration: true,
    copy_host_auth: true,
    proxy_local_models: true,
    environment: {},
};
