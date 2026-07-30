import { config } from '../config.js';
import { makeLogger } from '../logger.js';
import { clickFirst, sleep } from '../browser.js';

const log = makeLogger('legacy');

const REDEEM = 'https://legacygames.com/primedeal';

/**
 * Legacy Games ne distribue rien par lui-même : c'est une cible d'activation
 * pour les clés Prime Gaming. Ce handler ne déclare donc que addKey — il n'a
 * ni list ni claim, et le runner le saute dans les passes de claim.
 */
/**
 * Retrouve la page promo du jeu depuis la fiche Amazon. On tente d'abord une
 * simple requête HTTP — si le lien est dans le HTML servi, c'est instantané et
 * ça évite de rendre une page entière. Sinon on charge la fiche dans le
 * navigateur, le lien étant alors injecté par le script de la page.
 */
async function findPromoUrl(page, amazonUrl) {
  const details = amazonUrl.replace(/\?.*$/, '').replace(/\/details$/, '') + '/details';
  const rx = /https:\/\/promo\.legacygames\.com\/[A-Za-z0-9._-]+\/?/;

  try {
    const res = await page.request.get(details, { timeout: 15000 });
    if (res.ok()) {
      const found = (await res.text()).match(rx);
      if (found) {
        log.debug('lien promo trouvé sans rendu:', found[0]);
        return found[0];
      }
    }
  } catch (err) {
    log.debug('requête HTTP échouée:', err.message);
  }

  await page.goto(details, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(5000);
  const href = await page
    .locator('a[href*="promo.legacygames.com"]')
    .first()
    .getAttribute('href', { timeout: 3000 })
    .catch(() => null);
  if (href) log.debug('lien promo trouvé dans la page:', href);
  else log.warn('lien promo introuvable sur', details);
  return href;
}

export default {
  name: 'legacy',
  label: 'Legacy Games',
  loginUrl: REDEEM,
  homeUrl: REDEEM,
  redeemOnly: true,

  // Pas de compte à connecter : l'activation se fait avec un e-mail + la clé.
  async isLoggedIn() {
    return Boolean(config.legacyEmail);
  },

  async addKey(page, code, entry = {}) {
    if (!config.legacyEmail) {
      return { status: 'manual', message: 'renseigne LEGACY_EMAIL pour activer les clés Legacy' };
    }
    if (config.dryRun) return { status: 'dry-run' };

    // Chaque jeu Legacy a sa propre page promo (ex. promo.legacygames.com/
    // poly-vita-luna/), référencée par Amazon dans les instructions de l'offre.
    // La page générique ne contient pas le bon formulaire.
    let url = /legacygames\.com/i.test(entry.redeemUrl || '') ? entry.redeemUrl : null;
    if (!url && entry.url) url = await findPromoUrl(page, entry.url);
    if (!url) {
      return {
        status: 'manual',
        message: `page promo introuvable — cherche le lien sur ${String(entry.url || REDEEM).replace(/\?.*$/, '')}`,
      };
    }
    log.debug('page d\'activation:', url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(2500);

    // Legacy Games affiche un mur de consentement qui bloque le formulaire.
    const consent = await clickFirst(page, [
      'button:has-text("Accept All")',
      'button:has-text("Accept all")',
      'button:has-text("I Accept")',
      'button:has-text("Tout accepter")',
      '#onetrust-accept-btn-handler',
      '.termly-consent-accept, [data-testid="accept-all"]',
    ], { timeout: 5000 });
    if (consent) await sleep(1500);

    // Champs réels du formulaire promo. Il y a DEUX champs e-mail (saisie +
    // confirmation) : n'en remplir qu'un fait échouer la validation sans
    // message d'erreur exploitable.
    const codeField = page.locator('#primedeal_game_code, input[name="coupon_code"]').first();
    const mail = page.locator('#primedeal_email, input[name="email"]').first();
    const mailConfirm = page.locator('#primedeal_email_validate, input[name="email_validate"]').first();

    if (!(await codeField.isVisible({ timeout: 10000 }).catch(() => false))) {
      return { status: 'manual', message: `formulaire introuvable — active la clé sur ${url}` };
    }

    await codeField.fill(code);
    await mail.fill(config.legacyEmail);
    await mailConfirm.fill(config.legacyEmail).catch(() => {});

    await clickFirst(page, [
      '#submitbutton',
      'input[type="submit"]',
      'button[type="submit"]',
      'button:has-text("Submit")',
    ], { timeout: 8000 });
    await sleep(6000);

    // Le succès se lit à la redirection, pas dans le texte : Legacy renvoie vers
    // la page du jeu (legacygames.com/amazon-luna-x-legacy-games-<jeu>) dont le
    // contenu visible est sa boutique. Le lien de téléchargement part par e-mail.
    const landed = page.url();
    const formGone = !(await codeField.isVisible({ timeout: 2500 }).catch(() => false));
    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    log.debug('après soumission:', landed);

    if (/amazon-luna-x-legacy-games/i.test(landed) || (formGone && landed !== url)) {
      return {
        status: 'claimed',
        message: 'validée — lien de téléchargement envoyé par e-mail',
        redeemUrl: url,
      };
    }
    // Chaque jeu a sa page promo : sans elle, la page générique n'a pas le bon
    // formulaire. On renvoie vers les instructions Amazon, qui la référencent.
    if (/thank you|success|check your email|merci|téléchargement/i.test(body)) {
      return { status: 'claimed', message: 'lien de téléchargement envoyé par e-mail', redeemUrl: url };
    }
    if (/already (been )?(used|redeemed)|déjà utilisé/i.test(body)) {
      return { status: 'owned', message: 'clé déjà utilisée', redeemUrl: url };
    }
    if (/invalid|expired|invalide|expiré/i.test(body)) {
      return { status: 'error', message: body.replace(/\s+/g, ' ').slice(0, 120), redeemUrl: url };
    }
    return { status: 'unknown', message: body.replace(/\s+/g, ' ').slice(0, 120), redeemUrl: url };
  },
};
