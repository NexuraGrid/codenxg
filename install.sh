#!/usr/bin/env bash
# Installs the latest CodeNXG release for Linux x86_64.
# Usage: curl -fsSL https://raw.githubusercontent.com/NexuraGrid/codenxg/main/install.sh | bash
set -euo pipefail

REPO="NexuraGrid/codenxg"
BIN_NAME="codenxg"
INSTALL_DIR="${CODENXG_INSTALL_DIR:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"

if [ "$os" != "Linux" ] || [ "$arch" != "x86_64" ]; then
  echo "This script only supports Linux x86_64 right now." >&2
  echo "Grab your platform's build from https://github.com/${REPO}/releases/latest" >&2
  exit 1
fi

echo "Fetching latest release info..."
release_json="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")"

asset_url="$(printf '%s' "$release_json" \
  | grep -oE '"browser_download_url": *"[^"]*amd64\.AppImage"' \
  | head -n1 \
  | grep -oE 'https://[^"]+')"

if [ -z "$asset_url" ]; then
  echo "Could not find a Linux AppImage asset in the latest release." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
target="${INSTALL_DIR}/${BIN_NAME}"

echo "Downloading ${asset_url}"
curl -fsSL "$asset_url" -o "$target"
chmod +x "$target"

echo "Installed CodeNXG to ${target}"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "Note: ${INSTALL_DIR} is not on your PATH. Add this to your shell profile:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

echo ""
echo "Run '${BIN_NAME}' to start, or '${BIN_NAME} <folder>' to open a project."
