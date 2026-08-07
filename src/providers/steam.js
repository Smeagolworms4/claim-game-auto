import { config } from '../config.js';
import { makeLogger } from '../logger.js';
import { anyVisible, sleep } from '../browser.js';

const log = makeLogger('steam');

const SEARCH =
  'https://store.steampowered.com/search/?maxprice=free&specials=1&ndl=1';

export default {
  name: 'steam',
  label: 'Steam',
  loginUrl: 'https://store.steampowered.com/login/',
  homeUrl: 'https://store.steampowered.com/',

  async isLoggedIn(page) {
    await page.goto('https://store.steampowered.com/', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    return anyVisible(page, ['#account_pulldown', 'a[href*="/account/"]'], { timeout: 6000 });
  },

  /**
   * Steam n'a pas de "jeu gratuit de la semaine" : ce sont des promos
   * "free to keep" ponctuelles, qui apparaissent dans la recherche
   * prix=gratuit + promotions en cours.
   */
  async list(page) {
    await page.goto(`${SEARCH}&cc=${config.country}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#search_resultsRows', { timeout: 20000 }).catch(() => {});

    const offers = await page.$$eval('#search_resultsRows a[data-ds-appid]', (rows) =>
      rows.slice(0, 40).map((a) => ({
        id: `app-${a.getAttribute('data-ds-appid')}`,
        appid: a.getAttribute('data-ds-appid'),
        title: a.querySelector('.title')?.textContent?.trim() || 'Sans titre',
        url: a.href,
      })),
    );

    // Packages forcés par l'utilisateur (STEAM_EXTRA_SUBIDS).
    for (const subid of config.steamExtraSubids) {
      offers.push({ id: `sub-${subid}`, subid, title: `Package ${subid}`, url: `https://store.steampowered.com/sub/${subid}/` });
    }
    return offers;
  },

  /** Active une clé produit Steam (page « Activer un produit »). */
  async addKey(page, code) {
    if (config.dryRun) return { status: 'dry-run' };

    await page.goto('https://store.steampowered.com/account/registerkey', {
      waitUntil: 'domcontentloaded',
    });
    const field = page.locator('#product_key').first();
    if (!(await field.isVisible({ timeout: 8000 }).catch(() => false))) {
      return { status: 'error', message: 'page d\'activation inaccessible (pas connecté ?)' };
    }

    await field.fill(code);
    await page.locator('#accept_ssa').check().catch(() => {});
    await page.locator('#register_btn').click().catch(() => {});
    await sleep(5000);

    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    if (/activation complete|activé avec succès|a été ajouté/i.test(body)) return { status: 'claimed' };
    if (/already|déjà/i.test(body)) return { status: 'owned', message: 'déjà activé' };
    if (/invalid|invalide/i.test(body)) return { status: 'error', message: 'clé invalide' };
    return { status: 'unknown', message: body.replace(/\s+/g, ' ').slice(0, 120) };
  },

  async claim(page, offer) {
    if (config.dryRun) return { status: 'dry-run' };

    // Activation directe par subid (pas de page à parser).
    if (offer.subid) return addFreeLicense(page, offer.subid);

    await page.goto(offer.url, { waitUntil: 'domcontentloaded' });
    await passAgeGate(page);

    if (await page.locator('.game_area_already_owned').first().isVisible({ timeout: 3000 }).catch(() => false)) {
      return { status: 'owned' };
    }

    // Une promo "free to keep" expose un formulaire d'ajout de licence gratuite.
    // Ce <form> ne contient plus que des champs cachés (hauteur nulle, donc
    // jamais "visible" au sens Playwright) : le bouton « Ajouter au compte »
    // vit à côté et poste en JavaScript. On lit donc le subid dans le
    // formulaire et on poste nous-mêmes, comme pour STEAM_EXTRA_SUBIDS.
    const subid = await page
      .locator('form[action*="addfreelicense"] input[name="subid"]')
      .first()
      .getAttribute('value', { timeout: 5000 })
      .catch(() => null);
    if (!subid) {
      return { status: 'skipped', message: 'pas une offre à conserver (free to play ?)' };
    }

    log.debug(offer.title, '→ subid', subid);
    // La page du jeu est la source de vérité pour confirmer l'ajout : plus
    // fiable que la page du package, qui redirige souvent.
    return addFreeLicense(page, subid, { referer: page.url(), verifyUrl: offer.url });
  },
};

/**
 * POST direct sur l'endpoint d'activation (STEAM_EXTRA_SUBIDS et promos
 * « free to keep »). C'est exactement ce que fait le bouton du site.
 */
async function addFreeLicense(page, subid, { referer = null, verifyUrl = null } = {}) {
  // Sans referer fourni, on n'est pas forcément sur un domaine Steam : on passe
  // par la boutique pour disposer des cookies de session.
  if (!referer) {
    await page.goto('https://store.steampowered.com/', { waitUntil: 'domcontentloaded' });
  }
  const cookies = await page.context().cookies('https://store.steampowered.com');
  const sessionid = cookies.find((c) => c.name === 'sessionid')?.value;
  if (!sessionid) return { status: 'error', message: 'sessionid absent (pas connecté ?)' };

  const res = await page.request.post(
    `https://store.steampowered.com/freelicense/addfreelicense/${subid}`,
    {
      form: { ajax: 'true', sessionid },
      headers: {
        referer: referer || `https://store.steampowered.com/sub/${subid}/`,
        'x-requested-with': 'XMLHttpRequest',
        origin: 'https://store.steampowered.com',
      },
    },
  );
  if (!res.ok()) return { status: 'error', message: `HTTP ${res.status()}` };

  const body = await res.text();
  // Steam limite à ~50 activations par heure.
  if (/rate limit|too many/i.test(body)) return { status: 'error', message: 'rate limit Steam' };

  // La réponse est un JSON avare : `[]` sur un ajout réussi, un objet
  // { success, rgFailedPackages } quand Steam a quelque chose à dire. Seul un
  // refus explicite est concluant — sinon on relit la page du jeu.
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    /* Steam renvoie parfois un fragment HTML */
  }
  if (data && !Array.isArray(data)) {
    if (data.success === 1 || data.rgSuccessfullyAddedPackages?.length) {
      return { status: 'claimed', message: `sub ${subid}` };
    }
    if (data.rgFailedPackages?.length) {
      return { status: 'unknown', message: `sub ${subid} refusé par Steam` };
    }
  }

  // Vérification sur la page : c'est elle qui fait foi.
  return (await ownsSub(page, subid, verifyUrl))
    ? { status: 'claimed', message: `sub ${subid}` }
    : { status: 'unknown', message: `sub ${subid} — ajout non confirmé` };
}

/** Vérifie que la licence est bien détenue par le compte. */
async function ownsSub(page, subid, verifyUrl = null) {
  // Liste des licences du compte : la seule source qui vaille pour un package
  // sans page lisible (la page /sub/ redirige souvent vers celle du jeu).
  if (await ownsPackage(page, subid)) return true;

  // Cette liste est mise en cache côté Steam : un ajout tout frais peut ne pas
  // encore y figurer, d'où la relecture de la page du jeu avant de conclure.
  const url = verifyUrl || `https://store.steampowered.com/sub/${subid}/`;
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await passAgeGate(page);
  await sleep(1500);
  if (await page.locator('.game_area_already_owned').first().isVisible({ timeout: 5000 }).catch(() => false)) {
    return true;
  }
  const body = (await page.locator('body').innerText().catch(() => '')) || '';
  return /dans votre bibliothèque|in your Steam library/i.test(body);
}

/** true / false selon les licences du compte, null si la liste est illisible. */
async function ownsPackage(page, subid) {
  try {
    const res = await page.request.get('https://store.steampowered.com/dynamicstore/userdata/');
    if (!res.ok()) return null;
    const data = await res.json();
    if (!Array.isArray(data.rgOwnedPackages)) return null;
    return data.rgOwnedPackages.includes(Number(subid));
  } catch {
    return null;
  }
}

async function passAgeGate(page) {
  if (!page.url().includes('agecheck')) return;
  await page.selectOption('#ageYear', '1990').catch(() => {});
  await page
    .locator('#view_product_page_btn, a:has-text("Voir la page"), a:has-text("View Page")')
    .first()
    .click()
    .catch(() => {});
  await sleep(2000);
}
