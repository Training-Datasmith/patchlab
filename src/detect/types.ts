/**
 * The vocabulary of sandbox requirements that detection produces and the
 * downstream pipeline consumes. Each requirement carries its `source` so
 * later stages can surface where a contested value came from (e.g.
 * `environment_var` conflicts).
 */

export type Requirement_Source =
    | 'ci_configuration'
    | 'docker_compose'
    | 'source_code'
    | 'test_scripts'
    | 'dev_dependencies'
    | 'package_manifest'
    | 'configuration_files'
    | 'php_test_configuration';

export interface System_Package_Requirement {
    type: 'system_package';
    capability: string;
    source: Requirement_Source;
}

export interface Volume_Mount_Requirement {
    type: 'volume_mount';
    host_path: string;
    container_path: string;
    source: Requirement_Source;
}

export interface Environment_Variable_Requirement {
    type: 'environment_var';
    key: string;
    value: string;
    source: Requirement_Source;
}

export interface Service_Requirement {
    type: 'service';
    name: string;
    source: Requirement_Source;
}

export interface Npm_Package_Requirement {
    type: 'npm_package';
    package: string;
    init_command?: string[];
    source: Requirement_Source;
}

export type Sandbox_Requirement =
    | System_Package_Requirement
    | Volume_Mount_Requirement
    | Environment_Variable_Requirement
    | Service_Requirement
    | Npm_Package_Requirement;

export interface Detected_Requirements {
    system_packages: System_Package_Requirement[];
    volume_mounts: Volume_Mount_Requirement[];
    environment_variables: Environment_Variable_Requirement[];
    services: Service_Requirement[];
    npm_packages: Npm_Package_Requirement[];
}

export interface Detector_Context {
    readonly tool?: string;
    readonly exclude_suggested_extensions?: boolean;
}

export type Detector = (
    directory: string,
    context?: Readonly<Detector_Context>,
) => Sandbox_Requirement[];
