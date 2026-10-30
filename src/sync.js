/** Sincronização pura de snapshots: merge de três vias por identidade estável.
 * Nunca elege automaticamente um vencedor quando ambos editaram o mesmo registro. */
import { validateState, initialState } from './core.js';

export class SyncConflict extends Error {
  constructor(message, ids = []) {
    super(message);
    this.name = 'SyncConflict';
    this.ids = ids;
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function changedCollection(base, other, key) {
  const first = new Map(base[key].map(item => [item.id, item]));
  const second = new Map(other[key].map(item => [item.id, item]));
  if (first.size !== second.size) return true;
  for (const [id, item] of first) if (!second.has(id) || !same(item, second.get(id))) return true;
  return false;
}
export function sameFinancialState(a, b) {
  const x = validateState(a), y = validateState(b);
  return !changedCollection(x, y, 'sources') && !changedCollection(x, y, 'entries') && !changedCollection(x, y, 'payees');
}
export function isDefaultState(value) { return sameFinancialState(value, initialState()); }

function mergeCollection(base, local, remote, key, conflicts) {
  const b = new Map(base[key].map(row => [row.id, row]));
  const l = new Map(local[key].map(row => [row.id, row]));
  const r = new Map(remote[key].map(row => [row.id, row]));
  const ids = new Set([...b.keys(), ...l.keys(), ...r.keys()]);
  const result = [];
  for (const id of ids) {
    const bv = b.get(id), lv = l.get(id), rv = r.get(id);
    const lc = !same(bv, lv), rc = !same(bv, rv);
    if (lc && rc && !same(lv, rv)) {
      conflicts.push(`${key}:${id}`);
      continue;
    }
    const resolved = lc ? lv : rv;
    if (resolved !== undefined) result.push(resolved);
  }
  return result;
}

export function mergeFinancialStates(baseInput, localInput, remoteInput) {
  const base = validateState(baseInput), local = validateState(localInput), remote = validateState(remoteInput);
  const conflicts = [];
  const candidate = {
    schemaVersion: base.schemaVersion,
    sources: mergeCollection(base, local, remote, 'sources', conflicts),
    entries: mergeCollection(base, local, remote, 'entries', conflicts),
    payees: mergeCollection(base, local, remote, 'payees', conflicts)
  };
  if (conflicts.length) throw new SyncConflict(`Há ${conflicts.length} registro(s) alterado(s) nos dois dispositivos: ${conflicts.slice(0, 5).join(', ')}. Exporte o JSON antes de resolver.`, conflicts);
  try { return validateState(candidate); }
  catch (error) {
    throw new SyncConflict(`As mudanças simultâneas geraram referências incompatíveis (${error.message}). Resolva manualmente a partir de um backup.`);
  }
}

/** A base é o último snapshot sincronizado, gravado transacionalmente com o estado local.
 * remote=null após sincronização prévia indica remoção inesperada, não base vazia. */
export function planSync(baseInput, localInput, remoteInput) {
  if (!baseInput) return { action: 'onboarding' };
  if (!remoteInput) throw new SyncConflict('O registro remoto desapareceu. Sincronização pausada para evitar perda de dados.');
  const base = validateState(baseInput), local = validateState(localInput), remote = validateState(remoteInput);
  const localChanged = !sameFinancialState(base, local);
  const remoteChanged = !sameFinancialState(base, remote);
  if (!localChanged && !remoteChanged) return { action: 'noop', next: local };
  if (!localChanged) return { action: 'pull', next: remote };
  if (!remoteChanged) return { action: 'push', next: local };
  const merged = mergeFinancialStates(base, local, remote);
  if (sameFinancialState(merged, remote)) return { action: 'pull', next: remote };
  return { action: 'push', next: merged };
}
