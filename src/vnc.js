import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from './config.js';
import { makeLogger } from './logger.js';

const log = makeLogger('vnc');
const exec = promisify(execFile);

const procs = { xvfb: null, x11vnc: null, novnc: null };
let idleTimer = null;
let startedAt = null;

const has = async (bin) => {
  try {
    await exec('which', [bin]);
    return true;
  } catch {
    return false;
  }
};

const alive = (p) => Boolean(p && p.exitCode === null && !p.killed);

const spawnBg = (bin, args) => {
  const p = spawn(bin, args, { stdio: 'ignore', detached: false });
  p.on('exit', (code) => log.debug(`${bin} terminé (${code})`));
  p.on('error', (err) => log.error(`${bin}:`, err.message));
  return p;
};

/** Démarre le serveur X virtuel si besoin (nécessaire au mode headed). */
export async function ensureDisplay() {
  if (alive(procs.xvfb)) return true;
  // Un Xvfb lancé par l'entrypoint est déjà en place ?
  if (await has('xdpyinfo')) {
    try {
      await exec('xdpyinfo', ['-display', config.display]);
      return true;
    } catch {
      /* pas encore démarré */
    }
  }
  if (!(await has('Xvfb'))) throw new Error('Xvfb absent (hors Docker ?)');

  // Verrou d'un X précédent (survit à un `docker restart`) : le test
  // xdpyinfo ci-dessus a échoué, donc plus aucun serveur ne tourne.
  const num = config.display.replace(':', '');
  await Promise.all([
    fs.rm(`/tmp/.X${num}-lock`, { force: true }).catch(() => {}),
    fs.rm(`/tmp/.X11-unix/X${num}`, { force: true }).catch(() => {}),
  ]);

  const [w, h] = config.screen.split(',');
  procs.xvfb = spawnBg('Xvfb', [config.display, '-screen', '0', `${w}x${h}x24`, '-nolisten', 'tcp']);
  await new Promise((r) => setTimeout(r, 1200));
  return true;
}

export function status() {
  return {
    running: alive(procs.x11vnc) && alive(procs.novnc),
    novncPort: config.novncPort,
    vncPort: config.vncPort,
    startedAt,
  };
}

/** Lance x11vnc + noVNC à la demande, avec extinction automatique. */
export async function start() {
  await ensureDisplay();
  if (status().running) {
    resetIdle();
    return status();
  }

  if (!(await has('x11vnc'))) throw new Error('x11vnc absent');
  procs.x11vnc = spawnBg('x11vnc', [
    '-display', config.display,
    '-rfbport', String(config.vncPort),
    '-forever', '-shared', '-nopw', '-quiet', '-noxdamage',
  ]);

  const webRoot = ['/usr/share/novnc', '/usr/share/webapps/novnc'].find(Boolean);
  const bin = (await has('websockify')) ? 'websockify' : 'novnc_proxy';
  procs.novnc =
    bin === 'websockify'
      ? spawnBg('websockify', ['--web', webRoot, String(config.novncPort), `localhost:${config.vncPort}`])
      : spawnBg('novnc_proxy', ['--vnc', `localhost:${config.vncPort}`, '--listen', String(config.novncPort)]);

  startedAt = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 1000));
  log.info(`noVNC dispo sur le port ${config.novncPort}`);
  resetIdle();
  return status();
}

export function stop() {
  clearTimeout(idleTimer);
  idleTimer = null;
  for (const key of ['x11vnc', 'novnc']) {
    if (alive(procs[key])) procs[key].kill('SIGTERM');
    procs[key] = null;
  }
  startedAt = null;
  log.info('VNC arrêté');
  return status();
}

/** Repousse l'extinction automatique (appelé pendant qu'une session est ouverte). */
export function resetIdle() {
  if (!config.vncIdleTimeout) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log.info('VNC inactif, extinction');
    stop();
  }, config.vncIdleTimeout);
}

export function shutdown() {
  stop();
  if (alive(procs.xvfb)) procs.xvfb.kill('SIGTERM');
}
