#!/usr/bin/env bash
# Chạy cargo với toolchain đặt trong dự án (không cần quyền ghi $HOME).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_HOME="$ROOT/.cargo"
export RUSTUP_HOME="$ROOT/.rustup"
export TMPDIR="$ROOT/.rust-tmp"
mkdir -p "$TMPDIR"
exec "$CARGO_HOME/bin/cargo" "$@"
