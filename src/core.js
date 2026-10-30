/** Regras financeiras puras: valores em centavos, sem arredondamentos binários. */
export const FORMAT = 'financas-pessoais-local';
export const VERSION = 1;
export const MAX_SOURCES = 200;
export const MAX_ENTRIES = 20000;
export const MAX_PERIOD_MONTHS = 24;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const plain = o => o !== null && typeof o === 'object' && !Array.isArray(o) && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);

export function assertMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900 || Number(month.slice(0, 4)) > 2100) {
    throw new Error('Mês inválido.');
  }
  return month;
}

export function assertDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Data inválida.');
  const y = Number(value.slice(0, 4)), m = Number(value.slice(5, 7)), d = Number(value.slice(8, 10));
  assertMonth(`${value.slice(0, 4)}-${value.slice(5, 7)}`);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) throw new Error('Data inválida.');
  return value;
}

export function monthOf(date) { return assertDate(date).slice(0, 7); }
export function addMonths(month, offset) {
  assertMonth(month);
  if (!Number.isInteger(offset) || Math.abs(offset) > 3000) throw new Error('Deslocamento de mês inválido.');
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const date = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function monthDistance(start, end) {
  assertMonth(start); assertMonth(end);
  return (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(start.slice(5, 7));
}
export function occurrenceDate(date, month) {
  assertDate(date); assertMonth(month);
  const day = Number(date.slice(8, 10));
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${month}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

export function parseMoney(value) {
  const text = String(value).trim().replace(',', '.');
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text)) throw new Error('Informe um valor válido com até 2 casas decimais.');
  const [whole, decimal = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 99999999999) throw new Error('O valor deve ser maior que zero.');
  return cents;
}
export function money(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}
export function splitInstallments(totalCents, count) {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0 || !Number.isInteger(count) || count < 1 || count > 120 || count > totalCents) {
    throw new Error('Valor ou quantidade de parcelas inválidos (mínimo de R$ 0,01 por parcela).');
  }
  const base = Math.floor(totalCents / count), remainder = totalCents % count;
  // Distribui os centavos residuais nas primeiras parcelas, sem perder dinheiro.
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

export function initialState() {
  return {
    schemaVersion: VERSION,
    sources: [
      { id: 'orig-salario', name: 'Salário', kind: 'income' },
      { id: 'orig-freelance', name: 'Serviços extras', kind: 'income' },
      { id: 'orig-outros-rec', name: 'Outras receitas', kind: 'income' },
      { id: 'orig-moradia', name: 'Moradia', kind: 'expense' },
      { id: 'orig-mercado', name: 'Supermercado', kind: 'expense' },
      { id: 'orig-contas', name: 'Contas', kind: 'expense' },
      { id: 'orig-transporte', name: 'Transporte', kind: 'expense' },
      { id: 'orig-assinaturas', name: 'Assinaturas', kind: 'expense' },
      { id: 'orig-saude', name: 'Saúde', kind: 'expense' },
      { id: 'orig-lazer', name: 'Lazer', kind: 'expense' },
      { id: 'orig-outros-desp', name: 'Outras despesas', kind: 'expense' }
    ],
    entries: []
  };
}

function validId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,70}$/.test(id); }
function textField(value, label, max, allowBlank = false) {
  if (typeof value !== 'string' || value.length > max || (!allowBlank && !value.trim())) throw new Error(`${label} inválido(a).`);
  return value.trim();
}

/** Valida e reconstrói cada campo: não aceita objetos arbitrários no armazenamento. */
export function validateState(value) {
  if (!plain(value) || value.schemaVersion !== VERSION || !Array.isArray(value.sources) || !Array.isArray(value.entries)) throw new Error('Estrutura de dados incompatível.');
  if (value.sources.length > MAX_SOURCES || value.entries.length > MAX_ENTRIES) throw new Error('Arquivo excede o limite de registros.');
  const sourceIds = new Set(), entryIds = new Set(), sourceNames = new Set();
  const sources = value.sources.map(source => {
    if (!plain(source) || !validId(source.id) || !['income', 'expense'].includes(source.kind)) throw new Error('Origem com identificador ou tipo inválido.');
    const name = textField(source.name, 'Nome da origem', 60);
    const duplicateName = `${source.kind}:${name.toLocaleLowerCase('pt-BR')}`;
    if (sourceIds.has(source.id) || sourceNames.has(duplicateName)) throw new Error('Origem duplicada.');
    sourceIds.add(source.id); sourceNames.add(duplicateName);
    return { id: source.id, kind: source.kind, name };
  });
  const sourceMap = new Map(sources.map(s => [s.id, s]));
  const entries = value.entries.map(entry => {
    if (!plain(entry) || !validId(entry.id) || entryIds.has(entry.id)) throw new Error('Lançamento com identificador inválido ou duplicado.');
    entryIds.add(entry.id);
    if (!['income', 'expense'].includes(entry.kind)) throw new Error('Tipo de lançamento inválido.');
    const source = sourceMap.get(entry.sourceId);
    if (!source || source.kind !== entry.kind) throw new Error('Lançamento contém origem inexistente ou de outro tipo.');
    const date = assertDate(entry.date);
    const description = textField(entry.description, 'Descrição', 160, true);
    if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents < 1 || entry.amountCents > 99999999999) throw new Error('Valor financeiro inválido.');
    if (!plain(entry.recurrence) || !['none', 'fixed'].includes(entry.recurrence.mode)) throw new Error('Recorrência inválida.');
    let recurrence;
    if (entry.recurrence.mode === 'fixed') {
      const months = entry.recurrence.months;
      if (months !== null && (!Number.isInteger(months) || months < 2 || months > 240)) throw new Error('A recorrência deve durar 2 a 240 meses ou ser indeterminada.');
      recurrence = { mode: 'fixed', months };
    } else {
      if (entry.recurrence.months !== null) throw new Error('Lançamento pontual não pode ter duração recorrente.');
      recurrence = { mode: 'none', months: null };
    }
    if (!Number.isInteger(entry.installments) || entry.installments < 1 || entry.installments > 120) throw new Error('Quantidade de parcelas inválida.');
    let payment = entry.payment;
    if (entry.kind === 'income') {
      if (payment !== null || entry.installments !== 1) throw new Error('Receitas não podem ter parcelamento ou meio de pagamento de despesa.');
    } else {
      if (!['cash', 'pix', 'credit'].includes(payment)) throw new Error('Meio de pagamento inválido.');
      if (payment !== 'credit' && entry.installments !== 1) throw new Error('Dinheiro e Pix não permitem parcelamento.');
      if (recurrence.mode === 'fixed' && entry.installments !== 1) throw new Error('Despesa fixa não pode acumular séries de parcelas.');
      if (payment === 'credit' && recurrence.mode === 'none') splitInstallments(entry.amountCents, entry.installments);
    }
    // v1 original não tinha advances; backups antigos continuam compatíveis.
    const advances = entry.advances === undefined ? [] : entry.advances;
    if (!Array.isArray(advances) || advances.length > 240) throw new Error('Lista de adiantamentos inválida.');
    const usedIndexes = new Set();
    const cleanedAdvances = advances.map(advance => {
      if (!plain(advance) || !Number.isInteger(advance.index) || advance.index < 0 || usedIndexes.has(advance.index)) {
        throw new Error('Adiantamento duplicado ou com índice inválido.');
      }
      usedIndexes.add(advance.index);
      const maxIndex = recurrence.mode === 'fixed'
        ? (recurrence.months === null ? monthDistance(monthOf(date), '2100-12') : recurrence.months - 1)
        : (entry.kind === 'expense' && payment === 'credit' ? entry.installments - 1 : 0);
      if (advance.index > maxIndex) throw new Error('Adiantamento aponta para cobrança inexistente.');
      const scheduledMonth = addMonths(monthOf(date), advance.index);
      const toMonth = assertMonth(advance.toMonth);
      if (monthDistance(toMonth, scheduledMonth) <= 0) throw new Error('Adiantamento deve antecipar a cobrança para mês anterior.');
      return { index: advance.index, toMonth };
    }).sort((a, b) => a.index - b.index);
    return { id: entry.id, kind: entry.kind, sourceId: entry.sourceId, description, date, amountCents: entry.amountCents, recurrence, payment, installments: entry.installments, advances: cleanedAdvances };
  });
  return { schemaVersion: VERSION, sources, entries };
}

/** Uma cobrança tem identidade estável pelo índice ORIGINAL, mesmo após mudar de mês. */
function occurrenceCount(entry) {
  if (entry.recurrence.mode === 'fixed') return entry.recurrence.months;
  return entry.kind === 'expense' && entry.payment === 'credit' ? entry.installments : 1;
}
function validOccurrenceIndex(entry, index) {
  const length = occurrenceCount(entry);
  return Number.isInteger(index) && index >= 0 && (length === null || index < length);
}
function occurrenceAtIndex(entry, index, effectiveMonth) {
  const originalMonth = addMonths(monthOf(entry.date), index);
  const installment = entry.kind === 'expense' && entry.payment === 'credit' && entry.recurrence.mode === 'none';
  const amountCents = installment ? splitInstallments(entry.amountCents, entry.installments)[index] : entry.amountCents;
  return {
    entryId: entry.id, entry, month: effectiveMonth,
    originalMonth, occurrenceIndex: index, advanced: effectiveMonth !== originalMonth,
    date: occurrenceDate(entry.date, effectiveMonth), amountCents,
    part: installment && entry.installments > 1 ? `${index + 1}/${entry.installments}` : null
  };
}

/** Retorna TODAS as cobranças num mês; duas parcelas podem cair no mesmo mês. */
export function entryOccurrencesInMonth(entry, month) {
  assertMonth(month);
  const result = [];
  const index = monthDistance(monthOf(entry.date), month);
  const advances = entry.advances || [];
  // Ocorrência originalmente agendada para este mês, salvo quando antecipada.
  if (validOccurrenceIndex(entry, index) && !advances.some(a => a.index === index)) {
    result.push(occurrenceAtIndex(entry, index, month));
  }
  // Cobranças futuras antecipadas para este mês (inclusive várias parcelas).
  for (const advance of advances) {
    if (advance.toMonth === month && validOccurrenceIndex(entry, advance.index)) {
      result.push(occurrenceAtIndex(entry, advance.index, month));
    }
  }
  return result.sort((a, b) => a.occurrenceIndex - b.occurrenceIndex);
}

/** API legada, para quem precisa apenas da primeira ocorrência do mês. */
export function occurrenceFor(entry, month) { return entryOccurrencesInMonth(entry, month)[0] || null; }

export function monthOccurrences(state, month) {
  assertMonth(month);
  return state.entries.flatMap(entry => entryOccurrencesInMonth(entry, month))
    .sort((a, b) => b.date.localeCompare(a.date) || a.entryId.localeCompare(b.entryId) || a.occurrenceIndex - b.occurrenceIndex);
}

/** Valida a antecipação de apenas uma competência e devolve série editada. */
export function advanceOccurrence(entry, occurrenceIndex, toMonth) {
  if (!validOccurrenceIndex(entry, occurrenceIndex)) throw new Error('Cobrança inexistente.');
  assertMonth(toMonth);
  const originalMonth = addMonths(monthOf(entry.date), occurrenceIndex);
  if (monthDistance(toMonth, originalMonth) <= 0) throw new Error('Escolha um mês anterior ao vencimento original.');
  const advances = (entry.advances || []).filter(a => a.index !== occurrenceIndex);
  advances.push({ index: occurrenceIndex, toMonth });
  return { ...entry, advances: advances.sort((a, b) => a.index - b.index) };
}
export function reverseAdvance(entry, occurrenceIndex) {
  return { ...entry, advances: (entry.advances || []).filter(a => a.index !== occurrenceIndex) };
}

/** Projeção somente em memória: nenhuma gravação nem inserção na base real. */
export function simulateExpense(state, configuration, months) {
  if (![1, 3, 6].includes(months)) throw new Error('Horizonte de simulação inválido.');
  const ephemeralSource = { id: 'sim-source', kind: 'expense', name: 'Despesa simulada' };
  const ephemeralEntry = {
    id: 'sim-entry', kind: 'expense', sourceId: ephemeralSource.id,
    description: '', advances: [], ...configuration
  };
  // Isola a simulação da base persistida e aplica as mesmas regras de validação.
  const temporary = validateState({ schemaVersion: VERSION, sources: [ephemeralSource], entries: [ephemeralEntry] });
  const candidate = temporary.entries[0];
  const from = monthOf(candidate.date);
  return Array.from({ length: months }, (_, i) => {
    const month = addMonths(from, i);
    const baseline = monthSummary(state, month);
    const simulatedItems = entryOccurrencesInMonth(candidate, month);
    const additionalExpense = simulatedItems.reduce((sum, item) => sum + item.amountCents, 0);
    return {
      month, baseline, additionalExpense, simulatedItems,
      projected: { ...baseline, expense: baseline.expense + additionalExpense,
        variableExpense: baseline.variableExpense + (candidate.recurrence.mode === 'none' ? additionalExpense : 0),
        fixedExpense: baseline.fixedExpense + (candidate.recurrence.mode === 'fixed' ? additionalExpense : 0),
        balance: baseline.balance - additionalExpense }
    };
  });
}
/**
 * Simula antecipações de cobranças existentes, somente em memória.
 * Cada item do plano identifica uma ocorrência pelo índice ORIGINAL da série.
 * O destino é limitado à janela visível, para que o resultado seja verificável.
 * Uma ocorrência já antecipada pode ser movida para um mês ainda anterior,
 * mas nunca para frente de sua competência efetiva atual.
 */
export function simulateAdvances(state, plan, fromMonth, months) {
  assertMonth(fromMonth);
  if (![1, 3, 6].includes(months)) throw new Error('Horizonte de simulação inválido.');
  if (!Array.isArray(plan) || plan.length > 120) throw new Error('Plano de adiantamentos inválido.');
  const lastMonth = addMonths(fromMonth, months - 1);
  assertMonth(lastMonth);
  const actual = validateState(state);
  const entries = actual.entries.map(entry => ({ ...entry, advances: [...entry.advances] }));
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const chosen = new Set();
  const movements = [];

  for (const step of plan) {
    if (!plain(step) || typeof step.entryId !== 'string' || !Number.isInteger(step.occurrenceIndex)) {
      throw new Error('Cobrança simulada inválida.');
    }
    const entry = byId.get(step.entryId);
    if (!entry || entry.kind !== 'expense' || !validOccurrenceIndex(entry, step.occurrenceIndex)) {
      throw new Error('A despesa selecionada não existe mais.');
    }
    const identity = `${entry.id}:${step.occurrenceIndex}`;
    if (chosen.has(identity)) throw new Error('A mesma cobrança não pode ser adiantada duas vezes no cenário.');
    chosen.add(identity);
    const originalMonth = addMonths(monthOf(entry.date), step.occurrenceIndex);
    const activeMonth = entry.advances.find(a => a.index === step.occurrenceIndex)?.toMonth ?? originalMonth;
    const toMonth = assertMonth(step.toMonth);
    if (toMonth < fromMonth || toMonth > lastMonth) {
      throw new Error('O destino precisa estar dentro dos meses exibidos na simulação.');
    }
    if (monthDistance(toMonth, activeMonth) <= 0) {
      throw new Error('O mês simulado precisa ser anterior ao vencimento atual da cobrança.');
    }
    const changed = advanceOccurrence(entry, step.occurrenceIndex, toMonth);
    byId.set(entry.id, changed);
    const position = entries.findIndex(item => item.id === entry.id);
    entries[position] = changed;
    const amountCents = occurrenceAtIndex(entry, step.occurrenceIndex, activeMonth).amountCents;
    movements.push({ entryId: entry.id, occurrenceIndex: step.occurrenceIndex, originalMonth,
      fromMonth: activeMonth, toMonth, amountCents });
  }

  const virtualState = { ...actual, entries };
  const projection = Array.from({ length: months }, (_, i) => {
    const month = addMonths(fromMonth, i);
    const baseline = monthSummary(actual, month);
    const projected = monthSummary(virtualState, month);
    return {
      month, baseline, projected, expenseChange: projected.expense - baseline.expense,
      balanceChange: projected.balance - baseline.balance,
      arrived: movements.filter(move => move.toMonth === month),
      departed: movements.filter(move => move.fromMonth === month)
    };
  });
  return { projection, movements };
}

export function periodOccurrences(state, from, to) {
  const length = monthDistance(from, to) + 1;
  if (length < 1 || length > MAX_PERIOD_MONTHS) throw new Error(`Selecione um período de até ${MAX_PERIOD_MONTHS} meses.`);
  return Array.from({ length }, (_, i) => monthOccurrences(state, addMonths(from, i))).flat().sort((a, b) => b.date.localeCompare(a.date));
}
export function monthSummary(state, month) {
  const items = monthOccurrences(state, month);
  const summary = { income: 0, expense: 0, balance: 0, fixedExpense: 0, variableExpense: 0 };
  for (const item of items) {
    if (item.entry.kind === 'income') summary.income += item.amountCents;
    else {
      summary.expense += item.amountCents;
      if (item.entry.recurrence.mode === 'fixed') summary.fixedExpense += item.amountCents;
      else summary.variableExpense += item.amountCents;
    }
  }
  summary.balance = summary.income - summary.expense;
  return summary;
}
export function expenseBySource(state, month) {
  const amounts = new Map();
  for (const item of monthOccurrences(state, month)) {
    if (item.entry.kind === 'expense') amounts.set(item.entry.sourceId, (amounts.get(item.entry.sourceId) || 0) + item.amountCents);
  }
  return [...amounts.entries()].map(([sourceId, amountCents]) => ({ sourceId, amountCents })).sort((a, b) => b.amountCents - a.amountCents);
}
export function exportSnapshot(state, exportedAt = new Date().toISOString()) {
  return { format: FORMAT, formatVersion: VERSION, exportedAt, data: validateState(state) };
}
export function parseImport(text) {
  if (typeof text !== 'string' || text.length > 10_000_000) throw new Error('Arquivo vazio ou grande demais (limite: 10 MB).');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('O arquivo não contém um JSON válido.'); }
  if (!plain(parsed) || parsed.format !== FORMAT || parsed.formatVersion !== VERSION || typeof parsed.exportedAt !== 'string' || !Number.isFinite(Date.parse(parsed.exportedAt))) {
    throw new Error('Este arquivo não é um backup compatível deste aplicativo.');
  }
  return validateState(parsed.data);
}
