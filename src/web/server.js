import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, applySettings, snapshot, forcedSettings } from '../config.js';
import { makeLogger, recentLogs, logEvents } from '../logger.js';
import { runAll, detectAll, redeemPendingKeys, cancel, events as runnerEvents } from '../runner.js';
import { providers, allNames, capabilities } from '../providers/index.js';
import * as state from '../state.js';
import * as loginSession from '../login.js';
import * as vnc from '../vnc.js';
import * as lock from '../lock.js';
import { importCookies } from '../cookies.js';
import { notify } from '../notify.js';
import * as attention from '../attention.js';

const log = makeLogger('web');

// Fourni par le daemon pour reprogrammer le cron quand il change dans l'UI.
let rescheduleHook = null;
export const onReschedule = (fn) => {
  rescheduleHook = fn;
};
const here = path.dirname(fileURLToPath(import.meta.url));

// Cache des offres détectées, alimenté par les runs et les détections manuelles.
let lastDetection = { at: null, byProvider: {} };

// Progression en direct : l'interface n'attend plus la fin du run pour
// afficher la liste et les statuts.
runnerEvents.on('listed', ({ provider, offers, loggedIn }) => {
  lastDetection.byProvider[provider] = { offers, loggedIn, at: new Date().toISOString() };
  lastDetection.at = lastDetection.byProvider[provider].at;
});

runnerEvents.on('offer', ({ provider, entry }) => {
  const cache = lastDetection.byProvider[provider];
  if (!cache) return;
  const i = (cache.offers || []).findIndex((o) => o.id === entry.id);
  if (i >= 0) cache.offers[i] = entry;
  else cache.offers.push(entry);
  cache.at = new Date().toISOString();
});

runnerEvents.on('run', ({ results }) => {
  const at = new Date().toISOString();
  for (const r of results) {
    if (r.offers) lastDetection.byProvider[r.provider] = { offers: r.offers, loggedIn: r.loggedIn, at };
  }
  lastDetection.at = at;
});

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

const authorized = (req) => {
  if (!config.webUser && !config.webPassword) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  return user === config.webUser && pass === config.webPassword;
};

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case 'GET /api/status': {
      const st = await state.stats();
      return json(res, 200, {
        busy: lock.isBusy(),
        current: lock.current(),
        providers: config.providers.map((n) => ({
          name: n,
          label: providers[n]?.label || n,
          capabilities: capabilities(n),
          detected: lastDetection.byProvider[n] || null,
        })),
        available: allNames,
        pendingKeys: (await state.keys({ pendingOnly: true })).length,
        detectionAt: lastDetection.at,
        stats: st,
        schedule: { cron: config.cron, cronDetect: config.cronDetect, timezone: config.timezone },
        browser: config.browser,
        attention: await attention.pending(),
        login: loginSession.status(),
        vnc: vnc.status(),
        dryRun: config.dryRun,
      });
    }

    case 'GET /api/settings':
      return json(res, 200, { settings: snapshot(), forced: forcedSettings(), available: allNames });

    case 'POST /api/settings': {
      const patch = await readBody(req);
      const before = `${config.cron}|${config.cronDetect}`;
      const applied = applySettings(patch);
      // On ne persiste que ce qui n'est pas verrouillé par .env, sinon un
      // réglage fantôme resterait en base sans effet.
      const forced = forcedSettings();
      await state.saveSettings(
        Object.fromEntries(Object.entries(applied).filter(([k]) => !forced[k])),
      );
      // Le cron n'est relu qu'au (re)démarrage du job : on reprogramme.
      if (`${applied.cron}|${applied.cronDetect}` !== before) {
        rescheduleHook?.({ cron: applied.cron, cronDetect: applied.cronDetect });
      }
      log.info('réglages mis à jour');
      return json(res, 200, { settings: applied });
    }

    case 'GET /api/logs':
      return json(res, 200, { lines: recentLogs() });

    case 'POST /api/cookies/import': {
      const { provider, cookies } = await readBody(req);
      try {
        const result = await importCookies(provider, cookies);
        // On rafraîchit tout de suite l'état affiché, puis on liste les offres.
        const prev = lastDetection.byProvider[provider] || { offers: [] };
        lastDetection.byProvider[provider] = {
          ...prev,
          loggedIn: result.loggedIn,
          at: new Date().toISOString(),
        };
        if (result.loggedIn) {
          detectAll(provider).catch((err) => log.warn('détection post-import:', err.message));
        }
        return json(res, 200, result);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    case 'GET /api/attention':
      return json(res, 200, { pending: await attention.pending(), all: await attention.list() });

    case 'POST /api/claimed': {
      // Un jeu récupéré à la main (typiquement quand un captcha bloque le
      // claim automatique) : on l'enregistre pour ne plus le retenter.
      const { provider, id, title, url } = await readBody(req);
      if (!provider || !id) return json(res, 400, { error: 'provider et id requis' });
      await state.markClaimed(provider, id, { title, url, manual: true });
      await state.addHistory({ provider, title, url, status: 'claimed', message: 'marqué à la main' });
      const cached = lastDetection.byProvider[provider];
      const offer = cached?.offers?.find((o) => o.id === id);
      if (offer) {
        offer.claimedBefore = true;
        offer.status = 'owned';
      }
      log.info(`${provider} : « ${title || id} » marqué comme réclamé`);
      return json(res, 200, { ok: true });
    }

    case 'POST /api/unclaimed': {
      // Symétrique du marquage manuel : sert à corriger un faux « possédé »
      // pour que l'offre soit de nouveau tentée.
      const { provider, id } = await readBody(req);
      if (!provider || !id) return json(res, 400, { error: 'provider et id requis' });
      const removed = await state.unmarkClaimed(provider, id);
      const offer = lastDetection.byProvider[provider]?.offers?.find((o) => o.id === id);
      if (offer) {
        offer.claimedBefore = false;
        delete offer.status;
      }
      log.info(`${provider} : « ${id} » remis en attente`);
      return json(res, 200, { removed });
    }

    case 'POST /api/notify/test': {
      // Vérifie la chaîne de notification de bout en bout, avec le lien de
      // l'interface pour contrôler que PUBLIC_URL est correct.
      const link = config.publicUrl || `http://localhost:${config.webPort}`;
      const result = await notify(
        '🔔 claim-auto — test',
        [
          'Ceci est une notification de test.',
          `Interface : ${link}`,
          config.publicUrl ? '' : '(PUBLIC_URL non défini : ce lien ne marchera que depuis cette machine)',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      log.info(
        'notification de test —',
        `envoyée: ${result.sent.join(', ') || 'aucun'}`,
        result.failed.length ? `| échecs: ${result.failed.map((f) => f.channel).join(', ')}` : '',
      );
      return json(res, 200, { ...result, link });
    }

    case 'POST /api/cancel':
      return json(res, 200, cancel());

    case 'POST /api/attention/dismiss': {
      const { token } = await readBody(req);
      if (!token) return json(res, 400, { error: 'jeton manquant' });
      await state.dropAttention([token]);
      log.info('demande d\'intervention écartée');
      return json(res, 200, { dismissed: true });
    }

    case 'GET /api/keys':
      return json(res, 200, { keys: await state.keys() });

    case 'POST /api/keys/redeem': {
      redeemPendingKeys().catch((err) => log.error('activation clés:', err.message));
      return json(res, 202, { started: true });
    }

    case 'GET /api/history':
      return json(res, 200, { entries: await state.history(Number(url.searchParams.get('limit')) || 100) });

    case 'POST /api/detect': {
      const { provider } = await readBody(req);
      detectAll(provider || null).catch((err) => log.error('détection:', err.message));
      return json(res, 202, { started: true });
    }

    case 'POST /api/run': {
      const { provider } = await readBody(req);
      runAll({ claim: true, only: provider || null }).catch((err) => log.error('run:', err.message));
      return json(res, 202, { started: true });
    }

    case 'POST /api/login/start': {
      const { provider } = await readBody(req);
      try {
        return json(res, 200, await loginSession.start(provider));
      } catch (err) {
        return json(res, 409, { error: err.message });
      }
    }

    case 'POST /api/login/finish': {
      const result = await loginSession.finish();
      // On reflète tout de suite l'état de connexion dans l'UI, puis on relance
      // une détection pour peupler les offres du store fraîchement connecté.
      if (result.provider) {
        const prev = lastDetection.byProvider[result.provider] || { offers: [] };
        lastDetection.byProvider[result.provider] = {
          ...prev,
          loggedIn: result.loggedIn,
          at: new Date().toISOString(),
        };
        if (result.loggedIn) {
          detectAll(result.provider).catch((err) => log.warn('détection post-login:', err.message));
        }
      }
      return json(res, 200, result);
    }

    case 'POST /api/login/keepalive':
      loginSession.keepAlive();
      return json(res, 200, { ok: true });

    case 'POST /api/vnc/start':
      try {
        return json(res, 200, await vnc.start());
      } catch (err) {
        return json(res, 500, { error: err.message });
      }

    case 'POST /api/vnc/stop':
      return json(res, 200, vnc.stop());

    case 'GET /api/events': {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const onLine = (l) => send('log', l);
      const onOffer = ({ provider, entry }) =>
        send('progress', { provider, title: entry.title, status: entry.status, code: entry.code });
      const onListed = ({ provider }) => send('progress', { provider, listed: true });
      const onRun = (r) => send('run', { claimed: r.report.claimed, errors: r.report.errors });
      const onLock = (l) => send('lock', l || {});
      logEvents.on('line', onLine);
      runnerEvents.on('offer', onOffer);
      runnerEvents.on('listed', onListed);
      runnerEvents.on('run', onRun);
      lock.lockEvents.on('change', onLock);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        logEvents.off('line', onLine);
        runnerEvents.off('offer', onOffer);
        runnerEvents.off('listed', onListed);
        runnerEvents.off('run', onRun);
        lock.lockEvents.off('change', onLock);
      });
      return undefined;
    }

    default: {
      // /api/unlock/<token>/<action> : le jeton fait office d'identification,
      // c'est ce qui permet d'envoyer le lien par Discord/SMS.
      const unlock = url.pathname.match(/^\/api\/unlock\/([a-f0-9]{16,})\/(start|finish|keepalive)$/);
      if (unlock && req.method === 'POST') return handleUnlock(res, unlock[1], unlock[2]);
      return json(res, 404, { error: 'route inconnue' });
    }
  }
}

/** Ouvre / referme une session de déblocage désignée par son jeton. */
async function handleUnlock(res, token, action) {
  const entry = await attention.get(token);
  if (!entry) return json(res, 404, { error: 'lien inconnu ou expiré' });
  const label = providers[entry.provider]?.label || entry.provider;

  if (action === 'keepalive') {
    loginSession.keepAlive();
    return json(res, 200, { ok: true });
  }

  if (action === 'start') {
    try {
      const active = loginSession.status();
      if (!active.active || active.provider !== entry.provider) {
        await loginSession.start(entry.provider, { url: entry.url });
      }
      return json(res, 200, { provider: entry.provider, label, reason: entry.reason });
    } catch (err) {
      return json(res, 409, { error: err.message });
    }
  }

  // finish : on ferme la session, on marque la demande résolue, et on relance
  // le claim du store pour que l'automatisation reprenne toute seule.
  const result = await loginSession.finish();
  const prev = lastDetection.byProvider[entry.provider] || { offers: [] };
  lastDetection.byProvider[entry.provider] = {
    ...prev,
    loggedIn: result.loggedIn,
    at: new Date().toISOString(),
  };

  if (result.loggedIn) {
    await attention.resolve(token);
    log.info(`déblocage ${entry.provider} validé — reprise du claim`);
    runAll({ claim: true, only: entry.provider }).catch((err) => log.error('reprise:', err.message));
  }
  return json(res, 200, { ...result, label });
}

// Vue / Vuetify / icônes servis depuis node_modules : aucune dépendance à un
// CDN, l'interface fonctionne hors-ligne.
const NODE_MODULES = path.resolve(here, '../../node_modules');
const VENDOR = {
  '/vendor/vue.js': 'vue/dist/vue.global.prod.js',
  '/vendor/vuetify.js': 'vuetify/dist/vuetify.min.js',
  '/vendor/vuetify.css': 'vuetify/dist/vuetify.min.css',
  '/vendor/css/materialdesignicons.min.css': '@mdi/font/css/materialdesignicons.min.css',
};

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

async function serveVendor(res, urlPath) {
  let rel = VENDOR[urlPath];
  // Les polices sont référencées en ../fonts/ depuis le CSS de MDI.
  if (!rel && urlPath.startsWith('/vendor/fonts/')) {
    rel = `@mdi/font/fonts/${path.basename(urlPath)}`;
  }
  if (!rel) return res.writeHead(404).end('Not found');

  try {
    const data = await fs.readFile(path.join(NODE_MODULES, rel));
    res.writeHead(200, {
      'content-type': MIME[path.extname(rel)] || 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

async function serveStatic(res, urlPath) {
  const file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const full = path.join(here, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  try {
    const data = await fs.readFile(full);
    const type = MIME[path.extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

/**
 * noVNC est servi sous /vnc/ par le serveur web : un seul port à exposer,
 * et ça fonctionne tel quel derrière un reverse proxy.
 */
function proxyToNovnc(req, res, url) {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: config.novncPort,
      method: req.method,
      path: `${url.pathname.replace(/^\/vnc/, '') || '/'}${url.search}`,
      headers: { ...req.headers, host: `127.0.0.1:${config.novncPort}` },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('VNC non démarré');
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  const target = net.connect(config.novncPort, '127.0.0.1', () => {
    const path = req.url.replace(/^\/vnc/, '') || '/';
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    target.write(`GET ${path} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
}

export function startWebServer() {
  const server = http.createServer(async (req, res) => {
    // Les liens de déblocage portent leur propre secret (le jeton) : ils doivent
    // rester ouvrables depuis une notification, sans l'auth basique.
    const isUnlock = req.url.startsWith('/unlock/') || req.url.startsWith('/api/unlock/');
    if (!isUnlock && !authorized(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="claim-auto"' }).end('Auth requise');
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (url.pathname.startsWith('/unlock/')) await serveStatic(res, '/unlock.html');
      else if (url.pathname.startsWith('/vnc/')) proxyToNovnc(req, res, url);
      else if (url.pathname.startsWith('/vendor/')) await serveVendor(res, url.pathname);
      else if (url.pathname.startsWith('/screenshots/')) {
        const name = path.basename(url.pathname);
        try {
          const data = await fs.readFile(path.join(config.screenshotsDir, name));
          res.writeHead(200, { 'content-type': 'image/png' }).end(data);
        } catch {
          res.writeHead(404).end();
        }
      } else await serveStatic(res, url.pathname);
    } catch (err) {
      log.error(err.message);
      if (!res.headersSent) json(res, 500, { error: err.message });
    }
  });

  // noVNC ouvre son WebSocket sur /websockify (racine) ou /vnc/websockify
  // selon la configuration : on accepte les deux.
  server.on('upgrade', (req, socket, head) => {
    if (/^\/(vnc\/)?websockify/.test(req.url)) proxyUpgrade(req, socket, head);
    else socket.destroy();
  });

  server.listen(config.webPort, () => log.info(`interface web sur http://0.0.0.0:${config.webPort}`));
  return server;
}
