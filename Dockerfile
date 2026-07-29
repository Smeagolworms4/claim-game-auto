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

# Vrai Google Chrome en plus du Chromium de Playwright : beaucoup moins
# challengé par Cloudflare (marques « Google Chrome », codecs, Widevine).
RUN npx playwright install chrome && rm -rf /root/.cache/ms-playwright-tmp

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
