import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { config, browserFor } from './config.js';
import { makeLogger } from './logger.js';

const log = makeLogger('browser');

// Tout sauf firefox passe par le moteur Chromium (« chrome » = vrai Google
// Chrome, sélectionné via l'option channel).
const engine = (browser) => (browser === 'firefox' ? firefox : chromium);

/**
 * Un profil est lié à son moteur : si on change de navigateur pour un store,
 * on repart d'un profil propre plutôt que de mélanger des fichiers Firefox et
 * Chrome dans le même dossier.
 */
async function ensureProfileEngine(profileDir, browser) {
  const marker = path.join(profileDir, '.engine');
  const wanted = browser === 'firefox' ? 'firefox' : 'chromium';
  let current = null;
  try {
    current = (await fs.readFile(marker, 'utf8')).trim();
  } catch {
    /* premier lancement, ou profil d'avant le marqueur */
  }
  if (current && current !== wanted) {
    log.warn(`profil ${path.basename(profileDir)} : moteur ${current} → ${wanted}, reconnexion nécessaire`);
    await fs.rm(profileDir, { recursive: true, force: true });
  }
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(marker, wanted);
}

/**
 * Après un arrêt brutal, Chrome affiche « Chrome didn't shut down correctly »
 * et propose de restaurer les onglets — une bulle qui peut recouvrir le
 * formulaire de connexion. On remet les marqueurs de sortie propre.
 */
async function clearCrashFlags(profileDir) {
  for (const rel of ['Default/Preferences', 'Preferences']) {
    const file = path.join(profileDir, rel);
    try {
      const prefs = JSON.parse(await fs.readFile(file, 'utf8'));
      if (prefs.profile?.exit_type === 'Normal' && prefs.profile?.exited_cleanly === true) continue;
      prefs.profile = { ...(prefs.profile || {}), exit_type: 'Normal', exited_cleanly: true };
      await fs.writeFile(file, JSON.stringify(prefs));
      log.debug(`marqueurs de crash nettoyés : ${rel}`);
    } catch {
      /* pas de profil encore, ou JSON illisible */
    }
  }
}

/**
 * Chrome pose un SingletonLock nommé <hôte>-<pid> dans le profil. Si le
 * conteneur est tué sans fermeture propre, le verrou survit et référence un
 * hôte/pid qui n'existe plus : plus aucun lancement ne peut ouvrir le profil
 * (« The profile appears to be in use by another Google Chrome process »).
 * Nos accès étant sérialisés par lock.js, on peut purger sans risque.
 */
async function clearStaleLocks(profileDir) {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const file = path.join(profileDir, name);
    try {
      await fs.lstat(file);
      await fs.rm(file, { force: true });
      log.debug(`verrou orphelin retiré : ${path.basename(profileDir)}/${name}`);
    } catch {
      /* absent, tant mieux */
    }
  }
}

// En headless, Chromium s'annonce « HeadlessChrome/... » : c'est le signal
// anti-bot le plus évident. On reprend l'UA réel du binaire en retirant
// seulement « Headless », pour rester cohérent avec les client hints.
let cachedUA = null;
async function headlessUA() {
  if (cachedUA !== null) return cachedUA;
  try {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const ua = await (await browser.newPage()).evaluate(() => navigator.userAgent);
    await browser.close();
    cachedUA = ua.replace(/HeadlessChrome/g, 'Chrome');
  } catch (err) {
    log.warn('UA non déterminé:', err.message);
    cachedUA = '';
  }
  return cachedUA;
}

/**
 * Ouvre un contexte navigateur persistant dédié à un provider.
 * Le profil (cookies, session, 2FA validée) vit dans data/profiles/<provider> :
 * on se logue une seule fois à la main (via VNC), les runs suivants réutilisent
 * la session.
 */
export async function withContext(provider, fn, opts = {}) {
  const context = await launchContext(provider, opts);
  try {
    return await fn(context);
  } finally {
    await context.close().catch(() => {});
  }
}

/** Lance le contexte persistant (appelant responsable du close()). */
export async function launchContext(provider, { headless = config.headless } = {}) {
  const browser = browserFor(provider);
  const profileDir = path.join(config.profilesDir, provider);
  await ensureProfileEngine(profileDir, browser);

  const isChromium = browser !== 'firefox';
  if (isChromium) {
    await clearStaleLocks(profileDir);
    await clearCrashFlags(profileDir);
  }
  const opts = {
    headless,
    slowMo: config.slowMo,
    locale: config.locale,
    timezoneId: config.timezone,
    // En headed, viewport: null laisse la fenêtre dicter sa taille : window.screen,
    // innerWidth/Height et outerWidth/Height restent cohérents entre eux. Un
    // viewport imposé produit un écart écran/fenêtre qui sent l'automatisation.
    viewport: headless ? { width: 1440, height: 880 } : null,
    // Pas d'override d'User-Agent : un UA figé finit toujours par diverger de
    // la vraie version du navigateur (et des client hints), ce qui est
    // justement ce que les protections anti-bot repèrent.
    ignoreHTTPSErrors: true,
  };

  if (isChromium) {
    // Le vrai Google Chrome (channel) est bien moins challengé que le Chromium
    // livré avec Playwright : marques « Google Chrome », codecs propriétaires,
    // Widevine — autant de signaux que Cloudflare regarde.
    if (browser === 'chrome') opts.channel = 'chrome';

    // En headless seulement : l'UA annonce « HeadlessChrome ». On le nettoie,
    // mais uniquement là, car un UA forcé en mode headed diverge des client
    // hints (Sec-CH-UA) et c'est précisément ce qui fait boucler un challenge.
    if (headless) {
      const ua = await headlessUA();
      if (ua) opts.userAgent = ua;
    }

    // Retire la bannière/flag « contrôlé par un logiciel de test », qui est un
    // signal d'automatisation à part entière.
    opts.ignoreDefaultArgs = ['--enable-automation'];
    opts.args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--lang=${config.locale}`,
    ];
    // Fenêtre à la taille de l'écran Xvfb : évite le couple écran/fenêtre
    // incohérent, un classique des fingerprints d'automatisation.
    if (!headless) opts.args.push(`--window-size=${config.screen}`, '--window-position=0,0');
  } else {
    // Réduit les signaux d'automatisation les plus évidents côté Firefox.
    opts.firefoxUserPrefs = {
      'dom.webdriver.enabled': false,
      'useAutomationExtension': false,
      'media.peerconnection.enabled': false,
      'intl.accept_languages': config.locale.toLowerCase(),
      'browser.aboutConfig.showWarning': false,
    };
  }

  // En mode headed on force l'affichage sur le Xvfb du conteneur.
  const env = headless ? undefined : { ...process.env, DISPLAY: config.display };
  if (env) opts.env = env;

  const context = await engine(browser).launchPersistentContext(profileDir, opts);

  context.setDefaultTimeout(config.navTimeout);
  context.setDefaultNavigationTimeout(config.navTimeout);

  // Pas de patch de navigator.webdriver : redéfinir la propriété sur l'instance
  // (au lieu du prototype) laisse une trace détectable — le remède était pire
  // que le mal. On s'appuie sur les flags de lancement à la place.

  return context;
}

export async function newPage(context) {
  const [first] = context.pages();
  if (first && ['about:blank', ''].includes(first.url())) return first;
  return context.newPage();
}

export async function screenshot(page, provider, tag) {
  if (!config.screenshotOnError || !page) return null;
  try {
    await fs.mkdir(config.screenshotsDir, { recursive: true });
    const name = `${provider}-${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    await page.screenshot({ path: path.join(config.screenshotsDir, name) });
    log.debug('capture:', name);
    return name;
  } catch {
    return null;
  }
}

/** Clique le premier sélecteur visible parmi une liste de candidats. */
export async function clickFirst(page, selectors, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.isVisible({ timeout: 300 })) {
          await loc.click({ timeout: 5000 });
          return sel;
        }
      } catch {
        /* candidat suivant */
      }
    }
  }
  return null;
}

/**
 * Vrai si au moins un des sélecteurs est visible.
 * À utiliser au lieu de locator('a, b').first() : sur un sélecteur à virgules,
 * .first() peut retenir une occurrence cachée et masquer celle qui est visible.
 */
export async function anyVisible(page, selectors, { timeout = 5000 } = {}) {
  return Boolean(await waitAny(page, selectors, { timeout }));
}

/** Attend qu'un des sélecteurs devienne visible, renvoie lequel. */
export async function waitAny(page, selectors, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        if (await page.locator(sel).first().isVisible({ timeout: 300 })) return sel;
      } catch {
        /* suivant */
      }
    }
  }
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
