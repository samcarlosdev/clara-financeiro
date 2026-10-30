import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, validateState, monthOccurrences, settleOccurrence, undoSettlement, payableSummary, exportSnapshot, parseImport, advanceOccurrence } from '../src/core.js';
import { mergeFinancialStates, sameFinancialState } from '../src/sync.js';
const entry = (x={}) => ({id:'e',kind:'expense',sourceId:'orig-contas',payeeId:'p',description:'Internet',date:'2026-11-10',amountCents:12000,recurrence:{mode:'fixed',months:3},payment:'pix',installments:1,advances:[],settlements:[],...x});
const base = () => validateState({...initialState(),payees:[{id:'p',name:'Operadora',type:'company',note:''}],entries:[entry()]});
test('backup v1 migra sem perder lançamentos e aceita importação',()=>{
 const old={...initialState(),schemaVersion:1,entries:[{...entry(),payeeId:undefined,settlements:undefined}],payees:undefined};
 const migrated=validateState(old);assert.equal(migrated.schemaVersion,2);assert.equal(migrated.entries.length,1);assert.deepEqual(migrated.payees,[]);assert.equal(migrated.entries[0].payeeId,null);
 const backup=exportSnapshot(migrated);assert.equal(parseImport(JSON.stringify(backup)).schemaVersion,2);
});
test('favorecido inexistente é rejeitado',()=>assert.throws(()=>validateState({...base(),entries:[entry({payeeId:'x'})]}),/Favorecido inexistente/));
test('favorecidos duplicados não são permitidos',()=>assert.throws(()=>validateState({...base(),payees:[...base().payees,{id:'q',name:'operadora',type:'company',note:''}]}),/duplicado/));
test('quitação parcial e total por ocorrência sem mexer em meses restantes',()=>{
 let e=base().entries[0]; e=settleOccurrence(e,1,3500,'2026-12-03');
 assert.equal(e.settlements[0].paidCents,3500);assert.equal(monthOccurrences({...base(),entries:[e]},'2026-12')[0].paidCents,3500);
 assert.equal(monthOccurrences({...base(),entries:[e]},'2027-01')[0].paidCents,0);
 e=settleOccurrence(e,1,8500,'2026-12-04');assert.equal(payableSummary({...base(),entries:[e]},'2026-12').pendingCents,0);
 assert.equal(undoSettlement(e,1).settlements.length,0);
});
test('não pode pagar além do saldo nem usar data inválida',()=>{
 const e=settleOccurrence(base().entries[0],0,5000,'2026-11-10');
 assert.throws(()=>settleOccurrence(e,0,7001,'2026-11-11'),/excede/);
 assert.throws(()=>settleOccurrence(e,0,100,'2026-02-30'),/Data inválida/);
});
test('parcela de cartão usa o valor individual para o pagamento',()=>{
 const e=validateState({...base(),entries:[entry({recurrence:{mode:'none',months:null},payment:'credit',installments:3,amountCents:10000})]}).entries[0];
 assert.equal(settleOccurrence(e,2,3333,'2027-01-10').settlements[0].paidCents,3333);
 assert.throws(()=>settleOccurrence(e,2,3334,'2027-01-10'),/excede/);
});
test('adiantamento de ocorrência não altera a liquidação',()=>{
 const e=settleOccurrence(base().entries[0],2,12000,'2026-12-20');
 const a=advanceOccurrence(e,2,'2026-12');
 assert.equal(monthOccurrences({...base(),entries:[a]},'2026-12').length,2);
 assert.equal(monthOccurrences({...base(),entries:[a]},'2026-12')[1].paidCents,12000);
});
test('sincronização mescla um novo favorecido e pagamento independente',()=>{
 const b=base(); const local=structuredClone(b),remote=structuredClone(b);
 local.payees.push({id:'p2',name:'Loja',type:'company',note:''});
 remote.entries[0]=settleOccurrence(remote.entries[0],0,2000,'2026-11-10');
 const merged=mergeFinancialStates(b,local,remote);
 assert.equal(merged.payees.length,2);assert.equal(merged.entries[0].settlements[0].paidCents,2000);
 assert.equal(sameFinancialState(merged,b),false);
});
test('mudanças concorrentes no mesmo pagamento geram conflito',()=>{
 const b=base(),a=structuredClone(b),c=structuredClone(b);
 a.entries[0]=settleOccurrence(a.entries[0],0,1000,'2026-11-10');
 c.entries[0]=settleOccurrence(c.entries[0],0,3000,'2026-11-10');
 assert.throws(()=>mergeFinancialStates(b,a,c),/alterado/);
});
import { removeSource, removePayee } from '../src/core.js';
test('origem em uso exige substituta compatível e reclassifica todas as cobranças',()=>{
 const b=base();assert.throws(()=>removeSource(b,'orig-contas'),/Selecione/);
 assert.throws(()=>removeSource(b,'orig-contas','orig-salario'),/Selecione/);
 const r=removeSource(b,'orig-contas','orig-moradia');assert.equal(r.entries[0].sourceId,'orig-moradia');assert.equal(r.sources.some(s=>s.id==='orig-contas'),false);
});
test('excluir favorecido preserva despesas e limpa vínculos',()=>{
 const b=base(),r=removePayee(b,'p');assert.equal(r.entries.length,1);assert.equal(r.entries[0].payeeId,null);assert.deepEqual(r.payees,[]);
});
