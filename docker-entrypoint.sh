#!/usr/bin/env bash
set -e

DISPLAY="${DISPLAY:-:99}"
SCREEN_SIZE="${SCREEN_SIZE:-1600,1000}"
export DISPLAY SCREEN_SIZE

# Affichage virtuel toujours disponible : les runs sont headless, mais les
# sessions de login (et le VNC) ont besoin d'un X. x11vnc/noVNC, eux, ne sont
# démarrés qu'à la demande depuis l'interface web.
if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  # Un `docker restart` conserve le système de fichiers : le verrou du X
  # precedent traine dans /tmp et Xvfb refuse de demarrer (« server already
  # active »), ce qui casse tous les lancements en mode affiche. Comme aucun X
  # ne tourne (le test ci-dessus vient d'echouer), le verrou est forcement mort.
  rm -f "/tmp/.X${DISPLAY#:}-lock" "/tmp/.X11-unix/X${DISPLAY#:}" 2>/dev/null || true

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
