import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState, validateState, simulateAdvances, advanceOccurrence,
  monthSummary, exportSnapshot, entryOccurrencesInMonth
} from '../src/core.js';

const stateOf = (...entries) => validateState({ ...initialState(), entries });
const variable = () => ({ id:'v1', kind:'expense', sourceId:'orig-moradia', description:'IPTU', date:'2026-12-15', amountCents:15000,
  recurrence:{mode:'none',months:null}, payment:'pix', installments:1 });
const credit = () => ({ id:'c1', kind:'expense', sourceId:'orig-lazer', description:'Cartão', date:'2027-01-10', amountCents:10000,
  recurrence:{mode:'none',months:null}, payment:'credit', installments:3 });
const fixed = () => ({ ...variable(), id:'f1', date:'2027-01-15', recurrence:{mode:'fixed',months:5} });
const income = () => ({ id:'i1',kind:'income',sourceId:'orig-salario',description:'Salário',date:'2027-01-01',amountCents:100000,
  recurrence:{mode:'fixed',months:null},payment:null,installments:1 });
const move = (entryId, occurrenceIndex, toMonth) => ({ entryId, occurrenceIndex, toMonth });

test('despesa pontual de dezembro simulada em outubro retira dezembro do orçamento', () => {
  const state=stateOf(variable());
  const before=JSON.stringify(state);
  const {projection,movements}=simulateAdvances(state,[move('v1',0,'2026-10')],'2026-10',3);
  assert.deepEqual(projection.map(p=>p.expenseChange),[15000,0,-15000]);
  assert.deepEqual(projection.map(p=>p.projected.expense),[15000,0,0]);
  assert.equal(movements[0].originalMonth,'2026-12');
  assert.equal(JSON.stringify(state),before);
});
test('parcela março -> fevereiro mantém parcela de fevereiro e não duplica centavos', () => {
  const state=stateOf(credit());
  const {projection,movements}=simulateAdvances(state,[move('c1',2,'2027-02')],'2027-01',3);
  assert.deepEqual(projection.map(p=>p.baseline.expense),[3334,3333,3333]);
  assert.deepEqual(projection.map(p=>p.projected.expense),[3334,6666,0]);
  assert.deepEqual(projection.map(p=>p.expenseChange),[0,3333,-3333]);
  assert.equal(projection.reduce((n,p)=>n+p.projected.expense,0),10000);
  assert.equal(movements[0].amountCents,3333);
  assert.equal(entryOccurrencesInMonth(state.entries[0],'2027-03').length,1);
});
test('conta fixa altera somente a ocorrência selecionada', () => {
  const {projection}=simulateAdvances(stateOf(fixed()),[move('f1',2,'2027-02')],'2027-01',6);
  assert.deepEqual(projection.map(p=>p.projected.fixedExpense),[15000,30000,0,15000,15000,0]);
  assert.deepEqual(projection.map(p=>p.expenseChange),[0,15000,-15000,0,0,0]);
});
test('múltiplos adiantamentos independentes acumulam na mesma competência', () => {
  const {projection,movements}=simulateAdvances(stateOf(credit(),income()),[
    move('c1',1,'2027-01'),move('c1',2,'2027-01')
  ],'2027-01',3);
  assert.deepEqual(projection.map(p=>p.projected.expense),[10000,0,0]);
  assert.deepEqual(projection.map(p=>p.projected.balance),[90000,100000,100000]);
  assert.deepEqual(movements.map(m=>m.amountCents),[3333,3333]);
});
test('transferência de fora da janela de 1 mês aparece como aumento no mês de destino', () => {
  const result=simulateAdvances(stateOf(variable()),[move('v1',0,'2026-10')],'2026-10',1);
  assert.deepEqual(result.projection.map(p=>p.expenseChange),[15000]);
  assert.equal(result.movements[0].fromMonth,'2026-12');
  assert.equal(result.projection[0].departed.length,0);
});
test('planos com zero adiantamentos mantêm o orçamento em 1, 3 e 6 meses', () => {
  for (const horizon of [1,3,6]) {
    const {projection,movements}=simulateAdvances(stateOf(credit(),income()),[],'2027-01',horizon);
    assert.equal(movements.length,0);
    assert.ok(projection.every(p=>p.expenseChange===0 && p.balanceChange===0));
  }
});
test('simulação não entra no backup nem modifica adiantamentos já salvos', () => {
  const state=stateOf(credit());
  const backup=JSON.stringify(exportSnapshot(state));
  simulateAdvances(state,[move('c1',2,'2027-01')],'2027-01',3);
  assert.equal(JSON.stringify(exportSnapshot(state)),backup);
  assert.equal(state.entries[0].advances.length,0);
});
test('adiantamento real pré-existente pode ser simulado para um mês ainda anterior', () => {
  const state=stateOf(advanceOccurrence(credit(),2,'2027-02'));
  const {projection,movements}=simulateAdvances(state,[move('c1',2,'2027-01')],'2027-01',3);
  assert.equal(movements[0].fromMonth,'2027-02');
  assert.equal(movements[0].originalMonth,'2027-03');
  assert.deepEqual(projection.map(p=>p.projected.expense),[6667,3333,0]);
  assert.equal(monthSummary(state,'2027-02').expense,6666);
});
test('rejeita reprogramar para mesmo mês efetivo ou para mês posterior', () => {
  const state=stateOf(advanceOccurrence(credit(),2,'2027-02'));
  assert.throws(()=>simulateAdvances(state,[move('c1',2,'2027-02')],'2027-01',3),/anterior/);
  assert.throws(()=>simulateAdvances(state,[move('c1',2,'2027-03')],'2027-01',3),/anterior/);
});
test('impede duplicação da mesma cobrança no cenário', () => {
  assert.throws(()=>simulateAdvances(stateOf(credit()),[
    move('c1',2,'2027-01'),move('c1',2,'2027-02')
  ],'2027-01',3),/mesma cobrança/);
});
test('rejeita destinos fora dos meses mostrados no simulador', () => {
  assert.throws(()=>simulateAdvances(stateOf(variable()),[move('v1',0,'2026-09')],'2026-10',3),/dentro/);
  assert.throws(()=>simulateAdvances(stateOf(variable()),[move('v1',0,'2026-11')],'2026-10',1),/dentro/);
});
test('rejeita lançamentos inexistentes, receita ou índice inválido', () => {
  const state=stateOf(credit(),income());
  assert.throws(()=>simulateAdvances(state,[move('c404',0,'2027-01')],'2027-01',3),/não existe/);
  assert.throws(()=>simulateAdvances(state,[move('i1',1,'2027-01')],'2027-01',3),/não existe/);
  assert.throws(()=>simulateAdvances(state,[move('c1',50,'2027-01')],'2027-01',3),/não existe/);
});
test('valida horizonte, período e formato do plano', () => {
  const state=stateOf(credit());
  assert.throws(()=>simulateAdvances(state,[],'2027-01',4),/Horizonte/);
  assert.throws(()=>simulateAdvances(state,[],'2027-13',3),/Mês inválido/);
  assert.throws(()=>simulateAdvances(state,{},'2027-01',3),/Plano/);
  assert.throws(()=>simulateAdvances(state,[{entryId:'c1',occurrenceIndex:'2',toMonth:'2027-01'}],'2027-01',3),/inválida/);
  assert.throws(()=>simulateAdvances(state,[],'2100-12',3),/Mês inválido/);
});
test('recorrência fixa indeterminada aceita adiantar só uma competência futura',()=>{
  const indef={...fixed(),recurrence:{mode:'fixed',months:null}};
  const {projection}=simulateAdvances(stateOf(indef),[move('f1',5,'2027-03')],'2027-01',6);
  assert.deepEqual(projection.map(p=>p.expenseChange),[0,0,15000,0,0,-15000]);
});
