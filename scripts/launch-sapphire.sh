#!/usr/bin/env bash
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
cd "/Volumes/My Passport/Sapphire-native"
exec /usr/local/bin/npm --prefix electron-shell start
