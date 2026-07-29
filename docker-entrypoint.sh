#!/usr/bin/env bash
set -e

DISPLAY="${DISPLAY:-:99}"
SCREEN_SIZE="${SCREEN_SIZE:-1600,1000}"
export DISPLAY SCREEN_SIZE

# Affichage virtuel toujours disponible : les runs sont headless, mais les
# sessions de login (et le VNC) ont besoin d'un X. x11vnc/noVNC, eux, ne sont
# démarrés qu'à la demande depuis l'interface web.
if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  Xvfb "$DISPLAY" -screen 0 "${SCREEN_SIZE//,/x}x24" -nolisten tcp >/dev/null 2>&1 &
  for _ in $(seq 1 20); do
    xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
    sleep 0.25
  done
  # Gestionnaire de fenêtres léger : sans lui, certaines popups de login
  # (Steam Guard, Amazon OTP) ne sont pas déplaçables/redimensionnables.
  openbox >/dev/null 2>&1 &
fi

mkdir -p "${DATA_DIR:-/data}"/{profiles,screenshots,home}

exec "$@"
