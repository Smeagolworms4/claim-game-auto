import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { makeLogger } from './logger.js';
import { notifyEvent } from './notify.js';
import * as state from './state.js';

const log = makeLogger('attention');

/**
 * « Demandes d'intervention » : quand un store réclame une action humaine
 * (captcha Cloudflare, session expirée, compte à lier), on crée un jeton et on
 * notifie l'utilisateur avec un lien qui ouvre directement le VNC sur ce store.
 * Une fois débloqué, le claim de ce store est relancé automatiquement.
 *
 * Les demandes sont persistées dans data/state.json : un lien reçu par SMS doit
 * rester valide même après un redémarrage du conteneur.
 */
const REASONS = {
  captcha: 'un captcha bloque la connexion',
  'login-required': 'la session est expirée, reconnexion nécessaire',
  manual: 'une action manuelle est nécessaire',
  unknown: 'une vérification est nécessaire',
};

const expired = (r) => Date.now() - new Date(r.at).getTime() > config.attentionTtl;

async function prune(entries) {
  const dead = entries.filter((r) => expired(r) || (r.resolvedAt && Date.now() - new Date(r.resolvedAt).getTime() > 3600_000));
  if (dead.length) await state.dropAttention(dead.map((r) => r.token));
  return entries.filter((r) => !dead.includes(r));
}

export async function list() {
  return prune(await state.attentionAll());
}

export async function pending() {
  return (await list()).filter((r) => !r.resolvedAt);
}

export async function get(token) {
  const all = await list();
  return all.find((r) => r.token === token) || null;
}

export async function resolve(token) {
  const entry = await get(token);
  if (!entry) return null;
  const { token: _t, ...rest } = entry;
  return state.saveAttention(token, { ...rest, resolvedAt: new Date().toISOString() });
}

export const urlFor = (token) =>
  config.publicUrl ? `${config.publicUrl}/unlock/${token}` : `/unlock/${token}`;

/**
 * Crée (ou réutilise) une demande pour un store et notifie l'utilisateur.
 * Une seule demande active par store, pour ne pas spammer à chaque run.
 */
export async function request(provider, reason, details = '', url = null) {
  const existing = (await pending()).find((r) => r.provider === provider);
  if (existing) {
    log.debug(`demande déjà en attente pour ${provider}`);
    return existing;
  }

  const token = randomBytes(16).toString('hex');
  const entry = { provider, reason, details, url, at: new Date().toISOString(), resolvedAt: null };
  await state.saveAttention(token, entry);

  const why = REASONS[reason] || reason;
  log.warn(`intervention requise sur ${provider} : ${why}`);

  await notifyEvent(
    'captcha',
    `🔓 ${provider} — intervention requise`,
    [
      `${why}${details ? ` (${details})` : ''}`,
      url ? `Page concernée (à faire à la main si tu préfères) : ${url}` : '',
      '',
      'Ouvre ce lien pour prendre la main sur le navigateur, débloquer, puis valider :',
      urlFor(token),
      config.publicUrl ? '' : '(définis PUBLIC_URL pour recevoir un lien complet)',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  return { token, ...entry };
}
