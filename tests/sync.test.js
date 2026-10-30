import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, validateState, advanceOccurrence, monthSummary } from '../src/core.js';
import { isDefaultState, sameFinancialState, planSync, mergeFinancialStates, SyncConflict } from '../src/sync.js';

const clone = value => structuredClone(value);
const expense = (id, sourceId = 'orig-mercado') => ({
  id, kind: 'expense', sourceId, description: id, date: '2026-10-03',
  amountCents: 30000, recurrence: { mode: 'none', months: null }, payment: 'credit', installments: 3, advances: []
});
const withEntry = (state, id) => { state.entries.push(expense(id)); return validateState(state); };

test('base padrão é reconhecida independentemente da ordem das origens', () => {
  const state = initialState();
  assert.ok(isDefaultState(state));
  state.sources.reverse();
  assert.ok(isDefaultState(state));
  state.entries.push(expense('x'));
  assert.ok(!isDefaultState(state));
});
test('primeira conexão exige escolha explícita', () => {
  assert.equal(planSync(null, initialState(), initialState()).action, 'onboarding');
});
test('sem alterações gera noop', () => {
  const state = initialState();
  assert.equal(planSync(state, state, state).action, 'noop');
});
test('só alteração local gera push', () => {
  const base = initialState(), local = withEntry(clone(base), 'local');
  const result = planSync(base, local, base);
  assert.equal(result.action, 'push');
  assert.equal(result.next.entries.length, 1);
});
test('só alteração remota gera pull', () => {
  const base = initialState(), remote = withEntry(clone(base), 'pc');
  const result = planSync(base, base, remote);
  assert.equal(result.action, 'pull');
  assert.equal(result.next.entries[0].id, 'pc');
});
test('edições independentes em PC e Android se combinam sem perder registros', () => {
  const base = withEntry(initialState(), 'original');
  const pc = withEntry(clone(base), 'pc');
  const android = withEntry(clone(base), 'android');
  const result = planSync(base, pc, android);
  assert.equal(result.action, 'push');
  assert.deepEqual(new Set(result.next.entries.map(e => e.id)), new Set(['original', 'pc', 'android']));
});
test('exclusão local e adição remota independente coexistem', () => {
  const base = withEntry(initialState(), 'excluir');
  const local = clone(base); local.entries = [];
  const remote = withEntry(clone(base), 'novo');
  assert.deepEqual(mergeFinancialStates(base, local, remote).entries.map(e => e.id), ['novo']);
});
test('remoção em um aparelho e modificação do mesmo registro no outro gera conflito', () => {
  const base = withEntry(initialState(), 'compra');
  const pc = clone(base); pc.entries = [];
  const android = clone(base); android.entries[0].amountCents = 999;
  assert.throws(() => planSync(base, pc, android), SyncConflict);
});
test('duas alterações diferentes no mesmo lançamento não sobrescrevem uma à outra', () => {
  const base = withEntry(initialState(), 'compra');
  const pc = clone(base); pc.entries[0].amountCents = 12000;
  const android = clone(base); android.entries[0].description = 'Outra descrição';
  assert.throws(() => planSync(base, pc, android), error => error instanceof SyncConflict && error.ids.includes('entries:compra'));
});
test('edições idênticas em ambos aparelhos não geram conflito', () => {
  const base = withEntry(initialState(), 'compra');
  const pc = clone(base), android = clone(base);
  pc.entries[0].description = android.entries[0].description = 'Mesmo ajuste';
  const result = planSync(base, pc, android);
  assert.equal(result.action, 'pull');
});
test('origens editadas independentemente coexistem', () => {
  const base = initialState(), pc = clone(base), phone = clone(base);
  pc.sources.find(s => s.id === 'orig-mercado').name = 'Mercado semanal';
  phone.sources.find(s => s.id === 'orig-salario').name = 'Meu salário';
  const merged = mergeFinancialStates(base, pc, phone);
  assert.equal(merged.sources.find(s => s.id === 'orig-mercado').name, 'Mercado semanal');
  assert.equal(merged.sources.find(s => s.id === 'orig-salario').name, 'Meu salário');
});
test('remoção de origem com novo registro no outro dispositivo trava merge', () => {
  const base = initialState(), pc = clone(base), phone = clone(base);
  pc.sources = pc.sources.filter(s => s.id !== 'orig-mercado');
  phone.entries.push(expense('nova'));
  assert.throws(() => mergeFinancialStates(base, pc, phone), SyncConflict);
});
test('registro remoto desaparecido depois de parear nunca vira push silencioso', () => {
  const base = initialState();
  assert.throws(() => planSync(base, withEntry(clone(base), 'x'), null), SyncConflict);
});
test('adiantamento local e nova despesa remota independente mantêm totais', () => {
  const base = withEntry(initialState(), 'parcelada');
  const pc = clone(base);
  pc.entries[0] = advanceOccurrence(pc.entries[0], 2, '2026-11');
  const android = withEntry(clone(base), 'extra');
  const merged = mergeFinancialStates(base, pc, android);
  assert.equal(merged.entries.length, 2);
  assert.equal(monthSummary(merged, '2026-11').expense, 30000);
  assert.equal(monthSummary(merged, '2026-12').expense, 10000);
});
test('adiantar a mesma parcela para meses distintos em dois aparelhos causa conflito', () => {
  const base = withEntry(initialState(), 'parcelada');
  const pc = clone(base), android = clone(base);
  pc.entries[0] = advanceOccurrence(pc.entries[0], 2, '2026-11');
  android.entries[0] = advanceOccurrence(android.entries[0], 2, '2026-10');
  assert.throws(() => mergeFinancialStates(base, pc, android), SyncConflict);
});
test('revisão preserva equivalência independentemente da ordem', () => {
  const base = withEntry(initialState(), 'x'), reversed = clone(base);
  reversed.sources.reverse();
  assert.ok(sameFinancialState(base, reversed));
});
