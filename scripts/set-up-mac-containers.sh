#!/usr/bin/env bash
# Set up Lima + nerdctl for patchlab development on macOS.
set -euo pipefail

echo "==> Checking Homebrew..."
if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required. Install from https://brew.sh" >&2
    exit 1
fi

echo "==> Installing Lima (includes containerd + nerdctl in the VM)..."
brew install lima

echo "==> Starting default Lima instance (downloads VM image on first run)..."
limactl start --tty=false

echo "==> Verifying nerdctl..."
nerdctl.lima --version
nerdctl.lima run --rm hello-world >/dev/null

SHELL_RC="${HOME}/.zshrc"
MARKER="# patchlab container runtime (Lima + nerdctl)"
if ! grep -qF "$MARKER" "$SHELL_RC" 2>/dev/null; then
    echo "==> Adding shell aliases to ${SHELL_RC}..."
    cat >>"$SHELL_RC" <<'EOF'

# patchlab container runtime (Lima + nerdctl)
alias nerdctl='nerdctl.lima'
export PATCHLAB_CONTAINER_RUNTIME=nerdctl
EOF
    echo "    Added nerdctl alias and PATCHLAB_CONTAINER_RUNTIME=nerdctl"
else
    echo "==> Shell config already present in ${SHELL_RC}"
fi

echo ""
echo "Setup complete."
echo ""
echo "  Runtime:  nerdctl via Lima (nerdctl.lima)"
echo "  VM:       limactl list"
echo "  Test:     nerdctl.lima run --rm hello-world"
echo ""
echo "Reload your shell or run:  source ${SHELL_RC}"
echo "Then build patchlab:       npm install && npm run build"
