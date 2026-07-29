import { config } from '../config.js';
import { makeLogger } from '../logger.js';
import { clickFirst, waitAny, sleep } from '../browser.js';

const log = makeLogger('epic');

const PROMO_API =
  'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions';

const storeUrl = (slug) =>
  `https://store.epicgames.com/${config.locale.split('-')[0]}/p/${slug}`;

/** Extrait le slug de page utilisable dans une URL /p/<slug>. */
const slugOf = (el) =>
  el.catalogNs?.mappings?.find((m) => m.pageType === 'productHome')?.pageSlug ||
  el.offerMappings?.[0]?.pageSlug ||
  el.productSlug?.replace(/\/home$/, '') ||
  el.urlSlug;

/** Page d'attente Cloudflare / « enquête de sécurité » Epic. */
async function isChallenge(page) {
  const title = (await page.title().catch(() => '')) || '';
  if (/un instant|just a moment|attention required/i.test(title)) return true;
  const text = (await page.locator('body').innerText().catch(() => '')) || '';
  return /enquête de sécurité|security (survey|check)|vérification de sécurité/i.test(text);
}

export default {
  name: 'epic',
  label: 'Epic Games Store',
  loginUrl: 'https://www.epicgames.com/id/login',
  homeUrl: 'https://store.epicgames.com/',

  async isLoggedIn(page) {
    // Le header du store est rendu trop tardivement pour être un signal fiable,
    // et la page compte est protégée par un challenge anti-bot en Chromium
    // headless : on regarde d'abord les cookies de session, lisibles depuis le
    // store (qui, lui, répond toujours).
    await page.goto('https://store.epicgames.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(2000);
    const cookies = await page.context().cookies('https://www.epicgames.com');
    if (cookies.some((c) => /^EPIC_(SSO|BEARER)/.test(c.name) && c.value)) return true;

    // Sans cookie, on confirme via la redirection de la page compte : fiable en
    // Firefox, et de toute façon négative si la session est morte.
    await page
      .goto('https://www.epicgames.com/account/personal', { waitUntil: 'domcontentloaded' })
      .catch(() => {});
    await sleep(2500);
    // Un challenge anti-bot laisse l'URL sur /account/ sans rien prouver :
    // dans le doute on répond « non connecté » plutôt que de lancer des claims
    // qui échoueront.
    if (await isChallenge(page)) {
      // Challenge intermittent, lié à la réputation de l'IP : réessayer plus
      // tard suffit souvent, sinon il faut importer les cookies.
      log.warn('challenge Cloudflare sur la page compte — session non vérifiable, réessai au prochain passage');
      return false;
    }
    // On exige d'avoir atterri sur la page compte : en cas d'échec réseau,
    // « pas sur /id/login » ne suffit pas à conclure qu'on est connecté.
    return page.url().includes('/account/') && !page.url().includes('/id/login');
  },

  /**
   * Découverte via l'API publique des promos (plus fiable que le DOM,
   * et ça alimente directement l'interface web même sans être connecté).
   */
  async list(page) {
    const lang = config.locale;
    const url = `${PROMO_API}?locale=${lang}&country=${config.country}&allowCountries=${config.country}`;
    const res = await page.request.get(url, { timeout: 20000 });
    if (!res.ok()) throw new Error(`API promos HTTP ${res.status()}`);
    const json = await res.json();
    const elements = json?.data?.Catalog?.searchStore?.elements || [];

    const offers = [];
    const now = Date.now();
    for (const el of elements) {
      // Un même jeu peut porter plusieurs promos simultanées (ex: -15% soldes
      // ET -100% gratuit) : il faut chercher l'offre à 0% dans tous les groupes,
      // et recouper avec le prix effectif.
      const promo = (el.promotions?.promotionalOffers || [])
        .flatMap((g) => g.promotionalOffers || [])
        .find(
          (o) =>
            o.discountSetting?.discountPercentage === 0 &&
            new Date(o.startDate).getTime() <= now &&
            new Date(o.endDate).getTime() > now,
        );
      if (!promo) continue;
      if (el.price?.totalPrice?.discountPrice !== 0) continue;

      const slug = slugOf(el);
      if (!slug) {
        log.warn('slug introuvable pour', el.title);
        continue;
      }
      offers.push({
        id: el.id || slug,
        title: el.title,
        url: storeUrl(slug),
        endsAt: promo.endDate,
        image: el.keyImages?.find((k) => k.type === 'OfferImageWide')?.url || el.keyImages?.[0]?.url,
      });
    }
    return offers;
  },

  /** Active une clé Epic (page /redeem). */
  async addKey(page, code) {
    if (config.dryRun) return { status: 'dry-run' };

    await page.goto(`https://store.epicgames.com/redeem?code=${encodeURIComponent(code)}`, {
      waitUntil: 'domcontentloaded',
    });
    await sleep(3000);
    if (await isChallenge(page)) return { status: 'captcha', message: 'challenge anti-bot' };

    await clickFirst(page, ['button:has-text("Redeem")', 'button:has-text("Utiliser")'], {
      timeout: 10000,
    });
    await sleep(4000);

    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    if (/thank you|merci|success/i.test(body)) return { status: 'claimed' };
    if (/already|déjà/i.test(body)) return { status: 'owned' };
    return { status: 'unknown', message: body.replace(/\s+/g, ' ').slice(0, 120) };
  },

  async claim(page, offer) {
    await page.goto(offer.url, { waitUntil: 'domcontentloaded' });

    // Bandeau cookies éventuel.
    await clickFirst(page, ['button:has-text("Accept All")', 'button:has-text("Tout accepter")'], {
      timeout: 3000,
    });

    const cta = page.locator('button[data-testid="purchase-cta-button"]').first();
    try {
      await cta.waitFor({ state: 'visible', timeout: 25000 });
    } catch (err) {
      // Le plus souvent ce n'est pas la page qui a changé : c'est un Turnstile
      // Cloudflare devant. On le nomme, pour déclencher une demande de
      // déblocage plutôt qu'une erreur opaque.
      if (await isChallenge(page)) {
        return {
          status: 'captcha',
          message: 'Turnstile Cloudflare sur la page du jeu',
        };
      }
      throw err;
    }
    const label = ((await cta.textContent()) || '').trim().toLowerCase();
    log.debug(offer.title, '→ CTA:', label);

    if (/library|bibliothèque/.test(label)) return { status: 'owned' };
    if (/base game|jeu de base/.test(label)) return { status: 'skipped', message: 'jeu de base requis' };
    if (!/get|obtenir|gratuit|free/.test(label)) {
      return { status: 'skipped', message: `bouton inattendu: ${label}` };
    }
    if (config.dryRun) return { status: 'dry-run' };

    await cta.click();

    // Le tunnel d'achat vit dans une iframe.
    await page.waitForSelector('#webPurchaseContainer iframe', { timeout: 25000 });
    const frame = page.frameLocator('#webPurchaseContainer iframe');

    // CLUF ponctuel.
    const agree = frame.locator('input#agree');
    if (await agree.isVisible({ timeout: 3000 }).catch(() => false)) {
      await agree.check().catch(() => {});
      await frame.locator('button:has-text("Accept"), button:has-text("Accepter")').first().click().catch(() => {});
    }

    const order = frame
      .locator('button:has-text("Place Order"), button:has-text("Commander")')
      .filter({ hasNot: page.locator('.payment-loading--loading') })
      .first();
    await order.waitFor({ state: 'visible', timeout: 20000 });
    await order.click();

    // hCaptcha : non résolvable automatiquement, on remonte l'info.
    const captcha = frame.locator('#h_captcha_challenge_checkout_free_prod iframe');
    if (await captcha.isVisible({ timeout: 5000 }).catch(() => false)) {
      return {
        status: 'captcha',
        message: 'hCaptcha à résoudre manuellement (ouvre le VNC puis relance)',
      };
    }

    // Confirmation : soit le message de succès, soit le CTA passe à "In Library".
    const ok = await waitAny(
      page,
      [
        'span:has-text("Thank you")',
        'span:has-text("Merci")',
        'button[data-testid="purchase-cta-button"]:has-text("In Library")',
        'button[data-testid="purchase-cta-button"]:has-text("bibliothèque")',
      ],
      { timeout: 30000 },
    );
    if (!ok) return { status: 'unknown', message: 'confirmation non détectée' };
    return { status: 'claimed' };
  },
};
