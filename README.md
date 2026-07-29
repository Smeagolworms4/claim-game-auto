# claim-auto

*Read this in [French](README.fr.md).*

Automatically claims the free games from the **Epic Games Store**, **Steam**, **GOG** and
**Amazon Prime Gaming / Luna**. Node.js + Playwright, runs in Docker, with a web
interface to see what is available and a built-in VNC for the logins.

![providers](https://img.shields.io/badge/stores-epic%20%7C%20steam%20%7C%20gog%20%7C%20prime-6ee7a8)

## What it does

- **Detects** the currently free games on the 4 stores (works even when not logged in).
- **Claims** them automatically, twice a day by default (configurable cron).
- **Web interface** (port 8080, Vue 3 + Vuetify): detected offers, login state per store, live log, history, "Detect" / "Claim" buttons.
- **On-demand VNC**: to log in to a store (password + 2FA), the interface opens a real Chrome inside the container, displayed in the page. As soon as you click "I'm done", the VNC is shut down and everything goes back to headless.
- Timestamped **history** of every attempt (`data/history.json`), browsable from the interface.
- **Notifications** by category (Discord, Slack, Telegram, ntfy, generic webhook, Free Mobile SMS): claim result, failure, available games, and an **unlock request with a link that opens the VNC** — once unlocked, the claim resumes on its own.
- **Settings in the interface**, persisted: everything that is not forced in `.env` can be set graphically (webhooks, schedules, browser per store…).
- **Cookie import**: if a captcha blocks the login inside the VNC, you log in with your usual browser and paste the cookies.
- Remembers what has already been claimed (`data/state.json`) so it does not retry in a loop.

## Getting started

```bash
cp .env.example .env      # adjust TZ, cron, notifications…
docker compose up -d
```

Then open **http://localhost:8080**.

For each store: click **"Login"**, log in inside the browser that is displayed
(password, 2FA, possible captcha), then click **"I'm done"**. The profile is saved
in `data/profiles/<store>/` — this only has to be done once.

If a captcha prevents you from logging in there, use the **cookie import** (🍪 button):
see *Troubleshooting*.

After that, nothing left to do: the cron handles the rest.

### Testing without waiting for the cron

```bash
docker compose run --rm test detect        # just list what is free
docker compose run --rm test detect epic   # a single store
docker compose run --rm test run           # claim now
docker compose run --rm test run gog
docker compose run --rm test status        # what has already been claimed
```

Or from the web interface ("Detect" / "Claim" buttons).
The **Simulation** mode (settings, or `DRY_RUN=true`) detects without confirming anything.

### Without Docker

```bash
npm install && npx playwright install chromium
node src/index.js daemon
```

### Architectures

The image works on **amd64** and on **arm64** (Raspberry Pi, Apple Silicon, `aarch64`
Home Assistant add-on): Chromium is available for both, hence it being the default.

Google Chrome, on the other hand, is only published for amd64. If you want to use it
anyway — its fingerprint is a bit more ordinary for anti-bot protections — build the
image with:

```bash
docker compose build --build-arg INSTALL_CHROME=true
# then BROWSER=chrome in .env, or the matching setting in the interface
```

The code checks whether the binary is present at startup and silently falls back to
Chromium if it is missing, so the same image stays usable everywhere.

## Configuration

Everything happens in `.env` (see `.env.example`). The settings that matter:

| Variable | Default | Purpose |
|---|---|---|
| `CRON_SCHEDULE` | `5 12,20 * * *` | When to claim (5-field cron) |
| `DETECT_SCHEDULE` | `0 */6 * * *` | When to refresh the game list (empty = disabled) |
| `PUBLIC_URL` | empty | Public URL, for the unlock links sent in notifications |
| `NOTIFY_EVENTS` | `claim,failure,captcha` | Notified categories (plus `available`) |
| `SLACK_WEBHOOK`, `WEBHOOK_URL`, `FREEMOBILE_USER`/`_PASS` | empty | Other channels |
| `PROVIDERS` | `epic,steam,gog,prime` | Active stores |
| `COUNTRY` / `LOCALE` | `FR` / `fr-FR` | Store country (prices and offers depend on it) |
| `BROWSER` | `chromium` | `chromium` (amd64 + arm64), `chrome` (amd64, image built with `INSTALL_CHROME=true`) or `firefox` |
| `HEADLESS` | `true` | Scheduled runs without a display |
| `DRY_RUN` | `false` | Detect without claiming |
| `WEB_USER` / `WEB_PASSWORD` | empty | Basic auth on the interface |
| `WEB_PORT_HOST` | `8080` | Host-side port if 8080 is taken |
| `PRIME_CLAIM_LOOT` | `false` | Also claim the Prime in-game loot |
| `AUTO_REDEEM_KEYS` | `true` | Redeem the Prime keys on the partner store after a run |
| `LEGACY_EMAIL` | empty | E-mail for the Legacy Games activations |
| `STEAM_EXTRA_SUBIDS` | empty | Extra Steam packages to activate |
| `DISCORD_WEBHOOK`, `TELEGRAM_*`, `NTFY_TOPIC` | empty | Notifications |

> **A single browser for all the stores**: Chromium. Switching from `chromium` to `chrome`
> keeps the sessions (same profile family); switching to `firefox` does not — the profiles
> are wiped and you have to log in again.

## Settings: interface first, `.env` as a fallback

The variables in `.env` are only **default values**. Everything can be set from the
interface (⚙️ icon) and is persisted in `data/state.json`, applied on the fly —
changing a schedule or a webhook requires no restart.

Conversely, a **non-empty** variable in `.env` *locks* the setting: the field appears
greyed out in the interface, with the name of the variable responsible. Handy to pin a
value down (managed deployment, injected secret), annoying when it is unintentional —
hence the commented-out default values in `.env.example`.

## Notifications and remote unlocking

Four categories, each of which can be enabled separately:

| Category | When |
|---|---|
| `claim` | report of the automatic claim |
| `failure` | a claim failed, or a key could not be redeemed (the key and the store link are in the message) |
| `captcha` | human intervention is required |
| `available` | free games have been detected |

Channels: Discord, Slack, Telegram, ntfy, **SMS through the Free Mobile API**, and a
**generic webhook** with a free-form template (`{{title}}` / `{{text}}`) to plug in
Gotify, Home Assistant, an SMS gateway, etc.

The `captcha` notification contains a **single-use link** (`PUBLIC_URL/unlock/<token>`):
opening it starts the VNC on the right store, displays the browser, and the
"It's unlocked" button closes the session **and restarts the claim for that store**.
The link carries its own secret: it works without a password, and survives a restart.

## Architecture

```
src/
  index.js            CLI + daemon (cron)
  runner.js           orchestration: detect → claim → notify
  browser.js          persistent Playwright contexts (one profile per store)
  login.js            manual login sessions (visible browser)
  vnc.js              Xvfb / x11vnc / noVNC, started on demand
  lock.js             a single browser at a time
  state.js            already claimed games + history
  notify.js           Discord / Telegram / ntfy
  providers/          a separate handler per store
    epic.js  steam.js  gog.js  prime.js
  attention.js        intervention requests + single-use unlock links
  cookies.js          cookie import from another browser
  web/                HTTP server + Vue 3 / Vuetify dashboard (a single page,
                      no build step; Vue, Vuetify and the icons are served from
                      node_modules, so no CDN is required)
```

Each handler declares **what it is able to do** — every function is optional:

```js
export default {
  name: 'mystore',
  label: 'My Store',
  loginUrl: 'https://…',
  async isLoggedIn(page)   { /* → bool                                     */ },
  async list(page)         { /* → [{ id, title, url }]  free offers        */ },
  async claim(page, offer) { /* → { status } claim ("keep") the offer      */ },
  async addKey(page, code) { /* → { status } redeem a key on this store    */ },
};
```
…then register it in `src/providers/index.js`. A store can be an **offer source**, a
**key redemption target**, or both:

| Handler | `list` | `claim` | `addKey` |
|---|:--:|:--:|:--:|
| epic | ✅ | ✅ | ✅ |
| steam | ✅ | ✅ | ✅ |
| gog | ✅ | ✅ | ✅ |
| prime | ✅ | ✅ | — |
| legacy | — | — | ✅ |

`GET /api/status` returns the capabilities of every handler, and during runs the runner
automatically skips those that have no `list` (Legacy Games).

### Prime keys → GOG / Legacy Games

Many Prime/Luna offers are not claimed on the spot: they hand out a **key to redeem on a
partner store**. The flow is automatic:

1. `prime.claim()` retrieves the key and identifies the target store — through the links
   on the Amazon page, otherwise through the slug suffix (`…-gog`, `…-legacy`, `…-ms`).
2. The key is saved in `data/state.json` (it is never lost, even if the redemption fails).
3. The runner calls the target store's `addKey()` **inside that store's browser
   context** — a GOG key needs the GOG session, not the Amazon one.
4. Pending keys are shown in the interface ("Keys to redeem" panel), with a button to
   retry the redemption.

Legacy Games does not require an account, just an e-mail: fill in `LEGACY_EMAIL`.
Targets that are not automated (Microsoft Store) are marked `manual` with the key
in plain text in the interface.

## How each store is handled

| Store | Detection | Claim |
|---|---|---|
| **Epic** | Public `freeGamesPromotions` API (offer at -100% *and* effective price at 0) | Product page → `Get` → order iframe → `Place Order` |
| **Steam** | `maxprice=free&specials=1` search (promotions you get to "keep") | `addfreelicense` form on the game page |
| **GOG** | `#giveaway` banner on the home page | `/giveaway/claim` endpoint (JSON) |
| **Prime / Luna** | `gaming.amazon.com`, *Games* tab (plus *In-game loot* optionally) | `Claim` button on the offer page; any key is logged and notified |

**Luna**: Prime Gaming offers feed the Luna library of the same Amazon account — there is
no separate Luna claim.

## Docker Hub image and automatic publication

The image is published on Docker Hub as **`smeagolworms4/claim-game-auto`**
(`latest` and `main` tags), for `linux/amd64` and `linux/arm64`. It ships with Chromium
only: `INSTALL_CHROME` is left at its default value of `false`, because Google Chrome is
only published for amd64 and would break the arm64 build.

```bash
docker run -d \
  --name claim-auto \
  --restart unless-stopped \
  --stop-timeout 45 \
  --user 1000:1000 \
  --env-file .env \
  -e HOME=/data/home \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  --shm-size 1gb \
  smeagolworms4/claim-game-auto:latest
```

Ports `6080` (noVNC) and `5900` (raw VNC) only need to be published for a standalone VNC
client: the web interface already proxies noVNC on its own port 8080.

### GitHub secrets to create by hand

Two GitHub Actions workflows are provided in `.github/workflows/`:
`build_images.yml` (multi-architecture build + image push) and `push_readme.yml`
(synchronisation of the Docker Hub description from this README).

Both need **two repository secrets** that cannot be created by the code: they have to be
added by hand in the GitHub repository's *Settings → Secrets and variables → Actions*.

| Secret | Content |
|---|---|
| `DOCKER_USERNAME` | your Docker Hub username (it is also used to build the image name) |
| `DOCKER_PASSWORD` | a Docker Hub *access token* (Account Settings → Security → New Access Token) |

Without those two secrets, the workflows fail at the Docker Hub login step.

## Troubleshooting

### Cloudflare captcha in a loop

Symptom: inside the VNC, the "Verify you are human" checkbox restarts endlessly and you
cannot log in.

**The challenge is intermittent**: on the very same Epic page, a few hours apart, Chrome
and Firefox were both blocked and then both let through. So it is not the engine that
decides — it is the reputation of the IP at the time of the request. Switching browsers
may unblock you there and then, but it fixes nothing durably.

In practice: **trying again later** is often enough (the profile keeps its `cf_clearance`
once obtained), and the **cookie import** settles the case for good.

If *all* the stores loop, including in your usual browser on the same machine, the
problem is your **IP address** (VPN, hosting-provider IP, poorly-rated range) and not the
automation: Cloudflare is challenging the IP. Test the page in your host browser to find
out.

### The captcha cannot be beaten, even in Firefox

Look at **your IP** first. On a shared connection with a bad reputation (Starlink and its
CGNAT, VPN, hosting-provider IP), Cloudflare and Google challenge the address itself: no
browser setting will change anything about it.

The way around it is to **not log in from the container**:

1. log in to the store with your usual browser;
2. export the site's cookies (an extension such as *Cookie-Editor* → Export JSON);
3. in the interface, 🍪 button on the store card, paste, import.

The session is then recognised and headless runs work normally — the captcha was the only
step that was getting stuck.

### A store shows "unknown" or "not logged in" even though I just logged in

The login state comes from the last detection. After a successful login, a detection is
run again automatically — wait a few seconds, or click **Detect**. If it persists, look at
the log: the real reason is in there (challenge, expired session…).

Watch out for one pitfall: **do not restart the container while a login session is
open**. Chrome only writes its cookies when it closes; an abrupt shutdown loses the
session (and leaves a profile lock behind, which the tool now cleans up on the next
startup). Always click "I'm done" before touching the container.

## Known limitations

- **Prime offers requiring a linked account** (GOG, Epic, Microsoft, Legacy Games): the
  claim and the key redemption are automated for GOG, Epic, Steam and Legacy, but if
  Amazon requires the account to be *linked*, the offer is marked *"manual action"* — to
  be done once through the VNC. The Microsoft Store is not automated: the key is
  displayed. Same goes for the few cards in the Amazon carousel that do not expose a
  product page: they are detected, but have to be claimed by hand if the automatic click
  fails.
- **Epic is served by Firefox** and not by Chrome, because of the Cloudflare Turnstile
  (see *Troubleshooting*). Free game detection, however, goes through the public API and
  is never affected.
- **Epic captcha at claim time**: rare once the session is established. The claim is then
  marked `captcha` with a screenshot in `data/screenshots/` — open the VNC and do it by hand.
- **Steam** limits you to ~50 free license activations per hour.
- The selectors follow the stores' HTML: a redesign on the store side can break a
  handler. The log and the screenshots are there to diagnose it.
- Sessions expire after a few weeks/months: the interface shows *"not logged in"*, you
  just have to redo the VNC login.

## Security

No credentials are stored by the tool: only the **session cookies** live in the browser
profiles (`data/profiles/`). Back that folder up as you would a secret, and set
`WEB_USER`/`WEB_PASSWORD` if you expose the interface beyond your local network.

The compose file's `6080`/`5900` ports are only useful for a standalone VNC client: the
web interface already proxies noVNC on its own port. You can remove them.

## Disclaimer

A tool meant for personal use, on your own accounts. Activating free licenses is a native
Steam feature; on the Epic, Amazon and GOG side it is about automating an action you would
otherwise perform by hand — something their terms of service do not encourage. Space the
runs out (the default, 2×/day, is already conservative) and use it knowingly.
