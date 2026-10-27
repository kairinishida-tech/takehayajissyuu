#!/bin/zsh
# Gijiroku.app（議事録のメニューバーアプリ）をビルドする
set -e
cd "$(dirname "$0")"
APP="Gijiroku.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -swift-version 5 main.swift -o "$APP/Contents/MacOS/Gijiroku"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Gijiroku</string>
  <key>CFBundleDisplayName</key><string>議事録</string>
  <key>CFBundleIdentifier</key><string>local.gijiroku</string>
  <key>CFBundleExecutable</key><string>Gijiroku</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Zoom 会議の音声（BlackHole）と自分のマイクを録音して文字起こしするために使用します。</string>
  <key>NSDocumentsFolderUsageDescription</key><string>録音・文字起こし・議事録を「書類」フォルダに保存するために使用します。</string>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "✅ ビルド完了: $(pwd)/$APP"
