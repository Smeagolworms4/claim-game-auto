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
      await page.goto(offer.url, { waitUntil: 'domcontentloaded' });
    } else if (!(await openFromList(page, offer))) {
      return { status: 'manual', message: `à réclamer à la main sur ${HOME}` };
    }
    await sleep(3000);

    // L'état de l'offre se lit UNIQUEMENT sur le bouton de la buy-box. Chercher
    // « Collected » dans toute la page donne des faux positifs : le mot apparaît
    // aussi dans les offres liées et la FAQ.
    const cta = page.locator('[data-a-target="buy-box_call-to-action"]').first();
    if (!(await cta.isVisible({ timeout: 15000 }).catch(() => false))) {
      return { status: 'unknown', message: 'buy-box introuvable' };
    }

    const label = ((await cta.textContent().catch(() => '')) || '').trim();
    log.debug(offer.title, '→ bouton:', label);

    if (/collected|récupéré|in your library|dans votre biblioth/i.test(label)) {
      return { status: 'owned' };
    }
    if (!/get game|claim|récupérer|obtenir|get \w+/i.test(label)) {
      return { status: 'skipped', message: `bouton inattendu : ${label}` };
    }

    await cta.click({ timeout: 10000 }).catch((err) => log.warn('clic:', err.message.split('\n')[0]));
    await sleep(6000);

    const target = await detectTarget(page, offer);

    // Clé éventuelle, cherchée dans la zone d'achat et non dans toute la page.
    const code = await page
      .locator('[data-a-target="copy-code-input"], [data-a-target="buy-box"] input[readonly]')
      .first()
      .inputValue()
      .catch(() => null);

    // Le bouton reflète le nouvel état : c'est notre confirmation.
    const after = ((await cta.textContent().catch(() => '')) || '').trim();
    const done = /collected|récupéré|in your library|dans votre biblioth/i.test(after);

    if (code) {
      log.info(offer.title, `→ clé à activer sur ${target || 'le store partenaire'}`);
      return { status: 'claimed', message: `clé ${target || 'partenaire'}`, code, target };
    }
    if (done) return { status: 'claimed', target };

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

    return { status: 'unknown', message: `bouton après clic : ${after || '(vide)'}`, target };
  },
};

/**
 * Identifie le store où activer la clé : d'abord via les liens de la page
 * (Amazon renvoie vers le partenaire), sinon via le suffixe du slug de l'offre
 * (…-gog, …-legacy, …-epic).
 */
export async function detectTarget(page, offer) {
  const hosts = await page
    .locator('a[href]')
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
        // Le lien utile est celui vers la fiche (/dp/…) : les cartes en avant
        // contiennent aussi des liens décoratifs vers la racine.
        const link =
          card.querySelector('a[href*="/dp/"]') ||
          [...card.querySelectorAll('a[href]')].find((a) => (a.getAttribute('href') || '').length > 1);
        const title =
          card.querySelector('.item-card-details__body__primary h3')?.textContent?.trim() ||
          link?.getAttribute('aria-label')?.trim() ||
          '';
        const collected = /collected|récupéré/i.test(card.textContent || '');
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
      .filter((o) => o.title && o.id && !o.owned);
  }, dataType);
}
