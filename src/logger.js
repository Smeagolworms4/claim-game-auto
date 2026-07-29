import { EventEmitter } from 'node:events';
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

// Tampon circulaire consommé par l'interface web.
const BUFFER_MAX = 500;
const buffer = [];
export const logEvents = new EventEmitter();
export const recentLogs = () => buffer.slice();

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const fmt = (v) => (typeof v === 'string' ? v : v instanceof Error ? v.message : JSON.stringify(v));

const emit = (level, scope, args) => {
  if (LEVELS[level] < threshold) return;
  const message = args.map(fmt).join(' ');
  const entry = { ts: stamp(), level, scope, message };

  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.shift();
  logEvents.emit('line', entry);

  const prefix = `${entry.ts} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}]` : ''}`.trimEnd();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, message);
};

export const makeLogger = (scope = '') => ({
  debug: (...a) => emit('debug', scope, a),
  info: (...a) => emit('info', scope, a),
  warn: (...a) => emit('warn', scope, a),
  error: (...a) => emit('error', scope, a),
  child: (sub) => makeLogger(scope ? `${scope}:${sub}` : sub),
});

export const log = makeLogger();
