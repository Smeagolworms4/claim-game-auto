import { config } from './config.js';
import { makeLogger } from './logger.js';
import { launchContext, newPage } from './browser.js';
import { getProvider } from './providers/index.js';
import { acquire, release } from './lock.js';
import * as vnc from './vnc.js';

const log = makeLogger('login');

// Session de connexion manuelle : on ouvre un navigateur visible dans le Xvfb,
// l'utilisateur se logue (mot de passe + 2FA) via noVNC, puis on ferme
// proprement pour que le profil soit écrit sur le volume.
let session = null;

export const isActive = () => Boolean(session);

export function status() {
  if (!session) return { active: false, vnc: vnc.status() };
  return {
    active: true,
    provider: session.provider,
    label: session.label,
    startedAt: session.startedAt,
    vnc: vnc.status(),
  };
}

export async function start(name, { url = null } = {}) {
  const provider = getProvider(name);
  if (!provider) throw new Error(`provider inconnu: ${name}`);
  if (session) throw new Error(`session déjà ouverte pour ${session.provider}`);

  const done = acquire(`login:${name}`);
  try {
    await vnc.start();
    const context = await launchContext(name, { headless: false });
    const page = await newPage(context);
    // Sur un déblocage, on atterrit là où ça a coincé : résoudre le Turnstile
    // sur cette page dépose le cookie cf_clearance dans le profil, ce qui
    // débloque aussi les passages headless suivants.
    await page.goto(url || provider.loginUrl, { waitUntil: 'domcontentloaded' }).catch((err) => {
      log.warn('navigation login:', err.message);
    });

    session = {
      provider: name,
      label: provider.label,
      context,
      page,
      startedAt: new Date().toISOString(),
      release: done,
    };
    log.info(`session de login ouverte pour ${provider.label} — noVNC port ${config.novncPort}`);
    return status();
  } catch (err) {
    release(`login:${name}`);
    throw err;
  }
}

/** Ferme la session et vérifie si la connexion a bien été établie. */
export async function finish({ stopVnc = true } = {}) {
  if (!session) return { active: false, loggedIn: null };
  const { provider, context, page, release: done } = session;

  let loggedIn = null;
  try {
    loggedIn = await getProvider(provider).isLoggedIn(page);
  } catch (err) {
    log.warn('vérification connexion:', err.message);
  }

  await context.close().catch(() => {});
  session = null;
  done();
  if (stopVnc) vnc.stop();

  log.info(`session ${provider} fermée — connecté: ${loggedIn}`);
  return { active: false, provider, loggedIn };
}

export function keepAlive() {
  if (session) vnc.resetIdle();
}
