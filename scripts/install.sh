#!/usr/bin/env bash
#
# Lantern — installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/muriloramosoficial/lantern/main/scripts/install.sh | bash
#
# Options:
#   --version <tag>   install a specific release (default: latest)
#   --dir <path>      install folder (default: ~/.local/share/lantern)
#
# No account, no license server, no telemetry.

set -euo pipefail

OWNER="muriloramosoficial"
REPO="lantern"
APP="Lantern"
VERSION="latest"
INSTALL_DIR="${HOME}/.local/share/lantern"
BIN_DIR="${HOME}/.local/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say()  { printf "  %s\n" "$1"; }
dim()  { printf "  \033[2m%s\033[0m\n" "$1"; }
good() { printf "  \033[32m%s\033[0m\n" "$1"; }
bad()  { printf "  \033[31m%s\033[0m\n" "$1" >&2; }

echo
printf "  \033[38;5;214m%s\033[0m installer\n" "$APP"
dim "local-first AI workbench — no account, no license server"
echo

OS="$(uname -s)"
ARCH="$(uname -m)"

if [ "$VERSION" = "latest" ]; then
  API="https://api.github.com/repos/${OWNER}/${REPO}/releases/latest"
else
  API="https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/v${VERSION#v}"
fi

dim "looking up ${OWNER}/${REPO} (${VERSION})…"
RELEASE_JSON="$(curl -fsSL "$API" -H 'user-agent: lantern-installer' || true)"

if [ -z "$RELEASE_JSON" ]; then
  bad "Could not reach GitHub. Download manually:"
  say "https://github.com/${OWNER}/${REPO}/releases"
  exit 1
fi

TAG="$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"

case "$OS" in
  Darwin) PATTERN='\.dmg"';;
  Linux)  PATTERN='\.AppImage"';;
  *) bad "Unsupported platform: $OS"; exit 1;;
esac

URL="$(printf '%s' "$RELEASE_JSON" \
  | tr ',' '\n' \
  | grep 'browser_download_url' \
  | grep -E "$PATTERN" \
  | head -n1 \
  | sed -n 's/.*"\(https[^"]*\)".*/\1/p')"

if [ -z "$URL" ]; then
  bad "Release ${TAG} has no build for ${OS}."
  exit 1
fi

good "release ${TAG}"
FILE="$(basename "$URL")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

dim "downloading ${FILE}…"
curl -fL --progress-bar "$URL" -o "${TMP}/${FILE}"
chmod +x "${TMP}/${FILE}" 2>/dev/null || true

if [ "$OS" = "Darwin" ]; then
  dim "mounting the disk image…"
  MOUNT="${TMP}/mnt"
  mkdir -p "$MOUNT"
  if hdiutil attach "${TMP}/${FILE}" -nobrowse -mountpoint "$MOUNT" >/dev/null; then
    mkdir -p "$INSTALL_DIR"
    cp -R "${MOUNT}/${APP}.app" "$INSTALL_DIR/"
    hdiutil detach "$MOUNT" -quiet || true
    good "installed to ${INSTALL_DIR}/${APP}.app"
    say "Open it with: open \"${INSTALL_DIR}/${APP}.app\""
  else
    bad "Could not mount the image automatically."
    say "Open it manually: open \"${TMP}/${FILE}\""
    cp "${TMP}/${FILE}" "${HOME}/Downloads/" 2>/dev/null || true
  fi
  exit 0
fi

# Linux: place the AppImage on PATH as `lantern`.
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
cp "${TMP}/${FILE}" "${INSTALL_DIR}/${APP}.AppImage"
chmod +x "${INSTALL_DIR}/${APP}.AppImage"
ln -sf "${INSTALL_DIR}/${APP}.AppImage" "${BIN_DIR}/lantern"

good "installed to ${INSTALL_DIR}/${APP}.AppImage"

if ! printf '%s' "$PATH" | grep -q "$BIN_DIR"; then
  dim "${BIN_DIR} is not on your PATH yet. Add this to your shell profile:"
  say "export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

say "Launch it with:  lantern"
echo
