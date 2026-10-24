#!/bin/sh
# Builds macos/build/pearbell.app (a universal binary, signed ad hoc) and
# macos/build/pearbell-mac.zip. Needs Xcode 15 or later.
#
#   macos/scripts/build-app.sh            version from package.json
#   PEARBELL_VERSION=v0.8.0 macos/scripts/build-app.sh
set -eu
cd "$(dirname "$0")/.."

version=${PEARBELL_VERSION:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' ../package.json)}
version=${version#v}

swift build -c release --arch arm64 --arch x86_64
bin=$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)

app=build/pearbell.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin/Pearbell" "$app/Contents/MacOS/Pearbell"
sed "s/__VERSION__/$version/g" Info.plist > "$app/Contents/Info.plist"
codesign --force --sign - "$app"

rm -f build/pearbell-mac.zip
ditto -c -k --keepParent "$app" build/pearbell-mac.zip
echo "Built $app ($version) and build/pearbell-mac.zip"
