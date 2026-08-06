/** Render a byte count using the largest binary unit at which the value is at least 1. */
export function format_bytes(bytes: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit_index = 0;
    while (value >= 1024 && unit_index < units.length - 1) {
        value /= 1024;
        unit_index++;
    }

    return unit_index === 0 ? `${value} B` : `${value.toFixed(2)} ${units[unit_index]}`;
}
