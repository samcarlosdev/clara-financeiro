import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState, validateState, monthOccurrences, monthSummary, periodOccurrences,
  advanceOccurrence, reverseAdvance, simulateExpense, exportSnapshot, parseImport
} from '../src/core.js';
const fixed = () => ({
  id:'f1', kind:'expense', sourceId:'orig-contas', description:'Internet', date:'2026-12-15',
  amountCents:10000, recurrence:{mode:'fixed', months:3}, payment:'pix', installments:1
});
const card = () => ({
  id:'c1', kind:'expense', sourceId:'orig-lazer', description:'Cartão', date:'2027-01-10',
  amountCents:10000, recurrence:{mode:'none',months:null}, payment:'credit', installments:3
});
const salary = () => ({
  id:'r1', kind:'income', sourceId:'orig-salario', description:'Salário', date:'2026-10-01',
  amountCents:200000, recurrence:{mode:'fixed', months:null}, payment:null, installments:1
});
const stateOf = (...entries) => validateState({ ...initialState(), entries });
test('adianta lançamento variável de dezembro a outubro sem duplicar', () => {
  const variable = {...fixed(), recurrence: {mode:'none',months:null}};
  const advanced = advanceOccurrence(variable,0,'2026-10');
  const state = stateOf(advanced);
  assert.equal(monthSummary(state, '2026-10').expense,10000);
  assert.equal(monthSummary(state, '2026-12').expense,0);
  assert.equal(monthOccurrences(state,'2026-10')[0].originalMonth,'2026-12');
  assert.equal(monthOccurrences(state,'2026-10')[0].advanced,true);
});
test('adianta apenas a competência de dezembro de uma despesa fixa', () => {
  const state=stateOf(advanceOccurrence(fixed(),0,'2026-10'));
  assert.equal(monthSummary(state,'2026-10').fixedExpense,10000);
  assert.equal(monthSummary(state,'2026-11').expense,0);
  assert.equal(monthSummary(state,'2026-12').expense,0);
  assert.equal(monthSummary(state,'2027-01').expense,10000);
  assert.equal(monthSummary(state,'2027-02').expense,10000);
});
test('duas parcelas diferentes coexistem em fevereiro sem perdas', () => {
  const state=stateOf(advanceOccurrence(card(),2,'2027-02'));
  const feb=monthOccurrences(state,'2027-02');
  assert.equal(feb.length,2);
  assert.deepEqual(feb.map(x=>x.part),['2/3','3/3']);
  assert.equal(feb.reduce((sum,x)=>sum+x.amountCents,0),6666);
  assert.equal(monthOccurrences(state,'2027-03').length,0);
  assert.equal(periodOccurrences(state,'2027-01','2027-03').reduce((sum,x)=>sum+x.amountCents,0),10000);
});
test('adiantamento permite alterar mês antecipado sem duplicação', () => {
  let entry=advanceOccurrence(card(),2,'2027-02');
  entry=advanceOccurrence(entry,2,'2027-01');
  const state=stateOf(entry);
  assert.equal(entry.advances.length,1);
  assert.equal(monthOccurrences(state,'2027-01').length,2);
  assert.equal(monthOccurrences(state,'2027-02').length,1);
});
test('reversão restaura somente a parcela selecionada', () => {
  const entry=advanceOccurrence(card(),2,'2027-02');
  const reverted=reverseAdvance(entry,2);
  assert.deepEqual(reverted.advances,[]);
  assert.deepEqual(['2027-01','2027-02','2027-03'].map(m=>monthOccurrences(stateOf(reverted),m).length),[1,1,1]);
});
test('recorrência indeterminada suporta adiantamento de uma ocorrência futura', () => {
  const state=stateOf(advanceOccurrence({...fixed(), recurrence:{mode:'fixed',months:null}},14,'2027-12'));
  assert.equal(monthOccurrences(state,'2027-12').length,2);
  assert.equal(monthOccurrences(state,'2028-02').length,0);
});
test('não permite adiantamento para mesmo mês nem meses posteriores', () => {
  assert.throws(()=>advanceOccurrence(card(),2,'2027-03'),/anterior/);
  assert.throws(()=>advanceOccurrence(card(),1,'2027-03'),/anterior/);
  assert.throws(()=>advanceOccurrence(card(),5,'2026-12'),/inexistente/);
});
test('importação bloqueia índices duplicados e destinos inválidos',()=>{
  const a=advanceOccurrence(card(),2,'2027-02');
  assert.throws(()=>stateOf({...a,advances:[a.advances[0],a.advances[0]]}),/duplicado/);
  assert.throws(()=>stateOf({...a,advances:[{index:2,toMonth:'2027-03'}]}),/anterior/);
  assert.throws(()=>stateOf({...a,advances:[{index:3,toMonth:'2027-01'}]}),/inexistente/);
  assert.throws(()=>stateOf({...a,advances:[{index:2,toMonth:'2027-13'}]}),/inválido/);
});
test('backup exporta e restaura adiantamentos',()=>{
  const state=stateOf(advanceOccurrence(card(),2,'2027-02'));
  const restored=parseImport(JSON.stringify(exportSnapshot(state)));
  assert.deepEqual(restored,state);
});
test('backup antigo sem advances é importado com lista vazia',()=>{
  const state=stateOf(card());
  const snapshot=exportSnapshot(state);
  delete snapshot.data.entries[0].advances;
  assert.deepEqual(parseImport(JSON.stringify(snapshot)),state);
});
test('simulação de despesa fixa altera projeção de 1, 3 e 6 meses sem alterar base',()=>{
  const state=stateOf(salary());
  const before=JSON.stringify(state);
  const conf={date:'2026-10-01',amountCents:20000,recurrence:{mode:'fixed',months:null},payment:'pix',installments:1};
  for(const months of [1,3,6]){
    const projection=simulateExpense(state,conf,months);
    assert.equal(projection.length,months);
    assert.equal(projection.reduce((sum,r)=>sum+r.additionalExpense,0),20000*months);
    assert.equal(projection[0].baseline.balance,200000);
    assert.equal(projection[0].projected.balance,180000);
  }
  assert.equal(JSON.stringify(state),before);
});
test('simulação variável pontual não aparece nos meses seguintes',()=>{
  const state=stateOf(salary());
  const projection=simulateExpense(state,{date:'2026-10-01',amountCents:8000,recurrence:{mode:'none',months:null},payment:'cash',installments:1},6);
  assert.deepEqual(projection.map(p=>p.additionalExpense),[8000,0,0,0,0,0]);
});
test('simulação de cartão distribui parcelas sem mudar lançamentos reais',()=>{
  const state=stateOf(card());
  const projection=simulateExpense(state,{date:'2027-01-01',amountCents:10000,recurrence:{mode:'none',months:null},payment:'credit',installments:3},6);
  assert.deepEqual(projection.map(p=>p.additionalExpense),[3334,3333,3333,0,0,0]);
  assert.equal(state.entries.length,1);
});
test('simulação rejeita configurações inválidas, limite de meses ou pagamento não parcelável',()=>{
  const base={date:'2026-10-01',amountCents:10000,recurrence:{mode:'none',months:null},payment:'pix',installments:1};
  assert.throws(()=>simulateExpense(stateOf(),base,12),/Horizonte/);
  assert.throws(()=>simulateExpense(stateOf(),{...base,installments:2},3),/Dinheiro e Pix/);
  assert.throws(()=>simulateExpense(stateOf(),{...base,amountCents:0},3),/Valor financeiro/);
});
