import { config } from '../config.js';
import { makeLogger } from '../logger.js';
import { clearCloudflareCookies, clickFirst, waitAny, sleep } from '../browser.js';

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

/**
 * Ferme le consentement cookies d'Epic (OneTrust). Deux formes possibles : le
 * bandeau, ou le « centre de préférences » en modale plein écran. Tant qu'il
 * est ouvert, il recouvre la page et absorbe le clic sur « Obtenir ».
 */
async function dismissConsent(page) {
  const clicked = await clickFirst(page, [
    '#onetrust-accept-btn-handler',
    '#accept-recommended-btn-handler',
    '#onetrust-pc-btn-handler',
    '.save-preference-btn-handler',
    '#onetrust-close-btn-container button',
    'button:has-text("Tout accepter")',
    'button:has-text("Accept All")',
  ], { timeout: 5000 });

  if (clicked) {
    log.debug('consentement OneTrust fermé via', clicked);
    await sleep(2000);
  }

  // Filet : si la modale persiste, on la retire du DOM pour libérer le clic.
  const stillOpen = await page
    .locator('#onetrust-pc-sdk, .ReactModal__Content')
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (stillOpen) {
    log.warn('modale de consentement persistante — fermeture forcée');
    await page
      .evaluate(() => {
        document.querySelector('#onetrust-consent-sdk')?.remove();
        document.body.classList.remove('ReactModal__Body--open');
        document.body.style.overflow = '';
      })
      .catch(() => {});
    await sleep(1000);
  }
}


/**
 * Interstitiels connus du tunnel Epic, à franchir sans intervention :
 * consentement cookies, « appareil non compatible », droit de rétractation (UE).
 * Ce ne sont pas des blocages, juste des confirmations.
 */
const INTERSTITIALS = [
  { nom: 'droit de rétractation', boutons: ['J\'accepte', 'I Accept'] },
  { nom: 'appareil non compatible', boutons: ['Continuer', 'Continue'] },
];

async function passInterstitials(page, { timeout = 15000 } = {}) {
  const frame = page.frameLocator('#webPurchaseContainer iframe');
  const passed = [];
  const deadline = Date.now() + timeout;

  // isVisible() de Playwright ne patiente pas : sans cette boucle, la fonction
  // s'exécutait en quelques millisecondes, avant même l'apparition de la
  // modale, et ne cliquait donc jamais rien.
  while (Date.now() < deadline) {
    let acted = false;

    for (const { nom, boutons } of INTERSTITIALS) {
      for (const libelle of boutons) {
        const sel = `button:has-text("${libelle}")`;
        for (const loc of [frame.locator(sel).first(), page.locator(sel).first()]) {
          if (!(await loc.isVisible().catch(() => false))) continue;
          await loc.click().catch(() => {});
          log.debug('interstitiel franchi :', nom);
          passed.push(nom);
          acted = true;
          break;
        }
        if (acted) break;
      }
      if (acted) break;
    }

    // Un clic peut en révéler un autre (compatibilité puis rétractation) :
    // on continue de guetter jusqu'à l'échéance.
    await sleep(acted ? 2500 : 1200);
  }

  return passed;
}

/**
 * Vrai challenge affiché, par opposition aux widgets préchargés. Epic charge
 * les iframes hCaptcha d'avance sur sa page de paiement : tester leur présence
 * faisait passer une simple modale de consentement pour un captcha.
 */
async function captchaShown(page) {
  // hCaptcha invisible : aucun widget à cocher, mais son échec laisse un bouton
  // « TRY AGAIN » dans le tunnel. C'est le seul signe visible du refus. On le
  // cherche dans toutes les frames : le conteneur d'origine n'est pas stable.
  for (const f of page.frames()) {
    const retry = await f
      .locator('button:has-text("TRY AGAIN"), button:has-text("RÉESSAYER")')
      .first()
      .isVisible()
      .catch(() => false);
    if (retry) return true;
  }

  const cibles = await page
    .locator('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="captcha" i]')
    .all()
    .catch(() => []);

  for (const f of cibles) {
    if (!(await f.isVisible().catch(() => false))) continue;
    const box = await f.boundingBox().catch(() => null);
    // Un widget réellement rendu occupe de la place ; les préchargés font 0×0
    // ou sont hors écran.
    if (box && box.width > 80 && box.height > 80) return true;
  }
  return false;
}

/**
 * Décrit la modale qui bloque, quand ce n'est ni un interstitiel connu ni un
 * captcha. Mieux vaut nommer l'inconnu que le maquiller.
 */
async function describeModal(page) {
  const frame = page.frameLocator('#webPurchaseContainer iframe');
  for (const scope of [frame, page]) {
    const dlg = scope.locator('[role="dialog"], .ReactModal__Content').first();
    if (!(await dlg.isVisible({ timeout: 1500 }).catch(() => false))) continue;
    const txt = ((await dlg.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    const btns = await dlg
      .locator('button')
      .allInnerTexts()
      .catch(() => []);
    return `${txt.slice(0, 90)}${btns.length ? ` [boutons : ${btns.map((b) => b.trim()).filter(Boolean).join(' / ')}]` : ''}`;
  }
  return null;
}

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
      // Jetons Cloudflare empilés : on purge et on revérifie une fois.
      await clearCloudflareCookies(page.context());
      await page
        .goto('https://www.epicgames.com/account/personal', { waitUntil: 'domcontentloaded' })
        .catch(() => {});
      await sleep(3000);
      if (await isChallenge(page)) {
        log.warn('challenge Cloudflare persistant — session non vérifiable');
        return false;
      }
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

  /**
   * Rejoue le parcours jusqu'au captcha pour une session de déblocage : sans
   * ça, l'utilisateur atterrit sur la page produit et doit refaire lui-même
   * tout ce que l'automatisation avait déjà franchi.
   */
  async prepareUnlock(page, entry = {}) {
    const url = entry.url || this.homeUrl;
    log.info('préparation du déblocage :', url);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(4000);
    await dismissConsent(page);

    const cta = page.locator('button[data-testid="purchase-cta-button"]').first();
    if (!(await cta.isVisible({ timeout: 20000 }).catch(() => false))) {
      // Turnstile en amont : la page elle-même est bloquée, c'est déjà le bon
      // endroit pour reprendre la main.
      log.warn('page bloquée en amont — rien à rejouer');
      return;
    }

    const label = ((await cta.textContent().catch(() => '')) || '').trim().toLowerCase();
    if (/library|bibliothèque/.test(label)) {
      log.info('déjà dans la bibliothèque, rien à débloquer');
      return;
    }

    await cta.click().catch(() => {});
    await sleep(2500);
    await passInterstitials(page);
    await sleep(2500);

    // Tunnel d'achat : on clique « Ajouter à la bibliothèque » pour faire
    // apparaître le captcha, puis on laisse la main.
    const frame = page.frameLocator('#webPurchaseContainer iframe');
    const order = frame
      .locator(
        [
          'button:has-text("Ajouter à la bibliothèque")',
          'button:has-text("Add to Library")',
          'button:has-text("Place Order")',
          'button:has-text("Commander")',
        ].join(', '),
      )
      .first();
    // On s'arrête ici volontairement : le clic final doit venir de l'utilisateur
    // via le VNC. Passant par le serveur X, c'est une vraie saisie système, que
    // le hCaptcha invisible accepte là où il refuse un clic synthétique.
    const ready = await order
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (ready) {
      log.info('tunnel ouvert — clique « Ajouter à la bibliothèque » dans le VNC');
    } else {
      log.warn('tunnel d\'achat non atteint');
    }
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

    await dismissConsent(page);

    let cta = page.locator('button[data-testid="purchase-cta-button"]').first();
    try {
      await cta.waitFor({ state: 'visible', timeout: 25000 });
    } catch (err) {
      if (!(await isChallenge(page))) throw err;

      // Turnstile : le plus souvent des jetons Cloudflare empilés dans le
      // profil. On repart proprement et on retente une fois.
      log.warn('Turnstile détecté — purge des jetons Cloudflare et nouvel essai');
      await clearCloudflareCookies(page.context());
      await page.goto(offer.url, { waitUntil: 'domcontentloaded' });
      await sleep(3000);

      cta = page.locator('button[data-testid="purchase-cta-button"]').first();
      const back = await cta.isVisible({ timeout: 20000 }).catch(() => false);
      if (!back) {
        return {
          status: 'captcha',
          message: 'Turnstile Cloudflare persistant sur la page du jeu',
        };
      }
    }
    const label = ((await cta.textContent()) || '').trim().toLowerCase();
    log.debug(offer.title, '→ CTA:', label);

    if (/library|bibliothèque/.test(label)) return { status: 'owned' };
    if (/base game|jeu de base/.test(label)) return { status: 'skipped', message: 'jeu de base requis' };
    if (!/get|obtenir|gratuit|free/.test(label)) {
      return { status: 'skipped', message: `bouton inattendu: ${label}` };
    }
    if (config.dryRun) return { status: 'dry-run' };

    // Le consentement peut réapparaître après le rendu complet de la page.
    await dismissConsent(page);
    await cta.click();

    // Le navigateur tourne sous Linux : Epic annonce « Appareil non compatible »
    // pour un jeu Windows et attend une confirmation avant d'ouvrir le tunnel.
    await passInterstitials(page);

    // Le tunnel d'achat vit dans une iframe.
    await page.waitForSelector('#webPurchaseContainer iframe', { timeout: 25000 });
    const frame = page.frameLocator('#webPurchaseContainer iframe');

    // CLUF ponctuel.
    const agree = frame.locator('input#agree');
    if (await agree.isVisible({ timeout: 3000 }).catch(() => false)) {
      await agree.check().catch(() => {});
      await frame.locator('button:has-text("Accept"), button:has-text("Accepter")').first().click().catch(() => {});
    }

    // Pour un jeu gratuit le bouton s'appelle « Ajouter à la bibliothèque » ;
    // « Commander » n'apparaît que sur un achat payant. Le filtre hasNot
    // précédent visait un élément d'une autre frame et ne matchait jamais.
    const order = frame
      .locator(
        [
          'button:has-text("Ajouter à la bibliothèque")',
          'button:has-text("Add to Library")',
          'button:has-text("Place Order")',
          'button:has-text("Commander")',
        ].join(', '),
      )
      .first();
    await order.waitFor({ state: 'visible', timeout: 20000 });
    await order.click();

    // Ordre d'examen : confirmations connues, puis vrai captcha, puis inconnu.
    await sleep(2500);
    await passInterstitials(page);
    await sleep(2500);

    if (await captchaShown(page)) {
      return {
        status: 'captcha',
        message:
          'hCaptcha invisible refusé — ouvre le VNC et clique toi-même « Ajouter à la bibliothèque »',
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
    if (!ok) {
      const modal = await describeModal(page);
      if (modal) return { status: 'unknown', message: `modale inattendue : ${modal}` };

      // Le bouton de commande toujours présent = la commande n'est pas partie.
      // Chez Epic c'est le hCaptcha invisible qui refuse : il s'exécute sans
      // rien afficher et rejette le clic synthétique de l'automatisation. Seul
      // un clic humain (via le VNC, donc passant par le serveur X) le satisfait.
      const stuck = await order.isVisible().catch(() => false);
      if (stuck || (await captchaShown(page))) {
        return {
          status: 'captcha',
          message:
            'validation refusée (hCaptcha invisible) — ouvre le VNC et clique toi-même « Ajouter à la bibliothèque »',
        };
      }
      return { status: 'unknown', message: 'confirmation non détectée' };
    }
    return { status: 'claimed' };
  },
};
