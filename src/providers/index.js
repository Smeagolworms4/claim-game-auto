import epic from './epic.js';
import steam from './steam.js';
import gog from './gog.js';
import prime from './prime.js';
import legacy from './legacy.js';

/**
 * Un handler par plateforme. Chacun déclare ce qu'il sait faire, toutes les
 * fonctions étant optionnelles :
 *
 *   isLoggedIn(page)      → bool           état de la session
 *   list(page)            → [offer]        offres gratuites détectées
 *   claim(page, offer)    → { status }     récupérer (« keep ») une offre
 *   addKey(page, code)    → { status }     activer une clé sur ce store
 *
 * Un store peut donc être source d'offres (epic, steam, gog, prime), cible
 * d'activation de clés (gog, steam, epic, legacy), ou les deux.
 */
export const providers = { epic, steam, gog, prime, legacy };

export const getProvider = (name) => providers[String(name).toLowerCase()] || null;

export const allNames = Object.keys(providers);

/** Providers capables de fournir des offres (utilisés par les runs). */
export const claimableNames = allNames.filter((n) => typeof providers[n].list === 'function');

/** Providers capables d'activer une clé. */
export const redeemableNames = allNames.filter((n) => typeof providers[n].addKey === 'function');

export const capabilities = (name) => {
  const p = getProvider(name);
  if (!p) return [];
  return ['list', 'claim', 'addKey'].filter((fn) => typeof p[fn] === 'function');
};
