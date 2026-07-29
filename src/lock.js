import { EventEmitter } from 'node:events';

// Un seul navigateur à la fois : les runs planifiés, les détections manuelles
// et les sessions de login se partagent ce verrou.
export const lockEvents = new EventEmitter();

let holder = null;
let since = null;

export const isBusy = () => holder !== null;
export const current = () => (holder ? { what: holder, since } : null);

export function acquire(what) {
  if (holder) throw new Error(`occupé : ${holder} en cours`);
  holder = what;
  since = new Date().toISOString();
  lockEvents.emit('change', current());
  return () => release(what);
}

export function release(what) {
  if (holder && what && holder !== what) return;
  holder = null;
  since = null;
  lockEvents.emit('change', null);
}

export async function withLock(what, fn) {
  const done = acquire(what);
  try {
    return await fn();
  } finally {
    done();
  }
}
