import { config } from './config.js';
import nodemailer from 'nodemailer';
import { makeLogger } from './logger.js';

const log = makeLogger('notify');

// Échappe une valeur pour l'insérer dans le gabarit JSON du webhook générique.
const jsonEscape = (s) => JSON.stringify(String(s)).slice(1, -1);

const post = async (url, body, headers = {}) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
};

const channels = [
  {
    name: 'discord',
    enabled: () => Boolean(config.discordWebhook),
    send: (title, text) => post(config.discordWebhook, { content: `**${title}**\n${text}`.slice(0, 1900) }),
  },
  {
    name: 'slack',
    enabled: () => Boolean(config.slackWebhook),
    send: (title, text) => post(config.slackWebhook, { text: `*${title}*\n${text}`.slice(0, 3000) }),
  },
  {
    name: 'webhook',
    enabled: () => Boolean(config.webhookUrl),
    // Gabarit libre : permet de brancher n'importe quel service (Gotify, Pushover,
    // Home Assistant, passerelle SMS…) sans code supplémentaire.
    send: async (title, text) => {
      const body = config.webhookTemplate
        .replaceAll('{{title}}', jsonEscape(title))
        .replaceAll('{{text}}', jsonEscape(text));
      const res = await fetch(config.webhookUrl, {
        method: config.webhookMethod,
        headers: { 'content-type': config.webhookContentType },
        body: config.webhookMethod === 'GET' ? undefined : body,
      });
      if (!res.ok) throw new Error(`${res.status}`);
    },
  },
  {
    name: 'sms-free',
    enabled: () => Boolean(config.freeMobileUser && config.freeMobilePass),
    send: async (title, text) => {
      const url = new URL('https://smsapi.free-mobile.fr/sendmsg');
      url.searchParams.set('user', config.freeMobileUser);
      url.searchParams.set('pass', config.freeMobilePass);
      url.searchParams.set('msg', `${title}\n${text}`.slice(0, 900));
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`${res.status}`);
    },
  },
  {
    name: 'telegram',
    enabled: () => Boolean(config.telegramToken && config.telegramChatId),
    send: (title, text) =>
      post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        chat_id: config.telegramChatId,
        text: `${title}\n${text}`.slice(0, 4000),
        disable_web_page_preview: true,
      }),
  },
  {
    name: 'email',
    // Actif dès qu'on a un serveur et un destinataire ; l'authentification est
    // optionnelle (relais local ouvert).
    enabled: () => Boolean(config.smtpHost && config.smtpTo),
    send: async (title, text) => {
      const transport = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        ...(config.smtpUser ? { auth: { user: config.smtpUser, pass: config.smtpPass } } : {}),
      });
      await transport.sendMail({
        from: config.smtpFrom || config.smtpUser || `claim-auto@${config.smtpHost}`,
        to: config.smtpTo,
        subject: title,
        text: config.publicUrl ? `${text}\n\nInterface : ${config.publicUrl}` : text,
      });
    },
  },
  {
    name: 'ntfy',
    enabled: () => Boolean(config.ntfyTopic),
    // API JSON plutôt que les en-têtes : un titre avec emoji ou accent ne peut
    // pas passer par l'en-tête Title, limité au Latin-1 (« Cannot convert
    // argument to a ByteString »).
    send: (title, text) =>
      post(`${config.ntfyServer.replace(/\/$/, '')}/`, {
        topic: config.ntfyTopic,
        title,
        message: text,
        ...(config.publicUrl ? { click: config.publicUrl } : {}),
      }),
  },
];

/** Notifie seulement si la catégorie est activée (NOTIFY_EVENTS). */
export async function notifyEvent(kind, title, text) {
  if (!config.notifyEvents.includes(kind)) {
    log.debug(`notification ${kind} désactivée`);
    return;
  }
  return notify(title, text);
}

export async function notify(title, text) {
  const active = channels.filter((c) => c.enabled());
  if (!active.length) return { sent: [], failed: [] };

  const sent = [];
  const failed = [];
  await Promise.all(
    active.map((c) =>
      c
        .send(title, text)
        .then(() => sent.push(c.name))
        .catch((err) => {
          log.warn(`échec notification ${c.name}:`, err.message);
          failed.push({ channel: c.name, error: err.message });
        }),
    ),
  );
  return { sent, failed };
}

export function formatReport(results) {
  const lines = [];
  let claimed = 0;
  let errors = 0;

  for (const r of results) {
    const head = `${r.provider.toUpperCase()}`;
    if (r.status === 'skipped') {
      lines.push(`${head} — ignoré (${r.reason})`);
      continue;
    }
    if (r.status === 'error') {
      errors += 1;
      lines.push(`${head} — ERREUR: ${r.error}`);
      continue;
    }
    claimed += r.claimed.length;
    if (r.claimed.length) lines.push(`${head} — ${r.claimed.map((g) => `✅ ${g.title}`).join(', ')}`);
    else lines.push(`${head} — rien de nouveau (${r.seen} offre(s) vues)`);

    // Ce qui n'a pas pu être pris automatiquement : on donne le lien pour le
    // faire à la main.
    for (const o of r.offers || []) {
      if (!['captcha', 'manual', 'unknown', 'error'].includes(o.status)) continue;
      lines.push(`   ⚠️ ${o.title} (${o.status}) — à réclamer à la main : ${o.url}`);
    }
  }

  return { claimed, errors, body: lines.join('\n') || 'Aucun provider exécuté.' };
}
