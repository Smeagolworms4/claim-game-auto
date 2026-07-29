import { config } from '../config.js';
import { makeLogger } from '../logger.js';
import { clickFirst, sleep } from '../browser.js';

const log = makeLogger('gog');

const HOME = 'https://www.gog.com/en';
const CLAIM = 'https://www.gog.com/giveaway/claim';

/** Ferme le bandeau de consentement s'il masque la page. */
async function dismissConsent(page) {
  const clicked = await clickFirst(page, [
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'button:has-text("Tout accepter")',
    'button:has-text("Accept all")',
    'button:has-text("Accepter tout")',
    'button:has-text("J\'accepte")',
    'button:has-text("Accept")',
  ], { timeout: 4000 });
  if (clicked) {
    log.debug('bandeau cookies fermé');
    await sleep(1500);
  }
}

export default {
  name: 'gog',
  label: 'GOG',
  // Pas d'URL OAuth codée en dur : le couple client_id/redirect_uri évolue et
  // un décalage donne un « redirect_uri mismatch » sur lequel la connexion ne
  // peut pas aboutir. On part de la home et on clique « Sign in », c'est GOG
  // qui fabrique l'URL valide.
  loginUrl: HOME,
  homeUrl: 'https://www.gog.com/',

  /**
   * Ouvre le formulaire de connexion. GOG ne l'expose pas comme une page mais
   * comme une modale déclenchée par le fragment ##openlogin (c'est là que
   * /account redirige) : on l'utilise directement, et le clic sur le bouton du
   * header ne sert que de repli.
   */
  async openLogin(page) {
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await clickFirst(page, ['button:has-text("Accept")', 'button:has-text("Tout accepter")'], { timeout: 3000 });

    // Le fragment doit être posé une fois la page chargée : présent dès l'URL
    // de départ, le routeur de GOG ne le voit pas passer.
    await page.evaluate(() => {
      window.location.hash = '#openlogin';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }).catch(() => {});
    await sleep(3000);

    const emailField = 'input[type="email"], #login_username, input[name*="email" i]';
    if (await page.locator(emailField).first().isVisible({ timeout: 8000 }).catch(() => false)) {
      return page.url();
    }
    log.debug('modale de login non ouverte, repli sur le bouton du header');
    // Le bouton visible du header est un <button> sans href, piloté en JS :
    // viser uniquement des <a href> ne matchait rien.
    const clicked = await clickFirst(page, [
      'button.menu-anonymous-header__btn:has-text("Sign in")',
      'button:has-text("Sign in")',
      'button:has-text("Se connecter")',
      'a[href*="login.gog.com"]',
      'a.menu-link--anonymous',
      '#menuLogin',
    ], { timeout: 12000 });
    if (!clicked) log.warn('lien « Sign in » introuvable sur la home');
    await sleep(3000);
    return page.url();
  },

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

      // Le bandeau cookies recouvre le bouton de validation : sans le fermer,
      // le clic n'atteint jamais « Continuer ».
      await dismissConsent(page);

      // La page de redeem est localisée : en français le bouton est
      // « Continuer », pas « Continue ». C'est ce qui faisait échouer
      // l'activation alors que la page s'affichait correctement.
      const clicked = await clickFirst(page, [
        '[data-test="redeem-button"]',
        'button:has-text("Continuer")',
        'button:has-text("Continue")',
        'button:has-text("Utiliser")',
        'button:has-text("Redeem")',
        'button[type="submit"]',
      ], { timeout: 12000 });
      await sleep(5000);

      if (reasons.includes('captcha')) {
        return { status: 'captcha', message: 'captcha GOG — active la clé via le VNC' };
      }
      if (reasons.includes('code_used')) return { status: 'owned', message: 'clé déjà utilisée' };
      if (reasons.includes('code_not_found')) return { status: 'error', message: 'clé inconnue' };

      const body = ((await page.locator('body').innerText().catch(() => '')) || '')
        .replace(/\s+/g, ' ');
      if (/ajouté à votre compte|added to your account|dans votre bibliothèque|in your library|succès|success/i.test(body)) {
        return { status: 'claimed' };
      }
      if (/déjà utilisé|already been used|already redeemed/i.test(body)) {
        return { status: 'owned', message: 'clé déjà utilisée' };
      }
      if (/connectez-vous|sign in|se connecter/i.test(body) && !/récupérer 1 article/i.test(body)) {
        return { status: 'error', message: 'session GOG expirée' };
      }
      if (!clicked) return { status: 'unknown', message: 'bouton de validation introuvable' };
      // On ne recopie pas la page entière dans l'historique : juste l'utile.
      const hint = body.match(/(Vous allez récupérer[^.]{0,60}|You will get[^.]{0,60})/i);
      return { status: 'unknown', message: hint ? hint[1] : body.slice(0, 100) };
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
