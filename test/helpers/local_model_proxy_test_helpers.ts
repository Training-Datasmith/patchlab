/** Match daemon entrypoint argv fragments across platform path separators. */
export function spawn_argument_includes_proxy_main(argument: string): boolean {
    return argument.replaceAll('\\', '/').includes('local_model_proxy/main.js');
}
