import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { makeLogger } from './logger.js';
import { withContext, newPage, screenshot } from './browser.js';
import { getProvider } from './providers/index.js';
import * as state from './state.js';
import { notifyEvent, formatReport } from './notify.js';
import { withLock } from './lock.js';
import * as attention from './attention.js';

const log = makeLogger('runner');

export const events = new EventEmitter();

const CLAIMED_STATUSES = new Set(['claimed']);

/**
 * Passe sur un provider : détecte les offres, et les réclame si claim=true.
 */
async function runProvider(name, { claim = true } = {}) {
  const provider = getProvider(name);
  if (!provider) return { provider: name, status: 'error', error: 'provider inconnu' };
  // Un handler d'activation seule (Legacy Games) n'a rien à lister.
  if (typeof provider.list !== 'function') {
    return { provider: name, label: provider.label, status: 'skipped', reason: 'activation de clés uniquement' };
  }
  const plog = log.child(name);

  return withContext(name, async (context) => {
    const page = await newPage(context);
    const result = { provider: name, label: provider.label, status: 'ok', offers: [], claimed: [], seen: 0 };

    try {
      const logged = await provider.isLoggedIn(page);
      result.loggedIn = logged;
      if (!logged) plog.warn("non connecté — login requis via l'interface web (VNC)");

      // La détection reste utile sans session (Epic notamment) : on liste
      // toujours ce qu'on peut, on ne bloque que le claim.
      let offers = [];
      try {
        offers = await provider.list(page);
      } catch (err) {
        if (!logged) return { ...result, status: 'skipped', reason: 'non connecté' };
        throw err;
      }
      result.seen = offers.length;
      plog.info(`${offers.length} offre(s) détectée(s)`);

      if (claim && !logged) {
        // On prévient l'utilisateur avec un lien qui ouvre le VNC sur ce store.
        await attention.request(name, 'login-required').catch((err) => plog.warn(err.message));
        return { ...result, status: 'skipped', reason: 'non connecté' };
      }

      for (const offer of offers) {
        const already = await state.isClaimed(name, offer.id);
        const entry = { ...offer, claimedBefore: already };
        result.offers.push(entry);

        if (!claim) continue;
        if (already) {
          plog.debug('déjà réclamé:', offer.title);
          entry.status = 'owned';
          continue;
        }

        try {
          plog.info('claim:', offer.title);
          const res = await provider.claim(page, offer);
          entry.status = res.status;
          entry.message = res.message;
          if (res.code) entry.code = res.code;

          await state.addHistory({
            provider: name,
            title: offer.title,
            url: offer.url,
            status: res.status,
            message: res.message,
            code: res.code,
          });

          // Une clé récupérée est mise de côté : elle doit être activée sur le
          // store partenaire, éventuellement plus tard.
          if (res.code) {
            await state.addKey({
              code: res.code,
              target: res.target,
              title: offer.title,
              from: name,
              url: offer.url,
            });
          }

          if (CLAIMED_STATUSES.has(res.status)) {
            await state.markClaimed(name, offer.id, { title: offer.title, url: offer.url, code: res.code });
            result.claimed.push({ title: offer.title, url: offer.url, code: res.code });
            plog.info('✅', offer.title);
          } else if (res.status === 'owned') {
            await state.markClaimed(name, offer.id, { title: offer.title, url: offer.url, owned: true });
            plog.info('déjà dans la bibliothèque:', offer.title);
          } else {
            plog.warn(`${offer.title} → ${res.status}${res.message ? ` (${res.message})` : ''}`);
            if (['captcha', 'unknown', 'manual'].includes(res.status)) {
              entry.screenshot = await screenshot(page, name, res.status);
            }
            if (['captcha', 'manual'].includes(res.status)) {
              await attention
                .request(
                  name,
                  res.status,
                  `${offer.title}${res.message ? ` — ${res.message}` : ''}`,
                  offer.url,
                )
                .catch((err) => plog.warn(err.message));
            }
          }
        } catch (err) {
          entry.status = 'error';
          entry.message = err.message;
          entry.screenshot = await screenshot(page, name, 'error');
          await state.addHistory({
            provider: name,
            title: offer.title,
            url: offer.url,
            status: 'error',
            message: err.message,
          });
          plog.error('échec claim', offer.title, '→', err.message);
        }
      }
      return result;
    } catch (err) {
      plog.error(err.message);
      await screenshot(page, name, 'fatal');
      return { ...result, status: 'error', error: err.message };
    }
  });
}

/**
 * Active une clé sur son store cible, dans le contexte navigateur de ce store
 * (une clé GOG a besoin de la session GOG, pas de celle d'Amazon).
 */
/** Page d'activation de clé, par store. */
export function redeemUrl(target) {
  return {
    gog: 'https://www.gog.com/redeem',
    steam: 'https://store.steampowered.com/account/registerkey',
    epic: 'https://store.epicgames.com/redeem',
    legacy: 'https://legacygames.com/primedeal',
    microsoft: 'https://account.microsoft.com/billing/redeem',
  }[target] || null;
}

async function redeemKey(key) {
  const target = getProvider(key.target);
  if (!target || typeof target.addKey !== 'function') {
    await state.updateKey(key.code, {
      status: 'manual',
      message: key.target ? `activation ${key.target} non automatisée` : 'store cible inconnu',
    });
    return { status: 'manual' };
  }

  const klog = log.child(key.target);
  return withContext(key.target, async (context) => {
    const page = await newPage(context);
    try {
      // Les handlers d'activation seule (Legacy) n'ont pas de session : on les
      // laisse répondre eux-mêmes, leur message est plus précis.
      if (!target.redeemOnly && typeof target.isLoggedIn === 'function' && !(await target.isLoggedIn(page))) {
        await state.updateKey(key.code, { status: 'pending', message: `connexion ${key.target} requise` });
        klog.warn(`clé ${key.title} en attente : connexion ${key.target} requise`);
        return { status: 'skipped' };
      }

      const res = await target.addKey(page, key.code);
      const done = ['claimed', 'owned'].includes(res.status);
      await state.updateKey(key.code, {
        status: done ? 'redeemed' : res.status === 'dry-run' ? 'pending' : res.status,
        message: res.message,
      });
      await state.addHistory({
        provider: key.target,
        title: key.title,
        status: res.status,
        message: `activation clé${res.message ? ` — ${res.message}` : ''}`,
        code: key.code,
      });
      if (done) {
        klog.info('🔑 clé activée:', key.title);
      } else {
        klog.warn(`clé ${key.title} → ${res.status}${res.message ? ` (${res.message})` : ''}`);
        // Clé non activable automatiquement : on l'envoie avec le lien du store
        // pour pouvoir la coller à la main.
        await notifyEvent(
          'failure',
          `🔑 Clé à activer à la main — ${key.title}`,
          [`Store : ${key.target || 'inconnu'}`, `Clé : ${key.code}`, redeemUrl(key.target) || '']
            .filter(Boolean)
            .join('\n'),
        );
      }
      return res;
    } catch (err) {
      await state.updateKey(key.code, { status: 'error', message: err.message });
      klog.error('activation clé:', err.message);
      return { status: 'error', message: err.message };
    }
  });
}

/** Active toutes les clés en attente (appelé après un run, ou depuis l'UI). */
export async function redeemPendingKeys({ lock = true } = {}) {
  const pending = await state.keys({ pendingOnly: true });
  if (!pending.length) return [];
  const work = async () => {
    log.info(`${pending.length} clé(s) à activer`);
    const out = [];
    for (const key of pending) out.push({ key, result: await redeemKey(key) });
    return out;
  };
  return lock ? withLock('redeem', work) : work();
}

/** Run complet sur tous les providers configurés. */
export async function runAll({ claim = true, only = null } = {}) {
  const names = (only ? [only] : config.providers).filter(Boolean);

  return withLock(claim ? 'run' : 'detect', async () => {
    log.info(`démarrage (${claim ? 'claim' : 'détection'}) :`, names.join(', '));
    const results = [];
    for (const name of names) {
      try {
        results.push(await runProvider(name, { claim }));
      } catch (err) {
        results.push({ provider: name, status: 'error', error: err.message });
      }
    }

    // Les clés récoltées pendant le run sont activées dans la foulée, sur le
    // store cible (on est déjà sous le verrou, d'où lock: false).
    if (claim && config.autoRedeemKeys) {
      await redeemPendingKeys({ lock: false }).catch((err) => log.warn('activation clés:', err.message));
    }

    const report = formatReport(results);
    await state.setLastRun({ providers: names, claimed: report.claimed, errors: report.errors, results });
    log.info(`terminé — ${report.claimed} jeu(x) réclamé(s), ${report.errors} erreur(s)`);

    if (claim) {
      // Deux catégories distinctes : le compte rendu du claim, et l'échec.
      if (report.errors > 0) {
        await notifyEvent('failure', `⚠️ claim-auto — ${report.errors} échec(s)`, report.body);
      }
      if (report.claimed > 0 || config.notifyOnNothing) {
        await notifyEvent(
          'claim',
          report.claimed ? `🎮 ${report.claimed} jeu(x) réclamé(s)` : 'claim-auto — rapport',
          report.body,
        );
      }
      await notifyAvailable(results);
    }
    events.emit('run', { results, report });
    return { results, report };
  });
}

/**
 * Notifie la liste des jeux gratuits repérés (catégorie « available »), en
 * n'annonçant que ceux qui ne sont pas encore réclamés.
 */
async function notifyAvailable(results) {
  const lines = [];
  for (const r of results) {
    const fresh = (r.offers || []).filter((o) => !o.claimedBefore && o.status !== 'owned');
    if (fresh.length) {
      lines.push(`${(r.label || r.provider).toUpperCase()} : ${fresh.map((o) => o.title).join(', ')}`);
    }
  }
  if (!lines.length) return;
  await notifyEvent('available', '🎁 Jeux gratuits disponibles', lines.join('\n'));
}

/** Détection seule, pour alimenter l'interface web. */
export const detectAll = (only = null) => runAll({ claim: false, only });

/** État de connexion de chaque provider (une passe navigateur par provider). */
export async function checkLogins(names = config.providers) {
  return withLock('check-logins', async () => {
    const out = {};
    for (const name of names) {
      const provider = getProvider(name);
      if (!provider) continue;
      try {
        out[name] = await withContext(name, async (ctx) => provider.isLoggedIn(await newPage(ctx)));
      } catch (err) {
        log.warn(`check login ${name}:`, err.message);
        out[name] = false;
      }
    }
    return out;
  });
}

export { runProvider };
