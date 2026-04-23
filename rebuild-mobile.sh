#!/usr/bin/env bash
#
# rebuild-mobile.sh  (SDK 53, locked)
# -----------------------------------
# Rebuilds mobile/ from a pinned Expo SDK 53 scaffold and re-injects our
# deltas. Explicitly does NOT run `expo install --fix` (that pushes
# us to SDK 54). All versions come from _deltas/package.sdk53.json.
#
# Flow:
#   1. create _mobile-fresh/ with create-expo-app --template expo-template-bare-minimum@sdk-53
#   2. overwrite its package.json with _deltas/package.sdk53.json
#   3. copy app/, src/, and config files from _deltas/
#   4. npm install   (no expo install --fix)
#   5. expo prebuild --clean
#   6. verify android/app/src/main/java/com/guardiancloud/app/MainApplication.{kt,java}
#   7. if --promote: archive mobile/ and swap _mobile-fresh/ -> mobile/
#
# Usage:
#   bash rebuild-mobile.sh              # dry run, validates only
#   bash rebuild-mobile.sh --promote    # same, then swap mobile/
#
# Does NOT touch: backend/, docs/, CLAUDE.md, _deltas/.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DELTAS_DIR="$ROOT_DIR/_deltas"
FRESH_DIR="$ROOT_DIR/_mobile-fresh"
MOBILE_DIR="$ROOT_DIR/mobile"
ANDROID_PKG_PATH="com/guardiancloud/app"
TEMPLATE="expo-template-bare-minimum@sdk-53"

PROMOTE=0
[[ "${1:-}" == "--promote" ]] && PROMOTE=1

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m!!  %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[1;32m ok\033[0m %s\n' "$*"; }

command -v node >/dev/null || die "node not installed"
command -v npm  >/dev/null || die "npm not installed"
command -v npx  >/dev/null || die "npx not installed"

[[ -d "$DELTAS_DIR" ]] || die "no _deltas/ at $DELTAS_DIR"
[[ -d "$DELTAS_DIR/app" ]] || die "_deltas/app missing"
[[ -d "$DELTAS_DIR/src" ]] || die "_deltas/src missing"
[[ -f "$DELTAS_DIR/package.sdk53.json" ]] || die "_deltas/package.sdk53.json missing"
[[ -f "$DELTAS_DIR/app.config.ts" ]] || die "_deltas/app.config.ts missing"

# 1. scaffold
log "Creating fresh Expo SDK 53 scaffold in _mobile-fresh/"
rm -rf "$FRESH_DIR"
npx --yes create-expo-app@latest "$FRESH_DIR" \
  --template "$TEMPLATE" \
  --no-install \
  || die "create-expo-app failed (registry unreachable? SDK 53 tag withdrawn?)"
ok "scaffold created with $TEMPLATE"

# 2. overwrite package.json with our pinned SDK 53 manifest
log "Overwriting package.json with _deltas/package.sdk53.json"
cp "$DELTAS_DIR/package.sdk53.json" "$FRESH_DIR/package.json"
ok "package.json pinned to SDK 53"

# 3. migrate deltas
log "Migrating deltas into scaffold"
rm -rf "$FRESH_DIR/app" "$FRESH_DIR/src" \
       "$FRESH_DIR/app.config.ts" "$FRESH_DIR/app.config.js" "$FRESH_DIR/app.json" \
       "$FRESH_DIR/babel.config.js" "$FRESH_DIR/metro.config.js" \
       "$FRESH_DIR/tsconfig.json" "$FRESH_DIR/eas.json" "$FRESH_DIR/.env.example"
cp -R "$DELTAS_DIR/app"  "$FRESH_DIR/app"
cp -R "$DELTAS_DIR/src"  "$FRESH_DIR/src"
cp "$DELTAS_DIR/.env.example"    "$FRESH_DIR/.env.example"
cp "$DELTAS_DIR/app.config.ts"   "$FRESH_DIR/app.config.ts"
cp "$DELTAS_DIR/babel.config.js" "$FRESH_DIR/babel.config.js"
cp "$DELTAS_DIR/metro.config.js" "$FRESH_DIR/metro.config.js"
cp "$DELTAS_DIR/tsconfig.json"   "$FRESH_DIR/tsconfig.json"
cp "$DELTAS_DIR/eas.json"        "$FRESH_DIR/eas.json"
ok "deltas migrated"

# 4. install (NO expo install --fix)
log "npm install  (no expo install --fix — SDK 53 is locked)"
( cd "$FRESH_DIR" && rm -rf node_modules package-lock.json && npm install --no-audit --no-fund ) \
  || die "npm install failed — read the ERESOLVE trace above"
ok "deps installed"

# 5. prebuild
log "npx expo prebuild --clean"
( cd "$FRESH_DIR" && npx --yes expo prebuild --clean ) \
  || die "prebuild failed — read the trace above"
ok "prebuild succeeded"

# 6. verify MainApplication
log "Verifying MainApplication"
MAIN_APP=""
for ext in kt java; do
  cand="$FRESH_DIR/android/app/src/main/java/$ANDROID_PKG_PATH/MainApplication.$ext"
  [[ -f "$cand" ]] && MAIN_APP="$cand" && break
done
[[ -n "$MAIN_APP" ]] || die "MainApplication.{kt,java} NOT found at $ANDROID_PKG_PATH"
ok "$MAIN_APP"

# 7. promote
if [[ "$PROMOTE" -eq 1 ]]; then
  log "Promoting _mobile-fresh/ -> mobile/"
  TS="$(date +%Y%m%d-%H%M%S)"
  if [[ -d "$MOBILE_DIR" ]]; then
    mv "$MOBILE_DIR" "$ROOT_DIR/mobile.old-$TS"
    ok "archived old mobile/ as mobile.old-$TS/"
    if [[ -f "$ROOT_DIR/mobile.old-$TS/.env" ]]; then
      cp "$ROOT_DIR/mobile.old-$TS/.env" "$FRESH_DIR/.env" && ok "copied .env across"
    fi
  fi
  mv "$FRESH_DIR" "$MOBILE_DIR"
  ok "mobile/ is now the fresh SDK 53 scaffold"
  printf '\n\033[1;32mDone.\033[0m Next:\n'
  printf '    cd mobile\n'
  printf '    npx expo run:android\n\n'
else
  printf '\n\033[1;33mDry run complete.\033[0m\n'
  printf 'Next: bash rebuild-mobile.sh --promote\n\n'
fi
