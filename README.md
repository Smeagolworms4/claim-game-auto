# claim-auto

Réclame automatiquement les jeux gratuits **Epic Games Store**, **Steam**, **GOG** et
**Amazon Prime Gaming / Luna**. Node.js + Playwright, tourne en Docker, avec une
interface web pour voir ce qui est dispo et un VNC intégré pour les connexions.

![providers](https://img.shields.io/badge/stores-epic%20%7C%20steam%20%7C%20gog%20%7C%20prime-6ee7a8)

## Ce que ça fait

- **Détecte** les jeux gratuits en cours sur les 4 stores (fonctionne même sans être connecté).
- **Réclame** automatiquement, deux fois par jour par défaut (cron configurable).
- **Interface web** (port 8080, Vue 3 + Vuetify) : offres détectées, état de connexion par store, journal en direct, historique, boutons « Détecter » / « Réclamer ».
- **VNC à la demande** : pour se connecter à un store (mot de passe + 2FA), l'interface ouvre un vrai Chrome dans le conteneur, affiché dans la page. Dès que tu cliques « J'ai fini », le VNC est coupé et tout repasse en headless.
- **Historique** horodaté de chaque tentative (`data/history.json`), consultable dans l'interface.
- **Notifications** par catégorie (Discord, Slack, Telegram, ntfy, webhook générique, SMS Free Mobile) : résultat du claim, échec, jeux disponibles, et **demande de déblocage avec un lien qui ouvre le VNC** — une fois débloqué, le claim reprend tout seul.
- **Réglages dans l'interface**, persistés : tout ce qui n'est pas imposé dans `.env` se règle graphiquement (webhooks, plannings, navigateur par store…).
- **Import de cookies** : si un captcha bloque la connexion dans le VNC, tu te connectes dans ton navigateur habituel et tu colles les cookies.
- Mémorise ce qui a déjà été pris (`data/state.json`) pour ne pas re-tenter en boucle.

## Démarrage

```bash
cp .env.example .env      # ajuste TZ, cron, notifications…
docker compose up -d
```

Puis ouvre **http://localhost:8080**.

Pour chaque store : clique **« Connexion »**, connecte-toi dans le navigateur qui
s'affiche (mot de passe, 2FA, captcha éventuel), puis clique **« J'ai fini »**. Le profil
est sauvegardé dans `data/profiles/<store>/` — c'est à faire une seule fois.

Si un captcha t'empêche de te connecter là, utilise l'**import de cookies** (bouton 🍪) :
voir *Dépannage*.

Ensuite, plus rien à toucher : le cron fait le reste.

### Tester sans attendre le cron

```bash
docker compose run --rm test detect        # juste lister ce qui est gratuit
docker compose run --rm test detect epic   # un seul store
docker compose run --rm test run           # réclamer maintenant
docker compose run --rm test run gog
docker compose run --rm test status        # ce qui a déjà été pris
```

Ou depuis l'interface web (boutons « Détecter » / « Réclamer »).
Le mode **Simulation** (réglages, ou `DRY_RUN=true`) détecte sans rien valider.

### Sans Docker

```bash
npm install && npx playwright install chromium
node src/index.js daemon
```

### Architectures

L'image fonctionne en **amd64** et en **arm64** (Raspberry Pi, Apple Silicon, addon Home
Assistant `aarch64`) : Chromium est disponible pour les deux, d'où son choix par défaut.

Google Chrome, lui, n'est publié qu'en amd64. Si tu veux l'utiliser malgré tout — son
empreinte est un peu plus banale pour les protections anti-bot — construis l'image avec :

```bash
docker compose build --build-arg INSTALL_CHROME=true
# puis BROWSER=chrome dans .env, ou le réglage correspondant dans l'interface
```

Le code vérifie la présence du binaire au lancement et retombe silencieusement sur
Chromium s'il est absent, donc la même image reste utilisable partout.

## Configuration

Tout se passe dans `.env` (voir `.env.example`). Les réglages qui comptent :

| Variable | Défaut | Rôle |
|---|---|---|
| `CRON_SCHEDULE` | `5 12,20 * * *` | Quand réclamer (cron 5 champs) |
| `DETECT_SCHEDULE` | `0 */6 * * *` | Quand rafraîchir la liste des jeux (vide = désactivé) |
| `PUBLIC_URL` | vide | URL publique, pour les liens de déblocage envoyés en notification |
| `NOTIFY_EVENTS` | `claim,failure,captcha` | Catégories notifiées (+ `available`) |
| `SLACK_WEBHOOK`, `WEBHOOK_URL`, `FREEMOBILE_USER`/`_PASS` | vide | Autres canaux |
| `PROVIDERS` | `epic,steam,gog,prime` | Stores actifs |
| `COUNTRY` / `LOCALE` | `FR` / `fr-FR` | Pays du store (prix et offres en dépendent) |
| `BROWSER` | `chromium` | `chromium` (amd64 + arm64), `chrome` (amd64, image construite avec `INSTALL_CHROME=true`) ou `firefox` |
| `HEADLESS` | `true` | Runs planifiés sans affichage |
| `DRY_RUN` | `false` | Détecte sans réclamer |
| `WEB_USER` / `WEB_PASSWORD` | vide | Auth basique sur l'interface |
| `WEB_PORT_HOST` | `8080` | Port côté hôte si 8080 est pris |
| `PRIME_CLAIM_LOOT` | `false` | Réclamer aussi le loot in-game Prime |
| `AUTO_REDEEM_KEYS` | `true` | Activer les clés Prime sur le store partenaire après un run |
| `LEGACY_EMAIL` | vide | E-mail pour les activations Legacy Games |
| `STEAM_EXTRA_SUBIDS` | vide | Packages Steam à activer en plus |
| `DISCORD_WEBHOOK`, `TELEGRAM_*`, `NTFY_TOPIC` | vide | Notifications |

> **Un seul navigateur pour tous les stores** : Chromium. Passer de `chromium` à `chrome`
> conserve les sessions (même famille de profil) ; passer à `firefox`, non — les profils
> sont effacés et il faut refaire les connexions.

## Réglages : interface d'abord, `.env` en secours

Les variables de `.env` ne sont que des **valeurs par défaut**. Tout se règle dans
l'interface (icône ⚙️) et est persisté dans `data/state.json`, appliqué à chaud —
changer un planning ou un webhook ne demande aucun redémarrage.

Inversement, une variable **non vide** dans `.env` *verrouille* le réglage : le champ
apparaît grisé dans l'interface avec le nom de la variable en cause. Pratique pour
figer une valeur (déploiement géré, secret injecté), gênant si c'est involontaire —
d'où les valeurs par défaut commentées dans `.env.example`.

## Notifications et déblocage à distance

Quatre catégories, activables séparément :

| Catégorie | Quand |
|---|---|
| `claim` | compte rendu du claim automatique |
| `failure` | échec d'un claim, ou clé impossible à activer (la clé et le lien du store sont dans le message) |
| `captcha` | une intervention humaine est nécessaire |
| `available` | des jeux gratuits ont été détectés |

Canaux : Discord, Slack, Telegram, ntfy, **SMS via l'API Free Mobile**, et un
**webhook générique** au gabarit libre (`{{title}}` / `{{text}}`) pour brancher
Gotify, Home Assistant, une passerelle SMS, etc.

La notification `captcha` contient un **lien à usage unique** (`PUBLIC_URL/unlock/<jeton>`) :
l'ouvrir démarre le VNC sur le bon store, affiche le navigateur, et le bouton
« C'est débloqué » referme la session **et relance le claim de ce store**. Le lien porte
son propre secret : il fonctionne sans mot de passe, et survit à un redémarrage.

## Architecture

```
src/
  index.js            CLI + daemon (cron)
  runner.js           orchestration : détecte → réclame → notifie
  browser.js          contextes Playwright persistants (un profil par store)
  login.js            sessions de connexion manuelles (navigateur visible)
  vnc.js              Xvfb / x11vnc / noVNC, démarrés à la demande
  lock.js             un seul navigateur à la fois
  state.js            jeux déjà réclamés + historique
  notify.js           Discord / Telegram / ntfy
  providers/          un handler séparé par store
    epic.js  steam.js  gog.js  prime.js
  attention.js        demandes d'intervention + liens de déblocage à usage unique
  cookies.js          import de cookies depuis un autre navigateur
  web/                serveur HTTP + dashboard Vue 3 / Vuetify (une seule page,
                      sans build ; Vue, Vuetify et les icônes sont servis depuis
                      node_modules, donc aucun CDN requis)
```

Chaque handler déclare **ce qu'il sait faire** — toutes les fonctions sont optionnelles :

```js
export default {
  name: 'monstore',
  label: 'Mon Store',
  loginUrl: 'https://…',
  async isLoggedIn(page)   { /* → bool                                   */ },
  async list(page)         { /* → [{ id, title, url }]  offres gratuites */ },
  async claim(page, offer) { /* → { status } récupérer (« keep ») l'offre */ },
  async addKey(page, code) { /* → { status } activer une clé sur ce store */ },
};
```
…puis l'enregistrer dans `src/providers/index.js`. Un store peut être **source
d'offres**, **cible d'activation de clés**, ou les deux :

| Handler | `list` | `claim` | `addKey` |
|---|:--:|:--:|:--:|
| epic | ✅ | ✅ | ✅ |
| steam | ✅ | ✅ | ✅ |
| gog | ✅ | ✅ | ✅ |
| prime | ✅ | ✅ | — |
| legacy | — | — | ✅ |

`GET /api/status` renvoie les capacités de chaque handler, et le runner saute
automatiquement dans les runs ceux qui n'ont pas de `list` (Legacy Games).

### Clés Prime → GOG / Legacy Games

Beaucoup d'offres Prime/Luna ne sont pas récupérées sur place : elles donnent une
**clé à activer sur un store partenaire**. Le flux est automatique :

1. `prime.claim()` récupère la clé et identifie le store cible — via les liens de
   la page Amazon, sinon via le suffixe du slug (`…-gog`, `…-legacy`, `…-ms`).
2. La clé est enregistrée dans `data/state.json` (elle n'est jamais perdue, même
   si l'activation échoue).
3. Le runner appelle `addKey()` du store cible **dans le contexte navigateur de
   ce store** — une clé GOG a besoin de la session GOG, pas de celle d'Amazon.
4. Les clés en attente s'affichent dans l'interface (panneau « Clés à activer »),
   avec un bouton pour relancer l'activation.

Legacy Games ne demande pas de compte, juste un e-mail : renseigne `LEGACY_EMAIL`.
Les cibles non automatisées (Microsoft Store) sont marquées `manual` avec la clé
en clair dans l'interface.

## Comment chaque store est géré

| Store | Détection | Claim |
|---|---|---|
| **Epic** | API publique `freeGamesPromotions` (offre à -100 % *et* prix effectif à 0) | Page produit → `Obtenir` → iframe de commande → `Commander` |
| **Steam** | Recherche `maxprice=free&specials=1` (promos « à conserver ») | Formulaire `addfreelicense` de la page du jeu |
| **GOG** | Bannière `#giveaway` de la home | Endpoint `/giveaway/claim` (JSON) |
| **Prime / Luna** | `gaming.amazon.com`, onglet *Games* (+ *In-game loot* en option) | Bouton `Claim` de la page de l'offre ; la clé éventuelle est loguée et notifiée |

**Luna** : les offres Prime Gaming alimentent la bibliothèque Luna du même compte
Amazon — il n'y a pas de claim Luna séparé.

## Dépannage

### Captcha Cloudflare en boucle

Symptôme : dans le VNC, la case « Vérifiez que vous êtes humain » se relance
indéfiniment et on ne peut pas se connecter.

**Le challenge est intermittent** : sur la même page Epic, à quelques heures
d'intervalle, Chrome et Firefox ont tous deux été bloqués puis tous deux passés. Ce
n'est donc pas le moteur qui décide — c'est la réputation de l'IP au moment de la
requête. Changer de navigateur peut débloquer sur le coup, mais ne règle rien de
façon durable.

En pratique : **réessayer plus tard** suffit souvent (le profil conserve son
`cf_clearance` une fois obtenu), et l'**import de cookies** règle le cas définitivement.

Si *tous* les stores bouclent, y compris dans ton navigateur habituel sur la même
machine, le problème est ton **adresse IP** (VPN, IP d'hébergeur, plage réputée) et non
l'automatisation : Cloudflare challenge l'IP. Teste la page dans ton navigateur hôte
pour trancher.

### Le captcha est infranchissable, même en Firefox

Regarde d'abord **ton IP**. Sur une connexion partagée à mauvaise réputation
(Starlink et son CGNAT, VPN, IP d'hébergeur), Cloudflare et Google challengent
l'adresse elle-même : aucun réglage de navigateur n'y changera quoi que ce soit.

La parade est de **ne pas se connecter depuis le conteneur** :

1. connecte-toi au store dans ton navigateur habituel ;
2. exporte les cookies du site (extension type *Cookie-Editor* → Export JSON) ;
3. dans l'interface, bouton 🍪 sur la carte du store, colle, importe.

La session est alors reconnue et les runs headless fonctionnent normalement — c'est
la seule étape qui butait sur le captcha.

### Un store affiche « inconnu » ou « non connecté » alors que je viens de me connecter

L'état de connexion vient de la dernière détection. Après un login réussi, une détection
est relancée automatiquement — attends quelques secondes, ou clique **Détecter**.
Si ça persiste, regarde le journal : la vraie raison y est (challenge, session expirée…).

Attention à un piège : **ne redémarre pas le conteneur pendant qu'une session de login
est ouverte**. Chrome n'écrit ses cookies qu'à la fermeture ; un arrêt brutal perd la
session (et laisse un verrou de profil, que le tool nettoie désormais au lancement
suivant). Clique toujours « J'ai fini » avant de toucher au conteneur.

## Limites connues

- **Offres Prime nécessitant un compte lié** (GOG, Epic, Microsoft, Legacy Games) : le
  claim et l'activation de clé sont automatisés pour GOG, Epic, Steam et Legacy, mais si
  Amazon exige le *linking* du compte, l'offre est marquée *« action manuelle »* — à faire
  une fois via le VNC. Le Microsoft Store n'est pas automatisé : la clé est affichée.
  Idem pour les quelques cartes du carrousel Amazon qui n'exposent pas de fiche
  produit : elles sont détectées, mais à réclamer à la main si le clic automatique échoue.
- **Epic est servi par Firefox** et pas par Chrome, à cause du Turnstile Cloudflare
  (voir *Dépannage*). La détection des jeux gratuits, elle, passe par l'API publique et
  n'est jamais affectée.
- **Captcha Epic au moment du claim** : rare une fois la session établie. Le claim est alors
  marqué `captcha` avec une capture dans `data/screenshots/` — ouvre le VNC et refais-le à la main.
- **Steam** limite à ~50 activations de licences gratuites par heure.
- Les sélecteurs suivent le HTML des boutiques : une refonte côté store peut casser un
  handler. Le journal et les captures d'écran servent à diagnostiquer.
- Les sessions expirent au bout de quelques semaines/mois : l'interface affiche
  *« non connecté »*, il suffit de refaire le login VNC.

## Sécurité

Aucun identifiant n'est stocké par l'outil : seuls les **cookies de session** vivent dans
les profils navigateur (`data/profiles/`). Sauvegarde ce dossier comme un secret, et mets
`WEB_USER`/`WEB_PASSWORD` si tu exposes l'interface au-delà de ton réseau local.

Les ports `6080`/`5900` du compose ne sont utiles que pour un client VNC lourd :
l'interface web proxifie déjà noVNC sur son propre port. Tu peux les retirer.

## Avertissement

Outil destiné à un usage personnel, sur tes propres comptes. L'activation de licences
gratuites est une fonction native de Steam ; côté Epic, Amazon et GOG il s'agit
d'automatiser une action que tu ferais à la main — ce que leurs conditions d'utilisation
n'encouragent pas. Espace les runs (le défaut, 2×/jour, est déjà conservateur) et
utilise-le en connaissance de cause.
