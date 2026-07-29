import { Cron } from 'croner';
import { config, applySettings } from './config.js';
import { log } from './logger.js';
import { runAll, detectAll } from './runner.js';
import { allNames } from './providers/index.js';
import * as state from './state.js';
import * as loginSession from './login.js';
import * as vnc from './vnc.js';
import { startWebServer, onReschedule } from './web/server.js';

const [, , cmd = 'daemon', arg] = process.argv;

const usage = () => {
  console.log(`
claim-auto — claim automatique des jeux gratuits

  daemon              interface web + planification (défaut)
  run [provider]      un passage de claim immédiat
  detect [provider]   détection seule, sans rien réclamer
  login <provider>    ouvre une session de connexion (VNC) et attend
  status              résumé de l'état local

  providers: ${allNames.join(', ')}
`);
};

async function main() {
  // Les réglages enregistrés depuis l'interface surchargent .env.
  applySettings(await state.settings());

  switch (cmd) {
    case 'run': {
      const { report } = await runAll({ claim: true, only: arg || null });
      console.log(report.body);
      process.exit(report.errors ? 1 : 0);
      break;
    }

    case 'detect': {
      const { results } = await detectAll(arg || null);
      for (const r of results) {
        console.log(`\n${(r.label || r.provider).toUpperCase()} — ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
        for (const o of r.offers || []) console.log(`  · ${o.title}${o.claimedBefore ? ' (déjà traité)' : ''}`);
      }
      break;
    }

    case 'login': {
      if (!arg) return usage();
      await loginSession.start(arg);
      log.info(`Ouvre http://localhost:${config.novncPort}/vnc.html pour te connecter.`);
      log.info('Appuie sur Ctrl+C une fois connecté (le profil est sauvegardé).');
      await new Promise((resolve) => process.on('SIGINT', resolve));
      const res = await loginSession.finish();
      log.info(res.loggedIn ? 'connecté ✅' : 'connexion non confirmée');
      break;
    }

    case 'status': {
      const st = await state.stats();
      console.log(JSON.stringify(st, null, 2));
      break;
    }

    case 'daemon': {
      if (config.webEnabled) startWebServer();

      // Deux planifications distinctes : le claim, et le simple rafraîchissement
      // de la liste des jeux (utile pour être notifié des nouveautés sans agir).
      const jobs = { claim: null, detect: null };

      const schedule = (kind, pattern) => {
        jobs[kind]?.stop();
        jobs[kind] = null;
        if (!pattern || !String(pattern).trim()) {
          log.info(`planification ${kind} désactivée`);
          return;
        }
        const task = () =>
          (kind === 'claim' ? runAll({ claim: true }) : detectAll()).catch((err) =>
            log.error(`run ${kind} planifié:`, err.message),
          );
        try {
          jobs[kind] = new Cron(pattern, { timezone: config.timezone }, task);
          log.info(
            `planification ${kind} "${pattern}" (${config.timezone}) — prochain passage : ${jobs[kind].nextRun()?.toISOString()}`,
          );
        } catch (err) {
          log.error(`cron ${kind} invalide ("${pattern}"):`, err.message);
        }
      };

      schedule('claim', config.cron);
      schedule('detect', config.cronDetect);
      onReschedule(({ cron, cronDetect }) => {
        schedule('claim', cron);
        schedule('detect', cronDetect);
      });
      log.info(`providers: ${config.providers.join(', ')} | navigateur: ${config.browser} | headless: ${config.headless}`);

      if (config.runOnStart) {
        runAll({ claim: true }).catch((err) => log.error('run initial:', err.message));
      } else {
        // Alimente l'interface web dès le démarrage sans rien réclamer.
        detectAll().catch((err) => log.warn('détection initiale:', err.message));
      }

      const bye = async () => {
        log.info('arrêt…');
        jobs.claim?.stop();
        jobs.detect?.stop();
        await loginSession.finish().catch(() => {});
        vnc.shutdown();
        process.exit(0);
      };
      process.on('SIGINT', bye);
      process.on('SIGTERM', bye);
      break;
    }

    default:
      usage();
  }
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
