import { makeLogger } from './logger.js';
import { launchContext, newPage } from './browser.js';
import { getProvider } from './providers/index.js';
import { withLock } from './lock.js';

const log = makeLogger('cookies');

// Domaine par défaut quand on importe un simple "a=b; c=d" sans domaine.
const DEFAULT_DOMAIN = {
  epic: '.epicgames.com',
  steam: '.steampowered.com',
  gog: '.gog.com',
  prime: '.amazon.com',
  legacy: '.legacygames.com',
};

const SAME_SITE = {
  no_restriction: 'None',
  none: 'None',
  lax: 'Lax',
  strict: 'Strict',
  unspecified: 'Lax',
};

/**
 * Normalise vers le format attendu par Playwright.
 * Accepte l'export JSON des extensions type Cookie-Editor / EditThisCookie,
 * ou une simple chaîne "nom=valeur; nom2=valeur2".
 */
export function parseCookies(input, provider) {
  const fallbackDomain = DEFAULT_DOMAIN[provider] || '';
  let raw = input;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      raw = JSON.parse(trimmed);
    } else {
      // Format "document.cookie"
      raw = trimmed
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const idx = part.indexOf('=');
          if (idx < 1) return null;
          return { name: part.slice(0, idx).trim(), value: part.slice(idx + 1).trim() };
        })
        .filter(Boolean);
    }
  }

  const list = Array.isArray(raw) ? raw : raw?.cookies || [];
  const out = [];

  for (const c of list) {
    if (!c?.name || c.value === undefined || c.value === null) continue;
    const domain = (c.domain || fallbackDomain).trim();
    if (!domain) continue;

    const secure = c.secure !== false;
    let sameSite = SAME_SITE[String(c.sameSite || '').toLowerCase()] || 'Lax';
    // SameSite=None exige secure: sinon le navigateur rejette le cookie.
    if (sameSite === 'None' && !secure) sameSite = 'Lax';

    const expires =
      typeof c.expirationDate === 'number'
        ? Math.floor(c.expirationDate)
        : typeof c.expires === 'number'
          ? Math.floor(c.expires)
          : -1; // cookie de session

    out.push({
      name: String(c.name),
      value: String(c.value),
      domain,
      path: c.path || '/',
      expires,
      httpOnly: Boolean(c.httpOnly),
      secure,
      sameSite,
    });
  }

  if (!out.length) throw new Error('aucun cookie exploitable dans l\'import');
  return out;
}

/**
 * Injecte des cookies dans le profil d'un store, puis vérifie si la session
 * est reconnue. Permet de se connecter depuis son propre navigateur (dont l'IP
 * et la réputation passent les challenges) et d'apporter la session ici.
 */
export async function importCookies(provider, input) {
  const handler = getProvider(provider);
  if (!handler) throw new Error(`provider inconnu: ${provider}`);
  const cookies = parseCookies(input, provider);

  return withLock(`cookies:${provider}`, async () =>
    // Headless suffit : on ne fait qu'écrire dans le profil.
    launchContext(provider, { headless: true }).then(async (context) => {
      try {
        await context.addCookies(cookies);
        log.info(`${cookies.length} cookie(s) importé(s) pour ${provider}`);

        let loggedIn = null;
        if (typeof handler.isLoggedIn === 'function') {
          loggedIn = await handler.isLoggedIn(await newPage(context)).catch(() => null);
        }
        return { imported: cookies.length, loggedIn };
      } finally {
        // Le close() est ce qui écrit le profil sur le volume.
        await context.close().catch(() => {});
      }
    }),
  );
}
