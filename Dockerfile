# Image officielle Playwright : navigateurs + dépendances système déjà présents.
# La version DOIT correspondre à celle de package.json.
FROM mcr.microsoft.com/playwright:v1.62.0-noble

ENV DEBIAN_FRONTEND=noninteractive

# Xvfb (affichage virtuel) + x11vnc/noVNC pour reprendre la main sur le
# navigateur lors des connexions manuelles (mot de passe, 2FA, captcha).
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify openbox x11-utils tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Chromium seul par défaut : disponible sur amd64 comme sur arm64, donc même
# comportement partout (Google Chrome, lui, n'est publié qu'en amd64).
# Escape hatch pour amd64 : docker compose build --build-arg INSTALL_CHROME=true
ARG INSTALL_CHROME=false
RUN npx playwright install chromium \
    && if [ "$INSTALL_CHROME" = "true" ] && [ "$(dpkg --print-architecture)" = "amd64" ]; then \
         npx playwright install chrome; \
       fi \
    && rm -rf /root/.cache/ms-playwright-tmp

COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    DATA_DIR=/data \
    DISPLAY=:99 \
    WEB_PORT=8080 \
    NOVNC_PORT=6080 \
    VNC_PORT=5900 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

VOLUME ["/data"]
EXPOSE 8080 6080 5900

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js", "daemon"]
