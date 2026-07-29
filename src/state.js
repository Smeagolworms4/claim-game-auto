import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { makeLogger } from './logger.js';

const log = makeLogger('state');

// Petit store JSON : mémorise ce qui a déjà été réclamé pour éviter de
// re-tenter (et re-notifier) les mêmes offres à chaque passage.
let cache = null;
let cacheMtime = 0;

const empty = () => ({ version: 1, claimed: {}, keys: {}, attention: {}, settings: {}, lastRun: null });

const mtimeOf = async (file) => {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
};

export async function load() {
  // Le fichier peut être écrit par un autre process (`docker compose run` en
  // parallèle du daemon) : on recharge dès que le mtime a bougé.
  const mtime = await mtimeOf(config.stateFile);
  if (cache && mtime === cacheMtime) return cache;
  try {
    cache = JSON.parse(await fs.readFile(config.stateFile, 'utf8'));
    if (!cache.claimed) cache.claimed = {};
    if (!cache.keys) cache.keys = {};
    if (!cache.attention) cache.attention = {};
    cacheMtime = mtime;
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('state illisible, réinitialisation:', err.message);
    cache = empty();
    cacheMtime = 0;
  }
  return cache;
}

export async function save() {
  if (!cache) return;
  await fs.mkdir(path.dirname(config.stateFile), { recursive: true });
  const tmp = `${config.stateFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, config.stateFile);
  cacheMtime = await mtimeOf(config.stateFile);
}

const key = (provider, id) => `${provider}:${id}`;

export async function isClaimed(provider, id) {
  const s = await load();
  return Boolean(s.claimed[key(provider, id)]);
}

export async function markClaimed(provider, id, meta = {}) {
  const s = await load();
  s.claimed[key(provider, id)] = { at: new Date().toISOString(), ...meta };
  await save();
}

export async function unmarkClaimed(provider, id) {
  const s = await load();
  if (!s.claimed[key(provider, id)]) return false;
  delete s.claimed[key(provider, id)];
  await save();
  return true;
}

export async function setLastRun(summary) {
  const s = await load();
  s.lastRun = { at: new Date().toISOString(), ...summary };
  await save();
}

// --- Clés à activer ----------------------------------------------------
// Les offres Prime/Luna donnent souvent une clé à activer sur un store
// partenaire (GOG, Legacy Games, Epic, Microsoft). On les garde ici pour
// pouvoir réessayer et ne jamais perdre un code.
export async function addKey({ code, target, title, from = 'prime', url = null, redeemUrl = null }) {
  if (!code) return null;
  const s = await load();
  if (!s.keys) s.keys = {};
  if (!s.keys[code]) {
    s.keys[code] = { code, target, title, from, url, redeemUrl, at: new Date().toISOString(), status: 'pending' };
    await save();
  }
  return s.keys[code];
}

// Statuts qui méritent une nouvelle tentative. « unknown » en fait partie :
// sinon une activation qui a échoué pour une raison transitoire (page pas
// chargée, bouton manqué, session à rafraîchir) restait bloquée pour toujours.
const RETRYABLE = new Set(['pending', 'unknown', 'captcha', 'error']);

export async function keys({ pendingOnly = false } = {}) {
  const s = await load();
  const list = Object.values(s.keys || {});
  return (pendingOnly ? list.filter((k) => RETRYABLE.has(k.status)) : list).sort((a, b) =>
    b.at.localeCompare(a.at),
  );
}

export async function updateKey(code, patch) {
  const s = await load();
  if (!s.keys?.[code]) return null;
  Object.assign(s.keys[code], patch, { updatedAt: new Date().toISOString() });
  await save();
  return s.keys[code];
}

// --- Préférences -------------------------------------------------------
// Réglages modifiables depuis l'interface. Les variables d'environnement
// servent de valeurs par défaut ; ce qui est enregistré ici les surcharge.
export async function settings() {
  const s = await load();
  return s.settings || {};
}

export async function saveSettings(patch) {
  const s = await load();
  s.settings = { ...(s.settings || {}), ...patch };
  await save();
  return s.settings;
}

// --- Demandes d'intervention -------------------------------------------
// Persistées (et pas seulement en mémoire) : un lien de déblocage envoyé par
// Discord ou SMS doit rester valide après un redémarrage du conteneur.
export async function saveAttention(token, entry) {
  const s = await load();
  if (!s.attention) s.attention = {};
  s.attention[token] = entry;
  await save();
  return entry;
}

export async function attentionAll() {
  const s = await load();
  return Object.entries(s.attention || {}).map(([token, e]) => ({ token, ...e }));
}

export async function dropAttention(tokens) {
  const s = await load();
  if (!s.attention) return;
  let changed = false;
  for (const t of tokens) {
    if (s.attention[t]) {
      delete s.attention[t];
      changed = true;
    }
  }
  if (changed) await save();
}

// --- Historique --------------------------------------------------------
// Journal des actions (rolling, plafonné) séparé de l'état, pour l'affichage
// dans l'interface : qui a été réclamé, quand, avec quel résultat.
let historyCache = null;

async function loadHistory() {
  if (historyCache) return historyCache;
  try {
    const raw = JSON.parse(await fs.readFile(config.historyFile, 'utf8'));
    historyCache = Array.isArray(raw) ? raw : [];
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('historique illisible:', err.message);
    historyCache = [];
  }
  return historyCache;
}

export async function addHistory(entry) {
  const list = await loadHistory();
  list.unshift({ at: new Date().toISOString(), ...entry });
  if (list.length > config.historyMax) list.length = config.historyMax;
  await fs.mkdir(path.dirname(config.historyFile), { recursive: true });
  const tmp = `${config.historyFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(list, null, 1));
  await fs.rename(tmp, config.historyFile);
}

export async function history(limit = 100) {
  return (await loadHistory()).slice(0, limit);
}

export async function stats() {
  const s = await load();
  const byProvider = {};
  for (const k of Object.keys(s.claimed)) {
    const p = k.split(':')[0];
    byProvider[p] = (byProvider[p] || 0) + 1;
  }
  return { total: Object.keys(s.claimed).length, byProvider, lastRun: s.lastRun };
}
