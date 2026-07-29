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
    const form = page.locator('form[action*="addfreelicense"]').first();
    if (!(await form.isVisible({ timeout: 5000 }).catch(() => false))) {
      return { status: 'skipped', message: 'pas une offre à conserver (free to play ?)' };
    }

    const action = (await form.getAttribute('action')) || '';
    const subid = action.split('/').filter(Boolean).pop();
    await form.locator('input[type="submit"], .btn_addtocart, .btn_green_steamui').first().click();
    await sleep(3000);

    const owned = await page
      .locator('.game_area_already_owned, div:has-text("Ajouté à votre compte"), div:has-text("added to your account")')
      .first()
      .isVisible({ timeout: 8000 })
      .catch(() => false);

    log.debug(offer.title, 'subid', subid, 'owned:', owned);
    return owned ? { status: 'claimed', message: `sub ${subid}` } : { status: 'unknown' };
  },
};

/** POST direct sur l'endpoint d'activation (utilisé pour STEAM_EXTRA_SUBIDS). */
async function addFreeLicense(page, subid) {
  await page.goto('https://store.steampowered.com/', { waitUntil: 'domcontentloaded' });
  const cookies = await page.context().cookies('https://store.steampowered.com');
  const sessionid = cookies.find((c) => c.name === 'sessionid')?.value;
  if (!sessionid) return { status: 'error', message: 'sessionid absent (pas connecté ?)' };

  const res = await page.request.post(
    `https://store.steampowered.com/freelicense/addfreelicense/${subid}`,
    {
      form: { ajax: 'true', sessionid },
      headers: { referer: `https://store.steampowered.com/sub/${subid}/` },
    },
  );
  if (!res.ok()) return { status: 'error', message: `HTTP ${res.status()}` };
  const body = await res.text();
  // Steam limite à ~50 activations par heure.
  if (/rate limit|too many/i.test(body)) return { status: 'error', message: 'rate limit Steam' };
  return { status: 'claimed', message: `sub ${subid}` };
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
