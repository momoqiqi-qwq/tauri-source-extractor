#!/usr/bin/env bash
# 在 Git Bash 下构建 Rust/Tauri 时自动注入 MSVC + Windows SDK 环境。
#
# 解决的问题：Git Bash 的 /usr/bin/link.exe（GNU coreutils）会遮蔽 MSVC 的
# link.exe，且默认缺少 INCLUDE / LIB，导致 LNK1181 / LNK1104。
#
# 用法：  bash scripts/msvc-env.sh cargo check
#         bash scripts/msvc-env.sh cargo build --release
set -euo pipefail

find_msvc() {
  local root
  for root in \
    "/c/Program Files/Microsoft Visual Studio/18/Community" \
    "/c/Program Files/Microsoft Visual Studio/2022/Community" \
    "/c/Program Files/Microsoft Visual Studio/2022/Professional" \
    "/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools"; do
    if [ -d "$root/VC/Tools/MSVC" ]; then
      ls -d "$root/VC/Tools/MSVC"/*/ 2>/dev/null | sort -V | tail -1
      return 0
    fi
  done
  return 1
}

MSVC_POSIX="$(find_msvc)" || {
  echo "错误：未找到 MSVC 工具链，请安装 Visual Studio 的『使用 C++ 的桌面开发』工作负载。" >&2
  exit 1
}
MSVC_POSIX="${MSVC_POSIX%/}"

SDK_POSIX="/c/Program Files (x86)/Windows Kits/10"
SDK_VER="$(ls "$SDK_POSIX/Include" 2>/dev/null | sort -V | tail -1)"
if [ -z "$SDK_VER" ]; then
  echo "错误：未找到 Windows SDK。" >&2
  exit 1
fi

# POSIX 路径 -> Windows 路径
win() { printf '%s' "$1" | sed -e 's|^/\([a-z]\)/|\1:\\|' -e 's|/|\\|g'; }

export INCLUDE="$(win "$MSVC_POSIX")\\include;$(win "$SDK_POSIX")\\Include\\$SDK_VER\\ucrt;$(win "$SDK_POSIX")\\Include\\$SDK_VER\\shared;$(win "$SDK_POSIX")\\Include\\$SDK_VER\\um;$(win "$SDK_POSIX")\\Include\\$SDK_VER\\winrt;$(win "$SDK_POSIX")\\Include\\$SDK_VER\\cppwinrt"

export LIB="$(win "$MSVC_POSIX")\\lib\\x64;$(win "$SDK_POSIX")\\Lib\\$SDK_VER\\ucrt\\x64;$(win "$SDK_POSIX")\\Lib\\$SDK_VER\\um\\x64"

# 把 MSVC 的 bin 放到 PATH 最前面，压过 Git Bash 的 /usr/bin/link
export PATH="$MSVC_POSIX/bin/Hostx64/x64:$HOME/.cargo/bin:$PATH"

if [ "$#" -eq 0 ]; then
  echo "MSVC: $MSVC_POSIX"
  echo "SDK : $SDK_VER"
  echo "link: $(command -v link)"
  exit 0
fi

exec "$@"
