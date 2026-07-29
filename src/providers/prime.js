import { config } from '../config.js';
import { makeLogger } from '../logger.js';
import { anyVisible, clickFirst, sleep } from '../browser.js';

const log = makeLogger('prime');

const HOME = 'https://gaming.amazon.com/home';

// Prime Gaming alimente aussi Luna : les offres réclamées ici sont dispo
// dans la bibliothèque Luna/Prime du compte Amazon.
export default {
  name: 'prime',
  label: 'Prime Gaming / Luna',
  loginUrl: 'https://gaming.amazon.com/home',
  homeUrl: HOME,

  async isLoggedIn(page) {
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const signIn = await anyVisible(
      page,
      ['button:has-text("Sign in")', 'a:has-text("Sign in")', 'button:has-text("Se connecter")'],
      { timeout: 6000 },
    );
    return !signIn;
  },

  async list(page) {
    if (!page.url().startsWith(HOME)) await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await clickFirst(page, ['button:has-text("Accept")', 'button:has-text("Accepter")'], { timeout: 3000 });

    const offers = [];
    offers.push(...(await collect(page, 'Game', 'FGWP_FULL')));
    if (config.primeClaimLoot) offers.push(...(await collect(page, 'InGameLoot', 'IN_GAME_LOOT')));
    return offers;
  },

  async claim(page, offer) {
    if (config.dryRun) return { status: 'dry-run' };

    // Quelques cartes (carrousel en avant) n'exposent aucun lien : on ouvre
    // alors la fiche en cliquant la carte depuis la liste.
    if (offer.url.includes('/dp/')) {
      // Filet de sécurité : la page /details ne porte pas de buy-box.
      await page.goto(offer.url.replace(/\/details(\?|$)/, '$1'), { waitUntil: 'domcontentloaded' });
    } else if (!(await openFromList(page, offer))) {
      return { status: 'manual', message: `à réclamer à la main sur ${HOME}` };
    }
    await sleep(3000);

    const cta = page.locator('[data-a-target="buy-box_call-to-action"]').first();
    if (!(await cta.isVisible({ timeout: 15000 }).catch(() => false))) {
      return { status: 'unknown', message: 'buy-box introuvable' };
    }

    // Déjà récupéré : on remonte quand même la clé, qui reste à activer sur le
    // store partenaire. C'est le cas des offres prises avant la mise en place
    // de l'outil : leur clé n'a jamais été enregistrée.
    let state = await readClaimState(page);
    if (state.claimed) {
      const t = state.target || (await detectTarget(page, offer));
      return {
        status: 'owned',
        code: state.code,
        target: t,
        redeemUrl: state.redeemUrl,
        message: state.code ? `clé ${t || 'partenaire'} déjà émise` : undefined,
      };
    }

    // Bouton désactivé sans bloc claim-state : offre indisponible (région,
    // Prime expiré…), et non « déjà prise ».
    if (await cta.isDisabled().catch(() => false)) {
      return { status: 'skipped', message: 'offre indisponible (bouton désactivé)' };
    }

    await cta.click({ timeout: 10000 }).catch((err) => log.warn('clic:', err.message.split('\n')[0]));

    // Seuls GOG, Legacy Games (et Steam/Microsoft) émettent une clé. Les offres
    // Epic passent par un compte lié : inutile d'attendre un code qui
    // n'arrivera jamais, on se contente de confirmer la récupération.
    const expected = await detectTarget(page, offer);
    const expectsKey = ['gog', 'legacy', 'steam', 'microsoft'].includes(expected);
    if (!expectsKey) {
      log.info(offer.title, `→ ${expected || 'store interne'} : pas de clé, compte lié`);
    }

    state = await waitClaimState(page, { timeout: expectsKey ? 40000 : 12000, needCode: expectsKey });
    const target = state.target || expected;

    if (state.code) {
      log.info(offer.title, `→ clé à activer sur ${target || 'le store partenaire'}`);
      return {
        status: 'claimed',
        message: `clé ${target || 'partenaire'}`,
        code: state.code,
        target,
        redeemUrl: state.redeemUrl,
      };
    }
    if (state.claimed) return { status: 'claimed', target };

    // Compte externe à lier : Amazon l'annonce dans la zone d'achat.
    const linking = await page
      .locator('[data-a-target="buy-box"]')
      .filter({ hasText: /link (game )?account|lier/i })
      .first()
      .isVisible({ timeout: 4000 })
      .catch(() => false);
    if (linking) {
      return {
        status: 'manual',
        message: `compte ${target || 'externe'} à lier — ouvre le VNC ou la page Amazon`,
        target,
      };
    }

    return {
      status: 'unknown',
      message: expectsKey
        ? 'aucune clé trouvée après le clic'
        : 'récupération non confirmée après le clic',
      target,
    };
  },
};

/**
 * Lit l'état réel d'une offre dans la buy-box.
 *
 * Amazon ne change PAS le libellé du bouton après récupération : il reste
 * « Obtenir le jeu », simplement désactivé. Ce qui apparaît, c'est un bloc
 * claim-state contenant la date, le code, et un lien d'activation déjà
 * pré-rempli (ex. https://www.gog.com/redeem/XXXX). Ce lien est aussi la source
 * la plus fiable pour savoir sur quel store activer la clé.
 */
async function readClaimState(page) {
  // Timeouts courts et explicites : getAttribute() et textContent() attendent
  // l'élément jusqu'au timeout par défaut du contexte (45 s ici). Sans ça, une
  // offre non réclamée coûtait 90 s de lecture inutile, répétée en boucle.
  const href = await page
    .locator('a[data-a-target="claim-code-link-button"]')
    .first()
    .getAttribute('href', { timeout: 1500 })
    .catch(() => null);

  const codeText = await page
    .locator('[data-a-target="ClaimStateClaimCodeContent"]')
    .first()
    .textContent({ timeout: 1500 })
    .catch(() => null);

  // Legacy Games n'expose pas de lien « Récupérer le code » : son lien
  // d'activation est une page promo propre au jeu, citée dans les
  // instructions (ex. promo.legacygames.com/poly-vita-luna/).
  const partnerLink = href
    ? null
    : await page
        .locator('[data-a-target="claim-instructions"] a[href], [data-a-target="buy-box"] a[href]')
        .evaluateAll((as) =>
          as
            .map((a) => a.href || '')
            .find((h) =>
              /promo\.legacygames\.com|legacygames\.com\/[a-z]|gog\.com\/redeem|account\.microsoft\.com/i.test(h),
            ) || null,
        )
        .catch(() => null);

  const claimedAt = await page
    .locator('[data-a-target="ClaimStateQuantityAndDateContent"]')
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  // La clé : depuis l'URL d'activation en priorité, sinon depuis le texte
  // « Votre code : XXXX » (l'espace y est insécable).
  let code = null;
  if (href) {
    const fromQuery = href.match(/[?&]code=([^&]+)/i);
    code = fromQuery
      ? decodeURIComponent(fromQuery[1])
      : href.split('?')[0].split('/').filter(Boolean).pop() || null;
    if (code && !/^[A-Za-z0-9-]{6,}$/.test(code)) code = null;
  }
  if (!code && codeText) {
    const m = codeText.replace(/ /g, ' ').match(/([A-Za-z0-9-]{6,})\s*$/);
    if (m) code = m[1];
  }

  // Store cible : déduit de l'hôte du lien d'activation.
  const link = href || partnerLink;
  let target = null;
  if (link) {
    const h = link.toLowerCase();
    if (h.includes('gog.com')) target = 'gog';
    else if (h.includes('legacygames.com')) target = 'legacy';
    else if (h.includes('epicgames.com')) target = 'epic';
    else if (h.includes('steampowered.com')) target = 'steam';
    else if (h.includes('microsoft.com') || h.includes('xbox.com')) target = 'microsoft';
  }

  return { claimed: Boolean(claimedAt || code), code, target, redeemUrl: link };
}

/**
 * Attend l'apparition du bloc claim-state après un clic. Amazon met parfois
 * plusieurs dizaines de secondes à l'afficher, et il n'apparaît occasionnellement
 * qu'après un rechargement : lire une seule fois après un délai fixe faisait
 * conclure à tort « aucun code » sur des offres pourtant réclamées.
 */
async function waitClaimState(page, { timeout = 40000, needCode = true } = {}) {
  // needCode = false pour les offres sans clé (Epic, Amazon Games App) : la
  // simple confirmation de récupération suffit, on n'attend pas un code.
  const done = (st) => (needCode ? Boolean(st.code) : st.claimed);
  const deadline = Date.now() + timeout;
  let state = await readClaimState(page);
  while (!done(state) && Date.now() < deadline) {
    await sleep(3000);
    state = await readClaimState(page);
  }
  if (done(state)) return state;

  log.debug('claim-state absent, rechargement de la page');
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(6000);
  return readClaimState(page);
}

/**
 * Identifie le store où activer la clé : d'abord via les liens de la page
 * (Amazon renvoie vers le partenaire), sinon via le suffixe du slug de l'offre
 * (…-gog, …-legacy, …-epic).
 */
export async function detectTarget(page, offer) {
  // 1) Le slug de l'offre est fiable et sans ambiguïté.
  const slug = `${offer.url || ''}`.toLowerCase();
  const bySlug = [
    ['-gog', 'gog'],
    ['-legacy', 'legacy'],
    ['-epic', 'epic'],
    ['-steam', 'steam'],
    ['-ms', 'microsoft'],
    ['-aga', 'amazon'], // Amazon Games App : rien à activer ailleurs
  ];
  for (const [suffix, name] of bySlug) {
    if (slug.includes(suffix)) return name;
  }

  // 2) Sinon, les liens — mais UNIQUEMENT dans la zone d'achat et les
  // instructions. Scanner toute la page attribuait le store du carrousel
  // « Vous aimerez peut-être aussi » : une offre Epic finissait « gog ».
  const hosts = await page
    .locator('[data-a-target="buy-box"] a[href], [data-a-target="claim-instructions"] a[href]')
    .evaluateAll((as) => as.map((a) => a.getAttribute('href') || ''))
    .catch(() => []);

  const byHost = [
    [/gog\.com/i, 'gog'],
    [/legacygames\.com/i, 'legacy'],
    [/epicgames\.com/i, 'epic'],
    [/steampowered\.com/i, 'steam'],
    [/microsoft\.com|xbox\.com/i, 'microsoft'],
  ];
  for (const [re, name] of byHost) {
    if (hosts.some((h) => re.test(h))) return name;
  }
  return null;
}

/**
 * Certaines cartes n'ont pas de lien vers la fiche, mais portent directement
 * le bouton « Claim game » : on le déclenche depuis la liste.
 */
async function openFromList(page, offer) {
  await page.goto(HOME, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await page.locator(`button[data-type="${offer.type || 'Game'}"]`).first().click({ timeout: 8000 }).catch(() => {});
  await sleep(2500);

  const card = page.locator('[data-a-target="item-card"]').filter({ hasText: offer.title }).first();
  await card.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  // Le bouton d'action n'est révélé qu'au survol de la carte.
  await card.hover({ timeout: 5000 }).catch(() => {});
  await sleep(1000);

  const action = card.locator('[data-a-target="FGWPOffer"]').first();
  if (!(await action.count().catch(() => 0))) {
    log.warn('ni fiche ni bouton pour', offer.title);
    return false;
  }
  const clicked = await action
    .click({ timeout: 8000 })
    .then(() => true)
    .catch(() => action.dispatchEvent('click').then(() => true).catch(() => false));
  if (!clicked) {
    log.warn('bouton non actionnable pour', offer.title);
    return false;
  }
  await sleep(4000);
  return true;
}

/** Lit une catégorie d'offres (onglet Games ou In-game loot). */
async function collect(page, dataType, listTarget) {
  await page.locator(`button[data-type="${dataType}"]`).first().click({ timeout: 8000 }).catch(() => {});
  await sleep(2500);

  const listSel = `div[data-a-target="offer-list-${listTarget}"]`;
  const list = page.locator(listSel).first();
  if (!(await list.isVisible({ timeout: 8000 }).catch(() => false))) {
    log.warn(`liste ${listTarget} introuvable`);
    return [];
  }

  // On charge tout ce qui est paginé derrière "See more".
  for (let i = 0; i < 5; i += 1) {
    const more = list.locator('button:has-text("See more"), button:has-text("Voir plus")').first();
    if (!(await more.isVisible({ timeout: 1500 }).catch(() => false))) break;
    await more.click().catch(() => {});
    await sleep(1500);
  }

  // Les cartes hors écran n'ont pas encore de lien : il faut les faire défiler
  // pour qu'Amazon les hydrate.
  const cards = list.locator('[data-a-target="item-card"]');
  const count = await cards.count();
  for (let i = 0; i < count; i += 1) {
    await cards.nth(i).scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  }
  await sleep(1500);

  return list.evaluate((root, type) => {
    const cards = Array.from(root.querySelectorAll('[data-a-target="item-card"]'));
    return cards
      .map((card) => {
        // Le lien canonique de l'offre est celui de la carte. Viser « un lien
        // qui contient /dp/ » attrapait aussi « Afficher les détails », dont la
        // page (/details) n'a pas de buy-box : le claim échouait alors.
        const link =
          card.querySelector('a[data-a-target="learn-more-card"]') ||
          [...card.querySelectorAll('a[href*="/dp/"]')].find(
            (a) => !/\/details(\?|$)/.test(a.getAttribute('href') || ''),
          ) ||
          [...card.querySelectorAll('a[href]')].find((a) => (a.getAttribute('href') || '').length > 1);
        const title =
          card.querySelector('.item-card-details__body__primary h3')?.textContent?.trim() ||
          link?.getAttribute('aria-label')?.trim() ||
          '';
        // Marqueur dédié d'Amazon, bien plus fiable qu'un match sur le texte.
        const collected = Boolean(card.querySelector('[data-a-target="ItemCardDetailSuccessStatus"]'));
        const href = link?.getAttribute('href') || '';
        return {
          id: href || title,
          title,
          type,
          owned: collected,
          // gaming.amazon.com redirige vers luna.amazon.com : on résout les
          // liens relatifs sur l'origine réellement servie.
          url: href.startsWith('http') ? href : `${location.origin}${href}`,
        };
      })
      // On garde les offres déjà récupérées : leur clé partenaire est
      // peut-être encore à activer, il faut donc pouvoir la relire.
      .filter((o) => o.title && o.id);
  }, dataType);
}
