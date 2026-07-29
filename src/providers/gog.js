import { config } from '../config.js';
import { makeLogger } from '../logger.js';
import { clickFirst, sleep } from '../browser.js';

const log = makeLogger('gog');

const HOME = 'https://www.gog.com/en';
const CLAIM = 'https://www.gog.com/giveaway/claim';

export default {
  name: 'gog',
  label: 'GOG',
  loginUrl: 'https://login.gog.com/auth?client_id=46899977096215655&redirect_uri=https%3A%2F%2Fwww.gog.com%2Fon_login_success&response_type=code&layout=default',
  homeUrl: 'https://www.gog.com/',

  async isLoggedIn(page) {
    // C'est l'endpoint qu'utilise le header de GOG : réponse binaire et fiable,
    // là où un sélecteur DOM dépend d'une refonte du site.
    try {
      const res = await page.request.get('https://menu.gog.com/v1/account/basic', { timeout: 15000 });
      if (res.ok()) {
        const body = await res.json();
        if (typeof body?.isLoggedIn === 'boolean') {
          if (body.username) log.debug('compte GOG:', body.username);
          return body.isLoggedIn;
        }
      }
      log.warn(`API compte GOG inattendue (HTTP ${res.status()}), repli sur le DOM`);
    } catch (err) {
      log.warn('API compte GOG injoignable:', err.message);
    }

    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    return page.locator('#menuUsername').first().isVisible({ timeout: 5000 }).catch(() => false);
  },

  /**
   * GOG n'a pas d'API publique de giveaway : la bannière #giveaway sur la home
   * est la seule source. Il y a au plus une offre à la fois.
   */
  async list(page) {
    if (!page.url().startsWith(HOME)) {
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    }
    const banner = page.locator('#giveaway').first();
    if (!(await banner.isVisible({ timeout: 8000 }).catch(() => false))) return [];

    const raw =
      (await banner.locator('.giveaway__content-header').first().textContent().catch(() => '')) ||
      (await banner.textContent().catch(() => '')) ||
      'Giveaway GOG';
    const title = raw
      .replace(/claim|réclamer|don't miss out|success/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const href = await banner.locator('a').first().getAttribute('href').catch(() => null);

    return [
      {
        id: (href || title).replace(/^https?:\/\/[^/]+/, ''),
        title: title || 'Giveaway GOG',
        url: href ? (href.startsWith('http') ? href : `https://www.gog.com${href}`) : HOME,
      },
    ];
  },

  /**
   * Active une clé GOG (typiquement issue d'une offre Prime Gaming).
   * L'API de redeem renvoie un motif exploitable : code déjà utilisé,
   * inexistant, ou captcha.
   */
  async addKey(page, code) {
    if (config.dryRun) return { status: 'dry-run' };

    const reasons = [];
    const onResponse = async (res) => {
      if (!res.url().includes('redeem.gog.com/v1/bonusCodes')) return;
      const body = await res.json().catch(() => null);
      if (body?.reason) reasons.push(body.reason);
      log.debug('redeem API', res.status(), JSON.stringify(body || {}).slice(0, 120));
    };
    page.on('response', onResponse);

    try {
      await page.goto(`https://www.gog.com/redeem/${encodeURIComponent(code)}`, {
        waitUntil: 'domcontentloaded',
      });
      await sleep(3000);

      const clicked = await clickFirst(page, [
        'button:has-text("Redeem")',
        'button:has-text("Utiliser")',
        'button:has-text("Continue")',
        '[data-test="redeem-button"]',
      ], { timeout: 10000 });
      await sleep(4000);

      if (reasons.includes('captcha')) {
        return { status: 'captcha', message: 'captcha GOG — active la clé via le VNC' };
      }
      if (reasons.includes('code_used')) return { status: 'owned', message: 'clé déjà utilisée' };
      if (reasons.includes('code_not_found')) return { status: 'error', message: 'clé inconnue' };

      const body = (await page.locator('body').innerText().catch(() => '')) || '';
      if (/added to your account|ajouté à votre compte|success/i.test(body)) {
        return { status: 'claimed' };
      }
      if (!clicked) return { status: 'unknown', message: 'bouton de redeem introuvable' };
      return { status: 'unknown', message: body.replace(/\s+/g, ' ').slice(0, 120) };
    } finally {
      page.off('response', onResponse);
    }
  },

  async claim(page, offer) {
    if (config.dryRun) return { status: 'dry-run' };

    // L'endpoint de claim répond en JSON : {} = ok, {message:"Already claimed"} = déjà pris.
    const res = await page.goto(CLAIM, { waitUntil: 'domcontentloaded' });
    const body = (await page.locator('body').textContent().catch(() => '')) || '';
    log.debug('réponse claim:', body.slice(0, 200));

    let json = null;
    try {
      json = JSON.parse(body.trim());
    } catch {
      /* réponse non JSON */
    }

    if (json && Object.keys(json).length === 0) return { status: 'claimed' };
    if (json?.message === 'Already claimed') return { status: 'owned' };
    if (res && !res.ok()) return { status: 'error', message: `HTTP ${res.status()}` };
    return { status: 'unknown', message: body.slice(0, 120) || 'réponse vide' };
  },
};
