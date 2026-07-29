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

    // Chaque jeu Legacy a sa propre page promo, référencée par Amazon dans les
    // instructions de l'offre. La page générique ne contient pas le bon
    // formulaire, d'où l'échec quand on s'y rendait.
    const url = /legacygames\.com/i.test(entry.redeemUrl || '') ? entry.redeemUrl : REDEEM;
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

    const email = page.locator('input[type="email"], input[name*="email" i]').first();
    const key = page.locator('input[name*="code" i], input[name*="key" i], input[type="text"]').first();
    if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
      return { status: 'manual', message: `formulaire introuvable — active la clé sur ${url}` };
    }

    await email.fill(config.legacyEmail);
    await key.fill(code).catch(() => {});
    await clickFirst(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Redeem")',
      'button:has-text("Submit")',
    ], { timeout: 8000 });
    await sleep(5000);

    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    log.debug('réponse:', body.replace(/\s+/g, ' ').slice(0, 150));
    if (/thank you|success|check your email|merci/i.test(body)) {
      return { status: 'claimed', message: 'lien de téléchargement envoyé par e-mail' };
    }
    if (/already|invalid|expired/i.test(body)) {
      return { status: 'error', message: body.replace(/\s+/g, ' ').slice(0, 120) };
    }
    return { status: 'unknown', message: body.replace(/\s+/g, ' ').slice(0, 120) };
  },
};
