#!/bin/sh
# Download the Bare Kit Android prebuild into android/app/libs/bare-kit.
# Needs the GitHub CLI (gh). The zip is large (~400 MB, all platforms).
set -e
VERSION="${1:-v2.5.5}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

gh release download "$VERSION" --repo holepunchto/bare-kit --pattern prebuilds.zip --dir "$TMP"
unzip -q "$TMP/prebuilds.zip" 'android/bare-kit/*' -d "$TMP"
rm -rf "$ROOT/android/app/libs/bare-kit"
mkdir -p "$ROOT/android/app/libs"
mv "$TMP/android/bare-kit" "$ROOT/android/app/libs/bare-kit"
echo "Bare Kit $VERSION is in android/app/libs/bare-kit"
