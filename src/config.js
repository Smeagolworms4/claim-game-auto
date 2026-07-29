import 'dotenv/config';
import path from 'node:path';

const bool = (v, def = false) => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(v).toLowerCase());
};

const list = (v, def = []) =>
  v === undefined || v === ''
    ? def
    : String(v)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

const dataDir = process.env.DATA_DIR || path.resolve('data');

export const config = {
  dataDir,
  profilesDir: path.join(dataDir, 'profiles'),
  stateFile: path.join(dataDir, 'state.json'),
  historyFile: path.join(dataDir, 'history.json'),
  historyMax: Number(process.env.HISTORY_MAX || 500),
  screenshotsDir: path.join(dataDir, 'screenshots'),

  // Providers actifs
  providers: list(process.env.PROVIDERS, ['epic', 'steam', 'gog', 'prime']),

  // Planification (cron 5 champs). Par défaut : 2x/jour à 12h05 et 20h05.
  cron: process.env.CRON_SCHEDULE || '5 12,20 * * *',
  // Rafraîchissement de la liste des jeux, sans rien réclamer (vide = désactivé).
  cronDetect: process.env.DETECT_SCHEDULE ?? '0 */6 * * *',
  timezone: process.env.TZ || 'Europe/Paris',
  runOnStart: bool(process.env.RUN_ON_START, false),

  // Navigateur par défaut : 'chrome' (vrai Google Chrome), 'chromium' (celui de
  // Playwright) ou 'firefox'.
  browser: (process.env.BROWSER || 'chrome').toLowerCase(),
  // Runs planifiés : headless. Le mode "headed" (dans le Xvfb, visible en VNC)
  // n'est utilisé que pour les sessions de login manuelles.
  headless: bool(process.env.HEADLESS, true),
  display: process.env.DISPLAY || ':99',
  // Résolution de l'écran virtuel, partagée avec l'entrypoint (Xvfb).
  screen: process.env.SCREEN_SIZE || '1600,1000',
  slowMo: Number(process.env.SLOW_MO || 0),
  navTimeout: Number(process.env.NAV_TIMEOUT || 45000),
  locale: process.env.LOCALE || 'fr-FR',
  country: (process.env.COUNTRY || 'FR').toUpperCase(),
  screenshotOnError: bool(process.env.SCREENSHOT_ON_ERROR, true),
  dryRun: bool(process.env.DRY_RUN, false),

  // Interface web
  webEnabled: bool(process.env.WEB_ENABLED, true),
  webPort: Number(process.env.WEB_PORT || 8080),
  webUser: process.env.WEB_USER || '',
  webPassword: process.env.WEB_PASSWORD || '',

  // VNC / noVNC (lancés à la demande depuis l'interface)
  vncPort: Number(process.env.VNC_PORT || 5900),
  novncPort: Number(process.env.NOVNC_PORT || 6080),
  vncIdleTimeout: Number(process.env.VNC_IDLE_TIMEOUT || 1800) * 1000, // 30 min

  // Prime Gaming : par défaut on ne prend que les jeux, pas le loot in-game
  primeClaimLoot: bool(process.env.PRIME_CLAIM_LOOT, false),
  // Activation automatique des clés Prime sur le store partenaire (GOG, etc.)
  autoRedeemKeys: bool(process.env.AUTO_REDEEM_KEYS, true),
  // E-mail utilisé pour les activations Legacy Games (pas de compte requis)
  legacyEmail: process.env.LEGACY_EMAIL || '',

  // Steam : ids de packages supplémentaires à activer (séparés par des virgules)
  steamExtraSubids: list(process.env.STEAM_EXTRA_SUBIDS, []),

  // URL publique de l'interface, utilisée dans les notifications pour envoyer
  // un lien cliquable qui ouvre le VNC et débloque un captcha.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  attentionTtl: Number(process.env.ATTENTION_TTL || 86400) * 1000,

  // Catégories de notification actives :
  //   claim     → résultat du claim automatique
  //   failure   → échec d'un claim
  //   captcha   → demande d'intervention (lien VNC)
  //   available → liste des jeux gratuits détectés
  notifyEvents: list(process.env.NOTIFY_EVENTS, ['claim', 'failure', 'captcha']),

  // Notifications
  discordWebhook: process.env.DISCORD_WEBHOOK || '',
  slackWebhook: process.env.SLACK_WEBHOOK || '',
  // Webhook générique : {{title}} et {{text}} sont remplacés dans le gabarit.
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookMethod: (process.env.WEBHOOK_METHOD || 'POST').toUpperCase(),
  webhookTemplate: process.env.WEBHOOK_TEMPLATE || '{"title":"{{title}}","message":"{{text}}"}',
  webhookContentType: process.env.WEBHOOK_CONTENT_TYPE || 'application/json',
  // SMS via l'API Free Mobile (FR, gratuite pour les abonnés)
  freeMobileUser: process.env.FREEMOBILE_USER || '',
  freeMobilePass: process.env.FREEMOBILE_PASS || '',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  ntfyTopic: process.env.NTFY_TOPIC || '',
  ntfyServer: process.env.NTFY_SERVER || 'https://ntfy.sh',
  notifyOnNothing: bool(process.env.NOTIFY_ON_NOTHING, false),

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // Moteur par store, surchargeable depuis l'interface.
  browserPerProvider: {},
};

/**
 * Réglages modifiables depuis l'interface (et persistés dans state.json).
 * Les valeurs de .env servent de défauts ; on les surcharge à chaud, ce qui
 * évite de redémarrer le conteneur pour changer un webhook.
 */
export const EDITABLE = [
  'cron', 'cronDetect', 'dryRun', 'notifyOnNothing', 'primeClaimLoot', 'autoRedeemKeys',
  'publicUrl', 'legacyEmail', 'notifyEvents',
  'discordWebhook', 'slackWebhook', 'telegramToken', 'telegramChatId',
  'ntfyTopic', 'ntfyServer', 'webhookUrl', 'webhookMethod', 'webhookTemplate',
  'freeMobileUser', 'freeMobilePass', 'browserPerProvider',
];

// Correspondance réglage → variable d'environnement. Une variable non vide dans
// .env « force » la valeur : l'interface l'affiche verrouillée, et un réglage
// enregistré ne peut plus la surcharger.
export const ENV_KEYS = {
  cron: 'CRON_SCHEDULE',
  cronDetect: 'DETECT_SCHEDULE',
  dryRun: 'DRY_RUN',
  notifyOnNothing: 'NOTIFY_ON_NOTHING',
  primeClaimLoot: 'PRIME_CLAIM_LOOT',
  autoRedeemKeys: 'AUTO_REDEEM_KEYS',
  publicUrl: 'PUBLIC_URL',
  legacyEmail: 'LEGACY_EMAIL',
  notifyEvents: 'NOTIFY_EVENTS',
  discordWebhook: 'DISCORD_WEBHOOK',
  slackWebhook: 'SLACK_WEBHOOK',
  telegramToken: 'TELEGRAM_BOT_TOKEN',
  telegramChatId: 'TELEGRAM_CHAT_ID',
  ntfyTopic: 'NTFY_TOPIC',
  ntfyServer: 'NTFY_SERVER',
  webhookUrl: 'WEBHOOK_URL',
  webhookMethod: 'WEBHOOK_METHOD',
  webhookTemplate: 'WEBHOOK_TEMPLATE',
  freeMobileUser: 'FREEMOBILE_USER',
  freeMobilePass: 'FREEMOBILE_PASS',
};

const isSet = (name) => {
  const v = process.env[name];
  return v !== undefined && String(v).trim() !== '';
};

/** { réglage: 'NOM_DE_VARIABLE' } pour tout ce qui est verrouillé par .env. */
export function forcedSettings() {
  const forced = {};
  for (const [key, env] of Object.entries(ENV_KEYS)) {
    if (isSet(env)) forced[key] = env;
  }
  const perProvider = {};
  for (const p of Object.keys(PROVIDER_ENV)) {
    if (isSet(PROVIDER_ENV[p])) perProvider[p] = PROVIDER_ENV[p];
  }
  if (Object.keys(perProvider).length) forced.browserPerProvider = perProvider;
  return forced;
}

export function applySettings(patch = {}) {
  const forced = forcedSettings();
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.includes(k) || v === undefined) continue;
    // .env a le dernier mot sur ce qu'il définit explicitement.
    if (forced[k] && k !== 'browserPerProvider') continue;
    if (k === 'browserPerProvider') {
      const locked = forced.browserPerProvider || {};
      config.browserPerProvider = Object.fromEntries(
        Object.entries(v || {}).filter(([provider]) => !locked[provider]),
      );
      continue;
    }
    config[k] = k === 'publicUrl' ? String(v).replace(/\/$/, '') : v;
  }
  return snapshot();
}

export function snapshot() {
  return Object.fromEntries(EDITABLE.map((k) => [k, config[k]]));
}

// Epic sert un Turnstile Cloudflare en boucle à Chrome/Chromium (constaté en
// headless comme en headed) là où Firefox passe. Chaque store ayant son propre
// profil, on peut mélanger les moteurs. Surchargeable par store :
// BROWSER_EPIC, BROWSER_STEAM, BROWSER_GOG, BROWSER_PRIME.
const BROWSER_DEFAULTS = { epic: 'firefox' };

// Variable d'environnement dédiée à chaque store.
const PROVIDER_ENV = Object.fromEntries(
  ['epic', 'steam', 'gog', 'prime', 'legacy'].map((p) => [p, `BROWSER_${p.toUpperCase()}`]),
);

export const browserFor = (provider) => {
  const chosen =
    config.browserPerProvider?.[provider] ||
    process.env[`BROWSER_${String(provider).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] ||
    BROWSER_DEFAULTS[provider] ||
    config.browser;
  return String(chosen).toLowerCase();
};
