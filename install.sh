#!/usr/bin/env bash
set -euo pipefail

UUID="sysmon2x2@local"
DEST="$HOME/.local/share/cinnamon/applets/$UUID"

mkdir -p "$DEST"
cp applet.js metadata.json stylesheet.css "$DEST/"

echo "系统状态监控 已安装到: $DEST"
echo "接下来: 系统设置 → 面板 → 添加小程序 → 系统状态监控"
