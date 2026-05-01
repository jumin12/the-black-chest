#!/usr/bin/env bash
# Render Native builds clone the repo with Git but do not ship `git-lfs`. Without `git lfs pull`,
# `*.glb` files stay as tiny LFS pointers (~324B) and clients cannot parse scenes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v git-lfs >/dev/null 2>&1; then
  VER="${GIT_LFS_VERSION:-3.6.1}"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64 | amd64) LFS_ARCH="amd64" ;;
    aarch64 | arm64) LFS_ARCH="arm64" ;;
    *)
      echo "Unsupported machine arch for portable git-lfs: ${ARCH}" >&2
      exit 1
      ;;
  esac
  URL="https://github.com/git-lfs/git-lfs/releases/download/v${VER}/git-lfs-linux-${LFS_ARCH}-v${VER}.tar.gz"
  echo "[render-build] Installing git-lfs v${VER} (${LFS_ARCH})"
  TMP_TAR="$(mktemp)"
  TMP_EX="$(mktemp -d)"
  trap 'rm -rf "${TMP_TAR}" "${TMP_EX}"' EXIT
  curl -fsSL "${URL}" -o "${TMP_TAR}"
  tar -xzf "${TMP_TAR}" -C "${TMP_EX}"
  LFS_BIN="$(find "${TMP_EX}" -type f -name git-lfs ! -path '*/.git/*' | head -n1)"
  if [[ ! -x "${LFS_BIN}" ]]; then
    echo "[render-build] Could not unpack git-lfs binary from release tarball." >&2
    exit 1
  fi
  chmod +x "${LFS_BIN}"
  export PATH="$(dirname "${LFS_BIN}"):${PATH}"
fi

git lfs version
git lfs install
git lfs pull

echo "[render-build] npm install"
npm install
