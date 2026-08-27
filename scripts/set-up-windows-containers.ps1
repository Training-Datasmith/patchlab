# Set up Podman for patchlab development on Windows.
# Requires PowerShell 5.1+ or PowerShell 7+.
$ErrorActionPreference = 'Stop'

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host '==> Checking Podman...'
if (-not (Test-Command podman)) {
    Write-Error @'
Podman is not installed.

Install Podman Desktop from https://podman.io/docs/installation/windows
or install the Podman CLI and ensure `podman` is on your PATH.
'@
}

podman --version | Write-Host

Write-Host '==> Ensuring a Podman machine exists...'
$machineList = podman machine list --format '{{.Name}}' 2>$null
if (-not $machineList) {
    Write-Host '    No machine found — running podman machine init (first run may take a few minutes)...'
    podman machine init
}

Write-Host '==> Starting Podman machine...'
try {
    podman machine start | Write-Host
} catch {
    Write-Host '    Start failed; trying stop + start...'
    podman machine stop 2>$null | Out-Null
    podman machine start | Write-Host
}

Write-Host '==> Verifying Podman connectivity...'
podman info --format '{{.Host.RemoteSocket.Path}}' | Out-Null
podman run --rm hello-world | Out-Null

Write-Host ''
Write-Host 'Setup complete.'
Write-Host ''
Write-Host '  Runtime:  Podman (podman machine VM)'
Write-Host '  Status:   podman machine list'
Write-Host '  Test:     podman run --rm hello-world'
Write-Host ''
Write-Host 'Build patchlab:  npm install && npm run build && npm link'
Write-Host 'Then try:        patchlab create .'
