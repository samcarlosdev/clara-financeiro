import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState, validateState, addMonths, monthDistance, occurrenceDate, parseMoney, money,
  splitInstallments, monthOccurrences, periodOccurrences, monthSummary, expenseBySource,
  exportSnapshot, parseImport
} from '../src/core.js';

const expense = (override = {}) => ({
  id: 'expense-1', kind: 'expense', sourceId: 'orig-mercado', description: 'Compra',
  date: '2026-01-31', amountCents: 10000, recurrence: { mode: 'none', months: null },
  payment: 'pix', installments: 1, ...override
});
const income = (override = {}) => ({
  id: 'income-1', kind: 'income', sourceId: 'orig-salario', description: 'Pagamento',
  date: '2026-01-05', amountCents: 300000, recurrence: { mode: 'none', months: null },
  payment: null, installments: 1, ...override
});
const withEntries = (...entries) => ({ ...initialState(), entries });

// Datas e moeda
test('adiciona meses com virada de ano', () => assert.equal(addMonths('2026-12', 2), '2027-02'));
test('distância de meses preserva o sentido', () => assert.equal(monthDistance('2027-01', '2026-11'), -2));
test('datas no dia 31 respeitam fim de fevereiro', () => assert.equal(occurrenceDate('2026-01-31', '2026-02'), '2026-02-28'));
test('datas no dia 31 respeitam ano bissexto', () => assert.equal(occurrenceDate('2024-01-31', '2024-02'), '2024-02-29'));
test('conversão decimal em centavos não usa float de valores monetários', () => assert.equal(parseMoney('123,45'), 12345));
test('formatação monetária brasileira', () => assert.match(money(12345), /123,45/));
test('valor com mais de duas casas decimais é rejeitado', () => assert.throws(() => parseMoney('1,234'), /válido/));
test('datas impossíveis são rejeitadas em importações', () => assert.throws(() => validateState(withEntries(expense({ date: '2026-02-31' }))), /Data inválida/));

// Parcelamento
test('100 reais em três parcelas não perde centavo', () => {
  const amounts = splitInstallments(10000, 3);
  assert.deepEqual(amounts, [3334, 3333, 3333]);
  assert.equal(amounts.reduce((a, b) => a + b), 10000);
});
test('parcelamento de 12 vezes distribui todos os meses', () => {
  const state = withEntries(expense({ payment: 'credit', installments: 12, amountCents: 120000 }));
  assert.equal(monthOccurrences(state, '2026-01')[0].part, '1/12');
  assert.equal(monthOccurrences(state, '2026-12')[0].part, '12/12');
  assert.equal(monthOccurrences(state, '2027-01').length, 0);
  assert.equal(periodOccurrences(state, '2026-01', '2026-12').reduce((sum, v) => sum + v.amountCents, 0), 120000);
});
test('primeira parcela usa o mês da data informada', () => {
  const state = withEntries(expense({ date: '2026-06-10', payment: 'credit', installments: 2 }));
  assert.equal(monthOccurrences(state, '2026-05').length, 0);
  assert.equal(monthOccurrences(state, '2026-06').length, 1);
  assert.equal(monthOccurrences(state, '2026-07').length, 1);
});
test('número de parcelas superior ao total de centavos é recusado', () => assert.throws(() => splitInstallments(2, 3), /inválidos/));
test('pagamento por Pix não aceita parcelas', () => assert.throws(() => validateState(withEntries(expense({ installments: 3 }))), /Dinheiro e Pix/));
test('pagamento em dinheiro ocorre apenas no mês original', () => {
  const state = withEntries(expense({ payment: 'cash' }));
  assert.equal(monthOccurrences(state, '2026-01').length, 1);
  assert.equal(monthOccurrences(state, '2026-02').length, 0);
});

// Recorrências
test('despesa fixa de três meses termina no mês correto', () => {
  const state = withEntries(expense({ recurrence: { mode: 'fixed', months: 3 } }));
  assert.deepEqual(['2026-01', '2026-02', '2026-03', '2026-04'].map(m => monthOccurrences(state, m).length), [1, 1, 1, 0]);
});
test('recorrência indeterminada existe nos meses futuros', () => {
  const state = withEntries(expense({ recurrence: { mode: 'fixed', months: null } }));
  assert.equal(monthOccurrences(state, '2031-07')[0].amountCents, 10000);
});
test('receita recorrente compõe os meses previstos', () => {
  const state = withEntries(income({ recurrence: { mode: 'fixed', months: 2 } }));
  assert.equal(monthSummary(state, '2026-01').income, 300000);
  assert.equal(monthSummary(state, '2026-02').income, 300000);
  assert.equal(monthSummary(state, '2026-03').income, 0);
});
test('despesa fixa no crédito corresponde a uma cobrança por mês', () => {
  const state = withEntries(expense({ recurrence: { mode: 'fixed', months: 3 }, payment: 'credit' }));
  assert.equal(periodOccurrences(state, '2026-01', '2026-03').length, 3);
  assert.equal(monthSummary(state, '2026-02').fixedExpense, 10000);
});
test('fixa com parcelas simultâneas é rejeitada para evitar dupla recorrência', () => {
  assert.throws(() => validateState(withEntries(expense({ recurrence: { mode: 'fixed', months: null }, payment: 'credit', installments: 3 }))), /não pode acumular/);
});
test('classificação fixa exige recorrência mínima de dois meses', () => {
  assert.throws(() => validateState(withEntries(expense({ recurrence: { mode: 'fixed', months: 1 } }))), /2 a 240/);
});

// Totalização e filtros por período
test('totais mensais separam fixas, variáveis, receita e saldo', () => {
  const state = withEntries(
    expense({ id: 'fixa', amountCents: 11000, recurrence: { mode: 'fixed', months: null } }),
    expense({ id: 'variavel', amountCents: 35000, date: '2026-02-06', payment: 'credit', installments: 2 }),
    income({ recurrence: { mode: 'fixed', months: null } })
  );
  assert.deepEqual(monthSummary(state, '2026-02'), { income: 300000, expense: 28500, balance: 271500, fixedExpense: 11000, variableExpense: 17500 });
  assert.equal(monthSummary(state, '2026-03').expense, 28500);
  assert.equal(monthSummary(state, '2026-04').expense, 11000);
});
test('resumo por origem agrupa despesas de mesma categoria', () => {
  const state = withEntries(expense({ id: 'a', amountCents: 100 }), expense({ id: 'b', amountCents: 200 }));
  assert.deepEqual(expenseBySource(state, '2026-01'), [{ sourceId: 'orig-mercado', amountCents: 300 }]);
});
test('busca por período retorna parcelas e recorrências por mês', () => {
  const state = withEntries(expense({ payment: 'credit', installments: 3 }));
  assert.equal(periodOccurrences(state, '2026-02', '2026-03').length, 2);
});
test('período invertido é rejeitado', () => assert.throws(() => periodOccurrences(withEntries(), '2026-03', '2026-01'), /até 24 meses/));
test('período superior a 24 meses é rejeitado', () => assert.throws(() => periodOccurrences(withEntries(), '2026-01', '2028-01'), /até 24 meses/));

// Importação / exportação e integridade
test('round-trip exporta e importa estado completo', () => {
  const state = withEntries(income(), expense({ payment: 'credit', installments: 3 }));
  const restored = parseImport(JSON.stringify(exportSnapshot(state, '2026-10-29T00:00:00.000Z')));
  assert.deepEqual(restored, validateState(state));
});
test('JSON quebrado é rejeitado', () => assert.throws(() => parseImport('{"format":'), /JSON válido/));
test('formato desconhecido não sobrescreve o modelo', () => {
  const snapshot = exportSnapshot(initialState()); snapshot.format = 'outro-programa';
  assert.throws(() => parseImport(JSON.stringify(snapshot)), /backup compatível/);
});
test('versão desconhecida é rejeitada', () => {
  const snapshot = exportSnapshot(initialState()); snapshot.formatVersion = 999;
  assert.throws(() => parseImport(JSON.stringify(snapshot)), /backup compatível/);
});
test('origem ausente em arquivo importado é rejeitada', () => {
  const snapshot = exportSnapshot(initialState());
  snapshot.data.entries.push(expense({ sourceId: 'id-nao-existe' }));
  assert.throws(() => parseImport(JSON.stringify(snapshot)), /origem inexistente/);
});
test('origens com nomes repetidos não são aceitas', () => {
  const snapshot = exportSnapshot(initialState());
  snapshot.data.sources.push({ id: 'duplicada', name: 'supermercado', kind: 'expense' });
  assert.throws(() => parseImport(JSON.stringify(snapshot)), /Origem duplicada/);
});
test('identificadores repetidos em lançamentos não são aceitos', () => assert.throws(() => validateState(withEntries(expense(), expense())), /duplicado/));
test('estado importado é reconstruído e elimina propriedades desconhecidas', () => {
  const snapshot = exportSnapshot(withEntries(expense()));
  snapshot.data.entries[0].evil = 'não deve ser armazenado';
  snapshot.data.unexpected = true;
  const restored = parseImport(JSON.stringify(snapshot));
  assert.equal('evil' in restored.entries[0], false);
  assert.equal('unexpected' in restored, false);
});
test('receitas não aceitam meio de pagamento nem parcelas', () => assert.throws(() => validateState(withEntries(income({ payment: 'credit' }))), /Receitas não podem/));
test('valor negativo ou zero não passa na validação', () => assert.throws(() => validateState(withEntries(expense({ amountCents: -1 }))), /Valor financeiro/));
