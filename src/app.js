import {
  initialState, validateState, exportSnapshot, parseImport,
  monthOf, addMonths, monthDistance, occurrenceDate, money, parseMoney,
  splitInstallments, monthOccurrences, periodOccurrences, monthSummary,
  expenseBySource, MAX_SOURCES, advanceOccurrence, reverseAdvance, simulateExpense, simulateAdvances,
  entryOccurrencesInMonth, assertMonth
} from './core.js';
import { openStorage, readState, saveState } from './storage.js';
import { ClaraCloud, cloudConfigured, CloudRevisionError } from './cloud.js';
import { planSync, sameFinancialState, SyncConflict } from './sync.js';

const $ = id => document.getElementById(id);
const create = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const localToday = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const dateBR = date => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
const monthBR = month => new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));
const paymentNames = { cash: 'Dinheiro', pix: 'Pix', credit: 'Cartão de crédito' };

let db;
let revision = 0;
let state;
let selectedMonth = localToday().slice(0, 7);
let activeView = 'dashboard';
let editingEntryId = null;
let editingSourceId = null;
let advanceSelection = null;
let simulationMode = 'new';
let simulatedAdvances = []; // Somente memória: nunca passa por commit() ou sincronização.
let queue = Promise.resolve();
let toastTimer;
let syncMeta = null; // {userId, base, remoteRevision}: persistido atomicamente com o snapshot
const cloud = cloudConfigured() ? new ClaraCloud() : null;
let cloudVerified = false;
let cloudStatus = cloud ? 'desconectado' : 'não configurado';
let cloudDetails = '';
let cloudSyncPromise = null;
let cloudSyncTimer = null;
let cloudConflict = false;
let cloudAccountBusy = false;

function notify(message, type = 'success') {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast visible ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 4500);
}
function errorMessage(error) {
  if (error?.name === 'QuotaExceededError') return 'Armazenamento cheio. Exporte um backup e libere espaço no dispositivo.';
  return error?.message || 'Ocorreu um erro inesperado.';
}
function markStorageError(error) {
  $('storage-warning').textContent = `Não foi possível salvar: ${errorMessage(error)} Os dados anteriores continuam preservados. Tente novamente ou exporte um backup.`;
  $('storage-warning').hidden = false;
}

/** Ações serializadas: salva no IndexedDB ANTES de refletir o novo estado na tela. */
function commit(mutator) {
  const operation = queue.then(async () => {
    const draft = structuredClone(state);
    const result = mutator(draft);
    const next = validateState(result === undefined ? draft : result);
    const nextRevision = await saveState(db, next, revision, syncMeta);
    state = next;
    revision = nextRevision;
    $('storage-warning').hidden = true;
    renderAll();
    scheduleCloudSync();
  });
  queue = operation.catch(() => {});
  return operation.catch(error => { markStorageError(error); throw error; });
}

/** A autenticação fica separada dos dados: nenhuma ação financeira depende de conexão. */
function cloudStatusSet(status, message = '') {
  cloudStatus = status;
  cloudDetails = message;
  renderCloudPanel();
}
function renderCloudPanel() {
  const configured = Boolean(cloud);
  const logged = Boolean(cloud?.authenticated);
  const currentUser = logged ? cloud.user.email || cloud.user.id : '';
  $('cloud-config-warning').hidden = configured;
  $('cloud-auth-panel').hidden = !configured || logged;
  $('cloud-account-panel').hidden = !logged;
  $('cloud-user-name').textContent = currentUser;
  const statusLabels = {
    'não configurado': 'Sem configuração de nuvem',
    desconectado: 'Modo local — sem sincronização',
    conectando: 'Verificando sua conta…',
    configuração: 'Conta conectada — escolha como iniciar',
    sincronizando: 'Sincronizando alterações…',
    sincronizado: 'Tudo sincronizado',
    pendente: 'Alterações salvas localmente; sincronização pendente',
    conflito: 'Conflito entre dispositivos — ação necessária',
    offline: 'Sem conexão — seus dados estão salvos localmente',
    erro: 'Atenção: sincronização não concluída'
  };
  const label = statusLabels[cloudStatus] || cloudStatus;
  $('cloud-status').textContent = `${label}${cloudDetails ? ` — ${cloudDetails}` : ''}`;
  $('cloud-status').className = `cloud-status cloud-${cloudStatus}`;
  $('cloud-top-status').textContent = logged ? (cloudStatus === 'sincronizado' ? '✓ Sincronizado' : cloudStatus === 'sincronizando' ? '↻ Sincronizando' : '● ' + label) : '● Somente local';
  const requiresSetup = logged && (syncMeta?.userId !== cloud.user.id || !syncMeta.base);
  $('cloud-setup').hidden = !requiresSetup;
  $('cloud-sync-actions').hidden = !logged || requiresSetup;
  $('cloud-conflict-actions').hidden = !logged || cloudStatus !== 'conflito';
  $('cloud-sync-now').disabled = cloudStatus === 'sincronizando' || cloudAccountBusy;
  $('cloud-email').disabled = cloudAccountBusy;
  $('cloud-password').disabled = cloudAccountBusy;
  $('cloud-login').disabled = cloudAccountBusy;
  $('cloud-register').disabled = cloudAccountBusy;
  $('cloud-logout').disabled = cloudAccountBusy;
}

function scheduleCloudSync() {
  if (!cloud?.authenticated || !cloudVerified || cloudConflict) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => { requestCloudSync().catch(() => {}); }, 550);
}

/** Toda sync atravessa a mesma fila dos commits locais; isso impede que uma
 * resposta da rede sobrescreva uma edição iniciada enquanto a requisição estava em voo. */
function requestCloudSync() {
  if (cloudSyncPromise) return cloudSyncPromise;
  const task = queue.then(() => syncCloudOnce());
  queue = task.catch(() => {});
  cloudSyncPromise = task.finally(() => { cloudSyncPromise = null; });
  return cloudSyncPromise;
}
async function persistCloudResult(next, remoteRevision) {
  // Snapshot, revisão remota e ancestral são confirmados na MESMA transação local.
  // Em crash após upload e antes deste commit, o próximo fetch compara o remoto
  // e converge sem duplicar lançamentos.
  const clean = validateState(next);
  const metadata = { userId: cloud.user.id, remoteRevision, base: clean };
  const nextRevision = await saveState(db, clean, revision, metadata);
  state = clean;
  revision = nextRevision;
  syncMeta = metadata;
  $('storage-warning').hidden = true;
  renderAll();
}
async function syncCloudOnce() {
  if (!cloud?.authenticated) return;
  if (!navigator.onLine) { cloudStatusSet('offline'); return; }
  if (!cloudVerified) {
    try { await cloud.verifyUser(); cloudVerified = true; }
    catch (error) { cloudStatusSet('erro', errorMessage(error)); throw error; }
  }
  if (syncMeta?.userId !== cloud.user.id || !syncMeta?.base) {
    cloudStatusSet('configuração', 'Nada será enviado antes da sua escolha.');
    return;
  }
  cloudStatusSet('sincronizando');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remoteRevision = await cloud.getRevision();
      if (remoteRevision === null || remoteRevision < syncMeta.remoteRevision) {
        throw new SyncConflict('A revisão remota desapareceu ou foi revertida. A sincronização foi pausada.');
      }
      const localChanged = !sameFinancialState(syncMeta.base, state);
      // Caminho comum: nenhum dado mudou, apenas conferimos a revisão (poll barato).
      if (!localChanged && remoteRevision === syncMeta.remoteRevision) {
        cloudConflict = false;
        cloudStatusSet('sincronizado');
        return;
      }
      // Apenas alterações locais: evita baixar o JSON inteiro, mas exige CAS no upload.
      if (localChanged && remoteRevision === syncMeta.remoteRevision) {
        try {
          const writtenRevision = await cloud.updateSnapshot(state, remoteRevision);
          await persistCloudResult(state, writtenRevision);
          cloudConflict = false;
          cloudStatusSet('sincronizado');
          return;
        } catch (error) {
          if (error instanceof CloudRevisionError) continue;
          throw error;
        }
      }
      // Outra sessão alterou a base: baixa a versão completa para merge/atualização.
      const remote = await cloud.getSnapshot();
      if (!remote) throw new SyncConflict('O registro remoto não existe mais.');
      if (remote.revision < syncMeta.remoteRevision) throw new SyncConflict('A revisão remota foi revertida.');
      // Não pressupor que a revisão consultada continue igual: a atualização CAS
      // sobre remote.revision protegerá de uma terceira mudança simultânea.
      const plan = planSync(syncMeta.base, state, remote.data);
      if (plan.action === 'push') {
        try {
          const writtenRevision = await cloud.updateSnapshot(plan.next, remote.revision);
          await persistCloudResult(plan.next, writtenRevision);
          cloudConflict = false;
          cloudStatusSet('sincronizado');
          return;
        } catch (error) {
          if (error instanceof CloudRevisionError) continue;
          throw error;
        }
      }
      await persistCloudResult(plan.next, remote.revision);
      cloudConflict = false;
      cloudStatusSet('sincronizado');
      return;
    }
    throw new SyncConflict('Muitas alterações simultâneas. Sincronização interrompida para preservar seus dados.');
  } catch (error) {
    cloudConflict = error instanceof SyncConflict;
    cloudStatusSet(cloudConflict ? 'conflito' : 'pendente', errorMessage(error));
    throw error;
  }
}

async function beginCloudSession() {
  if (!cloud?.authenticated) { cloudStatusSet('desconectado'); return; }
  cloudStatusSet('conectando');
  try {
    await cloud.verifyUser();
    cloudVerified = true;
    await requestCloudSync();
  } catch (error) {
    if (!cloud.authenticated) { cloudStatusSet('desconectado', 'Entre novamente.'); return; }
    cloudStatusSet('offline', errorMessage(error));
  }
}
async function cloudAccountAction(action) {
  const email = $('cloud-email').value.trim();
  const password = $('cloud-password').value;
  if (!email || !password) { notify('Informe e-mail e senha.', 'error'); return; }
  if (password.length < 6) { notify('Use uma senha de pelo menos 6 caracteres.', 'error'); return; }
  cloudAccountBusy = true; renderCloudPanel();
  try {
    if (action === 'register') {
      const result = await cloud.register(email, password);
      if (result.requiresConfirmation) {
        $('cloud-password').value = '';
        notify('Cadastro solicitado. Confirme o e-mail recebido e depois entre na conta.');
        return;
      }
    } else await cloud.login(email, password);
    $('cloud-password').value = '';
    cloudVerified = true;
    cloudConflict = false;
    await requestCloudSync();
  } catch (error) { notify(errorMessage(error), 'error'); cloudStatusSet('erro', errorMessage(error)); }
  finally { cloudAccountBusy = false; renderCloudPanel(); }
}

function cloudAdoption(direction) {
  const localCount = state.entries.length;
  const uploading = direction === 'upload';
  confirmDialog({
    title: uploading ? 'Enviar dados locais para sua conta?' : 'Substituir dados locais pelos da nuvem?',
    message: uploading
      ? `Você enviará ${localCount} lançamentos deste dispositivo à conta ${cloud.user.email}. Se a nuvem já tiver dados, serão SUBSTITUÍDOS. Antes, exporte um backup JSON. Nenhum outro aparelho será alterado sem sincronizar.`
      : `Os ${localCount} lançamentos locais serão substituídos pela versão da nuvem. Alterações que estejam apenas neste aparelho serão perdidas. Exporte um backup JSON antes de continuar.`,
    confirmLabel: uploading ? 'Confirmar envio à nuvem' : 'Confirmar uso da nuvem',
    onConfirm: async () => {
      const action = queue.then(async () => {
        cloudStatusSet('sincronizando');
        await cloud.verifyUser();
        cloudVerified = true;
        const remote = await cloud.getSnapshot();
        if (!uploading) {
          if (!remote) throw new Error('Sua conta ainda não possui dados remotos. Escolha enviar os dados locais.');
          await persistCloudResult(remote.data, remote.revision);
        } else {
          // CAS também na adoção: se outro dispositivo gravar durante a ação,
          // rejeita em vez de substituir uma versão que não vimos.
          const remoteRevision = remote ? await cloud.updateSnapshot(state, remote.revision) : await cloud.insertSnapshot(state);
          await persistCloudResult(state, remoteRevision);
        }
        cloudConflict = false;
        cloudStatusSet('sincronizado');
      });
      queue = action.catch(() => {});
      try { await action; }
      catch (error) { cloudStatusSet(error instanceof CloudRevisionError ? 'conflito' : 'pendente', errorMessage(error)); throw error; }
    }
  });
}

function sourceOf(id) { return state.sources.find(s => s.id === id); }
function setView(view) {
  if (!['dashboard', 'transactions', 'simulation', 'sources', 'settings'].includes(view)) return;
  activeView = view;
  for (const element of document.querySelectorAll('.view')) element.hidden = element.id !== `view-${view}`;
  for (const item of document.querySelectorAll('[data-nav]')) {
    const current = item.dataset.nav === view;
    item.classList.toggle('active', current);
    if (current) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderAll() {
  renderDashboard();
  renderSourceFilters();
  renderTransactions();
  renderSources();
  renderSimulation();
  renderCloudPanel();
}

function renderDashboard() {
  $('current-month').textContent = monthBR(selectedMonth);
  const totals = monthSummary(state, selectedMonth);
  $('total-income').textContent = money(totals.income);
  $('total-expense').textContent = money(totals.expense);
  $('total-balance').textContent = money(totals.balance);
  $('total-balance').classList.toggle('negative', totals.balance < 0);
  $('total-fixed').textContent = money(totals.fixedExpense);
  $('fixed-caption').textContent = `${totals.expense ? Math.round(totals.fixedExpense / totals.expense * 100) : 0}% das despesas do mês`;
  $('variable-split').textContent = money(totals.variableExpense);
  $('fixed-split').textContent = money(totals.fixedExpense);
  renderComparison();
  renderOriginsChart(totals.expense);
  renderList($('recent-list'), monthOccurrences(state, selectedMonth).slice(0, 6));
}

function renderComparison() {
  const chart = $('comparison-chart');
  chart.replaceChildren();
  const months = Array.from({ length: 6 }, (_, i) => addMonths(selectedMonth, i - 5)).filter(m => m >= '1900-01');
  const items = months.map(m => ({ month: m, ...monthSummary(state, m) }));
  const peak = Math.max(1, ...items.map(item => Math.max(item.income, item.expense)));
  chart.setAttribute('aria-label', `Receitas e despesas de ${monthBR(months[0])} a ${monthBR(months[5])}. ` + items.map(item => `${monthBR(item.month)}: ${money(item.income)} em receitas e ${money(item.expense)} em despesas`).join('; '));
  for (const item of items) {
    const group = create('div', 'chart-month');
    const bars = create('div', 'chart-bars');
    for (const kind of ['income', 'expense']) {
      const bar = create('div', `chart-bar ${kind}`);
      bar.style.height = `${item[kind] ? Math.max(4, item[kind] / peak * 155) : 2}px`;
      bar.title = `${kind === 'income' ? 'Receitas' : 'Despesas'}: ${money(item[kind])}`;
      bars.append(bar);
    }
    const label = create('span', 'chart-label', new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' }).format(new Date(`${item.month}-01T12:00:00Z`)).replace('.', ''));
    group.append(bars, label);
    chart.append(group);
  }
}

function renderOriginsChart(totalExpense) {
  const chart = $('origins-chart');
  chart.replaceChildren();
  const items = expenseBySource(state, selectedMonth).slice(0, 6);
  if (!items.length) { chart.append(create('p', 'empty-chart', 'Suas despesas por origem aparecerão aqui.')); return; }
  for (const item of items) {
    const source = sourceOf(item.sourceId);
    const row = create('div', 'origin-stat');
    const heading = create('div', 'origin-stat-heading');
    heading.append(create('span', '', source?.name || 'Origem desconhecida'), create('strong', '', money(item.amountCents)));
    const track = create('div', 'origin-track');
    const bar = create('div', 'origin-bar');
    bar.style.width = `${Math.max(1, item.amountCents / totalExpense * 100)}%`;
    track.append(bar); row.append(heading, track); chart.append(row);
  }
}

function emptyList(container) {
  const empty = create('div', 'empty-state');
  empty.append(create('div', 'empty-icon', '◌'), create('strong', '', 'Nada por aqui ainda'), create('p', '', 'Experimente outro período ou cadastre uma movimentação.'));
  container.append(empty);
}

function renderList(container, items) {
  container.replaceChildren();
  if (!items.length) { emptyList(container); return; }
  for (const item of items) {
    const entry = item.entry;
    const income = entry.kind === 'income';
    const origin = sourceOf(entry.sourceId);
    const row = create('article', `transaction-row${item.advanced ? ' advanced-row' : ''}`);
    const symbol = create('div', `transaction-symbol ${income ? 'symbol-income' : 'symbol-expense'}`, income ? '↙' : '↗');
    const details = create('div', 'transaction-details');
    const title = create('div', 'transaction-title', entry.description || origin?.name || 'Lançamento');
    const meta = create('div', 'transaction-meta');
    const classification = income ? (entry.recurrence.mode === 'fixed' ? 'Recorrente' : 'Pontual') : (entry.recurrence.mode === 'fixed' ? 'Fixa' : 'Variável');
    meta.textContent = `${origin?.name || 'Sem origem'} · ${dateBR(item.date)} · ${income ? 'Receita' : paymentNames[entry.payment]} · ${classification}${item.part ? ` · Parcela ${item.part}` : ''}${item.advanced ? ` · Adiantada de ${monthBR(item.originalMonth)}` : ''}`;
    details.append(title, meta);
    const right = create('div', 'transaction-right');
    const value = create('strong', `transaction-value ${income ? 'positive' : ''}`, `${income ? '+' : '−'} ${money(item.amountCents)}`);
    const actions = create('div', 'transaction-actions');
    const edit = create('button', 'mini-action', 'Editar');
    edit.type = 'button'; edit.setAttribute('aria-label', `Editar série: ${entry.description || origin?.name}`);
    edit.addEventListener('click', () => openEntry(entry));
    const remove = create('button', 'mini-action remove-action', 'Excluir');
    remove.type = 'button'; remove.setAttribute('aria-label', `Excluir série: ${entry.description || origin?.name}`);
    remove.addEventListener('click', () => confirmDialog({
      title: 'Excluir lançamento?',
      message: `Você vai excluir ${entry.description || origin?.name || 'este lançamento'} e todas as suas ocorrências, inclusive as parcelas e os meses anteriores. Essa ação não pode ser desfeita.`,
      confirmLabel: 'Excluir lançamento',
      onConfirm: () => commit(draft => { draft.entries = draft.entries.filter(e => e.id !== entry.id); })
    }));
    if (!income) {
      const advance = create('button', 'mini-action advance-action', item.advanced ? 'Reverter' : 'Adiantar');
      advance.type = 'button';
      advance.setAttribute('aria-label', `${item.advanced ? 'Reverter adiantamento de' : 'Adiantar'} ${entry.description || origin?.name} ${item.part ? `parcela ${item.part}` : ''} de ${monthBR(item.originalMonth)}`);
      advance.addEventListener('click', () => item.advanced ? confirmReverseAdvance(item) : openAdvance(item));
      actions.append(advance);
    }
    actions.append(edit, remove); right.append(value, actions); row.append(symbol, details, right); container.append(row);
  }
}

function currentFilters() {
  return {
    search: $('filter-search').value.trim().toLocaleLowerCase('pt-BR'),
    kind: $('filter-kind').value,
    source: $('filter-source').value,
    payment: $('filter-payment').value,
    from: $('filter-from').value,
    to: $('filter-to').value
  };
}
function renderSourceFilters() {
  const select = $('filter-source');
  const previous = select.value;
  select.replaceChildren(new Option('Todas', 'all'));
  for (const source of [...state.sources].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) select.add(new Option(`${source.name} (${source.kind === 'income' ? 'receita' : 'despesa'})`, source.id));
  select.value = state.sources.some(s => s.id === previous) ? previous : 'all';
}
function renderTransactions() {
  const filters = currentFilters();
  let items;
  try { items = periodOccurrences(state, filters.from, filters.to); }
  catch (error) {
    $('filter-result-count').textContent = errorMessage(error);
    $('all-transactions').replaceChildren(); emptyList($('all-transactions'));
    return;
  }
  items = items.filter(item => {
    const entry = item.entry;
    if (filters.kind === 'income' && entry.kind !== 'income') return false;
    if (filters.kind === 'expense' && entry.kind !== 'expense') return false;
    if (filters.kind === 'fixed' && (entry.kind !== 'expense' || entry.recurrence.mode !== 'fixed')) return false;
    if (filters.kind === 'variable' && (entry.kind !== 'expense' || entry.recurrence.mode !== 'none')) return false;
    if (filters.source !== 'all' && entry.sourceId !== filters.source) return false;
    if (filters.payment !== 'all' && (filters.payment === 'income' ? entry.kind !== 'income' : entry.payment !== filters.payment)) return false;
    const haystack = `${entry.description} ${sourceOf(entry.sourceId)?.name || ''}`.toLocaleLowerCase('pt-BR');
    return haystack.includes(filters.search);
  });
  $('filter-result-count').textContent = `${items.length} ocorrência${items.length === 1 ? '' : 's'} encontrada${items.length === 1 ? '' : 's'}`;
  renderList($('all-transactions'), items);
}

function renderSources() {
  for (const kind of ['income', 'expense']) {
    const root = $(`${kind}-sources`);
    root.replaceChildren();
    const sources = state.sources.filter(s => s.kind === kind).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    if (!sources.length) { root.append(create('p', 'empty-chart', 'Nenhuma origem cadastrada.')); continue; }
    for (const source of sources) {
      const count = state.entries.filter(entry => entry.sourceId === source.id).length;
      const item = create('div', 'source-row');
      const info = create('div', 'source-info');
      info.append(create('strong', '', source.name), create('span', '', `${count} lançamento${count === 1 ? '' : 's'} vinculado${count === 1 ? '' : 's'}`));
      const actions = create('div', 'source-actions');
      const edit = create('button', 'mini-action', 'Editar'); edit.type = 'button'; edit.addEventListener('click', () => openSource(source));
      const remove = create('button', 'mini-action remove-action', 'Excluir'); remove.type = 'button';
      remove.addEventListener('click', () => {
        if (count) { notify('Esta origem está em uso. Mude a origem dos lançamentos antes de excluí-la.', 'error'); return; }
        confirmDialog({ title: 'Excluir origem?', message: `Deseja excluir a origem "${source.name}"?`, confirmLabel: 'Excluir origem', onConfirm: () => commit(draft => { draft.sources = draft.sources.filter(s => s.id !== source.id); }) });
      });
      actions.append(edit, remove); item.append(info, actions); root.append(item);
    }
  }
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `id_${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}
function fillSourceSelect(kind, selected = '') {
  const select = $('entry-source');
  select.replaceChildren();
  const sources = state.sources.filter(source => source.kind === kind).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  for (const source of sources) select.add(new Option(source.name, source.id));
  if (sources.some(s => s.id === selected)) select.value = selected;
  if (!sources.length) select.add(new Option('Cadastre uma origem primeiro', ''));
}
function openEntry(entry = null) {
  editingEntryId = entry?.id || null;
  $('entry-form').reset();
  $('form-error').hidden = true;
  $('entry-dialog-title').textContent = entry ? 'Editar lançamento' : 'Novo lançamento';
  $('edit-hint').hidden = !entry;
  $('entry-kind').value = entry?.kind || 'expense';
  fillSourceSelect($('entry-kind').value, entry?.sourceId);
  $('entry-description').value = entry?.description || '';
  $('entry-date').value = entry?.date || occurrenceDate(localToday(), selectedMonth);
  $('entry-recurrence').value = entry?.recurrence.mode || 'none';
  $('entry-term').value = entry?.recurrence.months ? 'limited' : 'indefinite';
  $('entry-months').value = entry?.recurrence.months || 12;
  $('entry-payment').value = entry?.payment || 'pix';
  $('entry-installments').value = entry?.installments || 1;
  $('entry-value-mode').value = 'total';
  $('entry-amount').value = entry ? (entry.amountCents / 100).toFixed(2).replace('.', ',') : '';
  updateEntryFields();
  $('entry-dialog').showModal();
  $('entry-description').focus();
}
function updateEntryFields() {
  const income = $('entry-kind').value === 'income';
  const fixed = $('entry-recurrence').value === 'fixed';
  const credit = !income && $('entry-payment').value === 'credit';
  const installments = credit && !fixed;
  $('entry-recurrence-label').textContent = income ? 'Frequência da receita' : 'Classificação';
  $('entry-recurrence').options[0].textContent = income ? 'Pontual' : 'Variável (pontual ou parcelada)';
  $('entry-recurrence').options[1].textContent = income ? 'Recorrente' : 'Fixa (recorrente)';
  $('entry-term-wrap').hidden = !fixed;
  $('entry-months-wrap').hidden = !fixed || $('entry-term').value !== 'limited';
  $('entry-payment-wrap').hidden = income;
  $('entry-installments-wrap').hidden = !installments;
  $('entry-value-mode-wrap').hidden = !installments;
  $('entry-amount-label').textContent = income ? (fixed ? 'Valor mensal (R$)' : 'Valor recebido (R$)') : fixed ? 'Valor mensal (R$)' : installments && $('entry-value-mode').value === 'each' ? 'Valor de cada parcela (R$)' : 'Valor total (R$)';
  $('entry-date-label').textContent = installments ? 'Data da primeira parcela' : fixed ? 'Data da primeira ocorrência' : 'Data da movimentação';
  const preview = $('entry-preview');
  if (!income && credit && fixed) {
    preview.textContent = 'Despesa fixa no cartão: uma cobrança por mês (1x por ocorrência). Para uma compra parcelada, selecione despesa variável.';
    return;
  }
  if (installments) {
    try {
      const count = Number($('entry-installments').value);
      const given = parseMoney($('entry-amount').value);
      const total = $('entry-value-mode').value === 'each' ? given * count : given;
      const parts = splitInstallments(total, count);
      preview.textContent = `${count}x no cartão · ${money(total)} no total · ${parts.every(p => p === parts[0]) ? `${money(parts[0])} por parcela` : `de ${money(Math.min(...parts))} a ${money(Math.max(...parts))} por parcela`} · a partir de ${$('entry-date').value ? dateBR($('entry-date').value) : 'data escolhida'}`;
    } catch { preview.textContent = 'Informe valor e número de parcelas para ver a distribuição mensal.'; }
  } else if (fixed) preview.textContent = `Repetição mensal ${$('entry-term').value === 'indefinite' ? 'indeterminada' : `durante ${$('entry-months').value || '?'} meses`}.`;
  else preview.textContent = 'Um lançamento único no mês selecionado.';
}
function showFormError(id, message) { $(id).textContent = message; $(id).hidden = false; }

async function submitEntry(event) {
  event.preventDefault();
  $('form-error').hidden = true;
  const kind = $('entry-kind').value;
  const recurrenceMode = $('entry-recurrence').value;
  const payment = kind === 'income' ? null : $('entry-payment').value;
  const fixed = recurrenceMode === 'fixed';
  const installmentCount = kind === 'expense' && !fixed && payment === 'credit' ? Number($('entry-installments').value) : 1;
  try {
    if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 120) throw new Error('Informe entre 1 e 120 parcelas.');
    const sourceId = $('entry-source').value;
    if (!state.sources.some(s => s.id === sourceId && s.kind === kind)) throw new Error('Selecione uma origem válida. Cadastre uma nova origem, se necessário.');
    const amount = parseMoney($('entry-amount').value);
    const amountCents = kind === 'expense' && payment === 'credit' && !fixed && $('entry-value-mode').value === 'each' ? amount * installmentCount : amount;
    if (!Number.isSafeInteger(amountCents) || amountCents > 99999999999) throw new Error('O valor total excede o limite aceito.');
    const months = fixed && $('entry-term').value === 'limited' ? Number($('entry-months').value) : null;
    const entry = {
      id: editingEntryId || makeId(), kind, sourceId, description: $('entry-description').value.trim(),
      date: $('entry-date').value, amountCents,
      recurrence: { mode: recurrenceMode, months }, payment, installments: installmentCount
    };
    await commit(draft => {
      const index = draft.entries.findIndex(e => e.id === entry.id);
      if (index >= 0) {
        const previous = draft.entries[index];
        if ((previous.advances || []).length) {
          const originalSchedule = JSON.stringify([previous.date, previous.kind, previous.recurrence, previous.payment, previous.installments]);
          const revisedSchedule = JSON.stringify([entry.date, entry.kind, entry.recurrence, entry.payment, entry.installments]);
          if (originalSchedule !== revisedSchedule) throw new Error('Existem cobranças adiantadas. Reverta-as antes de alterar data, tipo, recorrência, pagamento ou número de parcelas.');
        }
        entry.advances = previous.advances || [];
        draft.entries[index] = entry;
      } else draft.entries.push(entry);
    });
    $('entry-dialog').close(); notify(editingEntryId ? 'Lançamento atualizado e salvo.' : 'Lançamento criado e salvo.');
  } catch (error) { showFormError('form-error', errorMessage(error)); }
}

/** Modal por cobrança (não por série): referência estável = entryId + occurrenceIndex. */
function openAdvance(item) {
  if (item.entry.kind !== 'expense' || item.advanced) return;
  const originalMonth = item.originalMonth;
  const previousMonth = addMonths(originalMonth, -1);
  if (previousMonth < '1900-01') { notify('Não existe mês anterior dentro do período permitido.', 'error'); return; }
  advanceSelection = { entryId: item.entryId, occurrenceIndex: item.occurrenceIndex, originalMonth };
  const origin = sourceOf(item.entry.sourceId);
  $('advance-description').textContent = `${item.entry.description || origin?.name || 'Despesa'}${item.part ? ` · Parcela ${item.part}` : ''} · ${money(item.amountCents)} · previsão original em ${monthBR(originalMonth)}.`;
  $('advance-to').max = previousMonth;
  $('advance-to').value = selectedMonth < originalMonth && selectedMonth >= '1900-01' ? selectedMonth : previousMonth;
  $('advance-error').hidden = true;
  updateAdvancePreview();
  $('advance-dialog').showModal();
}
function updateAdvancePreview() {
  if (!advanceSelection) return;
  const { entryId, occurrenceIndex, originalMonth } = advanceSelection;
  const target = $('advance-to').value;
  try {
    const entry = state.entries.find(e => e.id === entryId);
    if (!entry) throw new Error('Lançamento não encontrado.');
    const changed = advanceOccurrence(entry, occurrenceIndex, target);
    const hypothetical = { ...state, entries: state.entries.map(e => e.id === entryId ? changed : e) };
    const originalBefore = monthSummary(state, originalMonth).expense;
    const originalAfter = monthSummary(hypothetical, originalMonth).expense;
    const targetBefore = monthSummary(state, target).expense;
    const targetAfter = monthSummary(hypothetical, target).expense;
    $('advance-preview').textContent = `${monthBR(originalMonth)}: ${money(originalBefore)} → ${money(originalAfter)} em despesas. ${monthBR(target)}: ${money(targetBefore)} → ${money(targetAfter)} em despesas.`;
    $('advance-error').hidden = true;
  } catch (error) {
    $('advance-preview').textContent = 'Escolha um mês válido anterior ao vencimento original.';
    showFormError('advance-error', errorMessage(error));
  }
}
function submitAdvance(event) {
  event.preventDefault();
  if (!advanceSelection) return;
  const { entryId, occurrenceIndex, originalMonth } = advanceSelection;
  const target = $('advance-to').value;
  try {
    const entry = state.entries.find(e => e.id === entryId);
    if (!entry) throw new Error('Lançamento não encontrado.');
    advanceOccurrence(entry, occurrenceIndex, target);
    $('advance-dialog').close();
    confirmDialog({
      title: 'Confirmar adiantamento?',
      message: `A cobrança será transferida de ${monthBR(originalMonth)} para ${monthBR(target)}. Apenas esta ocorrência será alterada; a soma total da despesa permanece igual.`,
      confirmLabel: 'Confirmar adiantamento',
      onConfirm: () => commit(draft => {
        const index = draft.entries.findIndex(e => e.id === entryId);
        if (index < 0) throw new Error('Lançamento não encontrado.');
        draft.entries[index] = advanceOccurrence(draft.entries[index], occurrenceIndex, target);
      })
    });
  } catch (error) { showFormError('advance-error', errorMessage(error)); }
}
function confirmReverseAdvance(item) {
  confirmDialog({
    title: 'Reverter adiantamento?',
    message: `A cobrança de ${money(item.amountCents)} voltará de ${monthBR(item.month)} para ${monthBR(item.originalMonth)}. As demais cobranças continuam inalteradas.`,
    confirmLabel: 'Reverter adiantamento',
    onConfirm: () => commit(draft => {
      const index = draft.entries.findIndex(e => e.id === item.entryId);
      if (index < 0) throw new Error('Lançamento não encontrado.');
      draft.entries[index] = reverseAdvance(draft.entries[index], item.occurrenceIndex);
    })
  });
}

/** Simulador: apenas leituras do estado e cálculos puros, sem gravação local/remota. */
function updateSimulationFields() {
  const fixed = $('sim-recurrence').value === 'fixed';
  const credit = $('sim-payment').value === 'credit';
  $('sim-term-wrap').hidden = !fixed;
  $('sim-months-wrap').hidden = !fixed || $('sim-term').value !== 'limited';
  $('sim-installments-wrap').hidden = fixed || !credit;
  $('sim-value-mode-wrap').hidden = fixed || !credit;
  renderSimulation();
}
function setSimulationMode(mode) {
  if (!['new', 'advance'].includes(mode)) return;
  simulationMode = mode;
  for (const button of document.querySelectorAll('[data-sim-mode]')) {
    const active = button.dataset.simMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  $('simulation-form').hidden = mode !== 'new';
  $('sim-advance-area').hidden = mode !== 'advance';
  $('sim-config-title').textContent = mode === 'new' ? 'Despesa hipotética' : 'Adiantar despesas existentes';
  $('sim-config-description').textContent = mode === 'new'
    ? 'Sem descrição e sem criar lançamento' : 'Experimente diferentes antecipações sem alterar os dados';
  $('simulation-result-description').textContent = mode === 'new'
    ? 'Comparativo com seus dados reais' : 'Compare os meses antes e depois dos adiantamentos';
  renderSimulation();
}
function advanceWindow() {
  const from = assertMonth($('sim-start').value);
  const months = Number($('sim-horizon').value);
  if (![1, 3, 6].includes(months)) throw new Error('Horizonte de simulação inválido.');
  const last = addMonths(from, months - 1);
  const computedLookahead = addMonths(from, 23);
  const lookahead = computedLookahead > '2100-12' ? '2100-12' : computedLookahead;
  assertMonth(last);
  return { from, last, lookahead, months };
}
function populateAdvanceEntries(window) {
  const select = $('sim-advance-entry');
  const previous = select.value;
  const expenseEntries = state.entries.filter(entry => {
    if (entry.kind !== 'expense') return false;
    const first = monthOf(entry.date);
    const length = entry.recurrence.mode === 'fixed' ? entry.recurrence.months : entry.payment === 'credit' ? entry.installments : 1;
    const last = length === null ? null : addMonths(first, length - 1);
    // Uma série com vencimento original anterior ao mês da análise já terminou.
    return first <= window.lookahead && (last === null || last > window.from);
  }).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  select.replaceChildren(new Option('Selecione uma despesa', ''));
  for (const entry of expenseEntries) {
    const origin = state.sources.find(source => source.id === entry.sourceId)?.name;
    const title = entry.description || origin || 'Despesa sem descrição';
    const schedule = entry.recurrence.mode === 'fixed' ? 'Fixa' : entry.installments > 1 ? `${entry.installments}x no cartão` : 'Pontual';
    select.add(new Option(`${title} · ${schedule} · desde ${monthBR(monthOf(entry.date))}`, entry.id));
  }
  select.value = expenseEntries.some(entry => entry.id === previous) ? previous : '';
  populateAdvanceOccurrences(window);
}
function populateAdvanceOccurrences(window) {
  const select = $('sim-advance-occurrence');
  const previous = select.value;
  const entry = state.entries.find(item => item.id === $('sim-advance-entry').value);
  select.replaceChildren(new Option('Escolha uma cobrança', ''));
  const occurrences = [];
  if (entry) {
    const inPlan = new Set(simulatedAdvances.filter(move => move.entryId === entry.id).map(move => move.occurrenceIndex));
    for (let i = 1; i <= 23; i++) {
      const month = addMonths(window.from, i);
      if (month > window.lookahead) break;
      for (const item of entryOccurrencesInMonth(entry, month)) {
        if (inPlan.has(item.occurrenceIndex)) continue;
        const label = `${monthBR(month)} · ${money(item.amountCents)}${item.part ? ` · Parcela ${item.part}` : ''}${item.advanced ? ' · já adiantada' : ''}`;
        select.add(new Option(label, String(item.occurrenceIndex)));
        occurrences.push({ index: item.occurrenceIndex, month });
      }
    }
  }
  select.value = occurrences.some(item => String(item.index) === previous) ? previous : '';
  updateAdvanceDestination(window);
}
function updateAdvanceDestination(window) {
  const target = $('sim-advance-to');
  const entry = state.entries.find(item => item.id === $('sim-advance-entry').value);
  const index = $('sim-advance-occurrence').value;
  const original = entry && index !== '' ? addMonths(monthOf(entry.date), Number(index)) : null;
  const active = original && (entry.advances || []).find(item => item.index === Number(index))?.toMonth || original;
  target.min = window.from;
  target.max = active ? (addMonths(active, -1) < window.last ? addMonths(active, -1) : window.last) : window.last;
  if (!active || target.value < target.min || target.value > target.max) target.value = active ? target.max : '';
  const help = $('sim-advance-help');
  help.textContent = active
    ? `Vencimento atual: ${monthBR(active)}. Escolha um mês anterior, dentro da projeção. Não há alteração real nem baixa de pagamento.`
    : 'Selecione uma despesa e uma cobrança futura. Você pode adicionar vários adiantamentos ao mesmo cenário.';
}
function addSimulatedAdvance(event) {
  event.preventDefault();
  try {
    const { from, months } = advanceWindow();
    const entryId = $('sim-advance-entry').value;
    const rawIndex = $('sim-advance-occurrence').value;
    if (!entryId || rawIndex === '') throw new Error('Selecione uma despesa e uma cobrança futura.');
    const step = { entryId, occurrenceIndex: Number(rawIndex), toMonth: $('sim-advance-to').value };
    const candidate = [...simulatedAdvances, step];
    // Valida cenário completo antes de aceitar em memória.
    simulateAdvances(state, candidate, from, months);
    simulatedAdvances = candidate;
    renderSimulation();
  } catch (error) {
    $('sim-advance-help').textContent = errorMessage(error);
    notify(errorMessage(error), 'error');
  }
}
function renderAdvancePlan(movements) {
  const list = $('sim-advance-plans');
  list.replaceChildren();
  $('sim-advance-clear').hidden = !simulatedAdvances.length;
  if (!simulatedAdvances.length) {
    list.append(create('p', 'sim-plan-empty', 'Nenhum adiantamento simulado ainda.'));
    return;
  }
  for (const [planIndex, step] of simulatedAdvances.entries()) {
    const entry = state.entries.find(item => item.id === step.entryId);
    const title = entry?.description || state.sources.find(origin => origin.id === entry?.sourceId)?.name || 'Despesa não encontrada';
    // Em caso de janela inválida, ainda exibimos cada escolha para poder removê-la.
    const original = entry ? addMonths(monthOf(entry.date), step.occurrenceIndex) : null;
    const active = entry && (entry.advances || []).find(item => item.index === step.occurrenceIndex)?.toMonth || original;
    const amount = entry ? (entry.payment === 'credit' && entry.recurrence.mode === 'none'
      ? splitInstallments(entry.amountCents, entry.installments)[step.occurrenceIndex] : entry.amountCents) : null;
    const move = movements[planIndex];
    const row = create('div', 'sim-plan-item');
    const content = create('div', 'sim-plan-text');
    content.append(create('strong', '', `${title}${amount ? ` · ${money(amount)}` : ''}`));
    content.append(create('span', '', `${active ? monthBR(active) : 'Sem referência'} → ${monthBR(step.toMonth)}${entry?.payment === 'credit' && entry.installments > 1 ? ` · Parcela ${step.occurrenceIndex + 1}/${entry.installments}` : ''}${move ? '' : ' · conferir cenário'}`));
    const remove = create('button', 'mini-action', 'Remover');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remover adiantamento simulado de ${title}`);
    remove.addEventListener('click', () => { simulatedAdvances.splice(planIndex, 1); renderSimulation(); });
    row.append(content, remove);
    list.append(row);
  }
}

function renderSimulation() {
  if (!state) return;
  const result = $('sim-results'), feedback = $('sim-feedback');
  result.replaceChildren();
  if (simulationMode === 'advance') {
    try {
      const window = advanceWindow();
      populateAdvanceEntries(window);
      const { projection, movements } = simulateAdvances(state, simulatedAdvances, window.from, window.months);
      renderAdvancePlan(movements);
      if (!movements.length) {
        feedback.textContent = state.entries.some(item => item.kind === 'expense')
          ? 'Escolha uma despesa, selecione uma cobrança futura e clique em “Adicionar ao cenário”. O resultado aparecerá aqui.'
          : 'Ainda não há despesas cadastradas. Cadastre uma despesa real para simular seu adiantamento.';
        feedback.hidden = false;
        return;
      }
      feedback.hidden = true;
      const sum = create('div', 'simulation-total');
      sum.append(create('span', '', `${movements.length} ${movements.length === 1 ? 'cobrança antecipada' : 'cobranças antecipadas'} (valor total)`),
        create('strong', '', money(movements.reduce((total, move) => total + move.amountCents, 0))));
      const rows = create('div', 'simulation-months');
      for (const period of projection) {
        const card = create('article', 'simulation-month-card');
        card.append(create('h3', '', monthBR(period.month)));
        const table = create('div', 'simulation-values');
        const signedChange = period.expenseChange === 0 ? money(0)
          : `${period.expenseChange > 0 ? '+' : '−'} ${money(Math.abs(period.expenseChange))}`;
        for (const [label, value, className] of [
          ['Despesas atuais', money(period.baseline.expense), ''],
          ['Impacto do adiantamento', signedChange, 'simulation-highlight'],
          ['Despesas simuladas', money(period.projected.expense), 'simulation-strong'],
          ['Saldo projetado', money(period.projected.balance), period.projected.balance < 0 ? 'simulation-negative' : 'simulation-balance']
        ]) {
          const line = create('div', `simulation-value-row ${className}`);
          line.append(create('span', '', label), create('strong', '', value));
          table.append(line);
        }
        card.append(table);
        const movedIn = period.arrived.reduce((sum, move) => sum + move.amountCents, 0);
        const movedOut = period.departed.reduce((sum, move) => sum + move.amountCents, 0);
        const changes = [];
        if (movedIn) changes.push(`Adiantado para este mês: + ${money(movedIn)}`);
        if (movedOut) changes.push(`Retirado deste mês: − ${money(movedOut)}`);
        card.append(create('p', 'simulation-detail', changes.join(' · ') || 'Sem adiantamento neste mês'));
        rows.append(card);
      }
      result.append(sum, rows);
      const outside = movements.filter(move => move.fromMonth > window.last);
      if (outside.length) result.append(create('p', 'simulation-note',
        `${outside.length} ${outside.length === 1 ? 'cobrança vinha' : 'cobranças vinham'} de fora do período visível. Amplie a visualização ou altere o mês inicial para conferir o mês de origem.`));
      result.append(create('p', 'simulation-no-save', 'Somente planejamento: nenhuma cobrança real, competência, backup ou dado sincronizado foi alterado.'));
    } catch (error) {
      // Preserva o cenário se a janela for alterada; nunca apaga escolhas silenciosamente.
      feedback.textContent = errorMessage(error);
      feedback.hidden = false;
      renderAdvancePlan([]);
    }
    return;
  }
  if (!$('sim-amount').value.trim()) {
    feedback.textContent = 'Informe um valor para visualizar a projeção.';
    feedback.hidden = false;
    return;
  }
  try {
    const date = `${$('sim-start').value}-01`;
    const fixed = $('sim-recurrence').value === 'fixed';
    const credit = $('sim-payment').value === 'credit' && !fixed;
    const installments = credit ? Number($('sim-installments').value) : 1;
    if (!Number.isInteger(installments) || installments < 1 || installments > 120) throw new Error('Escolha de 1 a 120 parcelas.');
    const given = parseMoney($('sim-amount').value);
    const amountCents = credit && $('sim-value-mode').value === 'each' ? given * installments : given;
    const recurrence = { mode: fixed ? 'fixed' : 'none', months: fixed && $('sim-term').value === 'limited' ? Number($('sim-months').value) : null };
    const months = Number($('sim-horizon').value);
    const projection = simulateExpense(state, { date, amountCents, recurrence, payment: $('sim-payment').value, installments }, months);
    feedback.hidden = true;
    const totalImpact = projection.reduce((acc, r) => acc + r.additionalExpense, 0);
    const sum = create('div', 'simulation-total');
    sum.append(create('span', '', `Acréscimo de despesas em ${months} ${months === 1 ? 'mês' : 'meses'}`), create('strong', '', money(totalImpact)));
    const rows = create('div', 'simulation-months');
    for (const period of projection) {
      const card = create('article', 'simulation-month-card');
      card.append(create('h3', '', monthBR(period.month)));
      const table = create('div', 'simulation-values');
      for (const [label, value, className] of [
        ['Despesas atuais', money(period.baseline.expense), ''],
        ['Nova despesa', `+ ${money(period.additionalExpense)}`, 'simulation-highlight'],
        ['Despesas projetadas', money(period.projected.expense), 'simulation-strong'],
        ['Saldo projetado', money(period.projected.balance), period.projected.balance < 0 ? 'simulation-negative' : 'simulation-balance']
      ]) {
        const line = create('div', `simulation-value-row ${className}`);
        line.append(create('span', '', label), create('strong', '', value));
        table.append(line);
      }
      card.append(table);
      const detail = create('p', 'simulation-detail', period.simulatedItems.length
        ? period.simulatedItems.map(item => item.part ? `Parcela ${item.part}` : fixed ? 'Conta fixa mensal' : 'Pagamento único').join(' · ')
        : 'Nenhuma cobrança hipotética neste mês');
      card.append(detail);
      rows.append(card);
    }
    result.append(sum, rows, create('p', 'simulation-no-save', 'Esta é apenas uma comparação. Nenhum lançamento foi criado ou salvo.'));
  } catch (error) {
    feedback.textContent = errorMessage(error);
    feedback.hidden = false;
  }
}

function openSource(source = null) {
  editingSourceId = source?.id || null;
  $('source-form').reset();
  $('source-error').hidden = true;
  $('source-dialog-title').textContent = source ? 'Editar origem' : 'Nova origem';
  $('source-kind').value = source?.kind || 'expense';
  $('source-kind').disabled = Boolean(source);
  $('source-name').value = source?.name || '';
  $('source-dialog').showModal();
  $('source-name').focus();
}
async function submitSource(event) {
  event.preventDefault();
  $('source-error').hidden = true;
  const source = { id: editingSourceId || makeId(), name: $('source-name').value.trim(), kind: $('source-kind').value };
  try {
    if (!editingSourceId && state.sources.length >= MAX_SOURCES) throw new Error('Número máximo de origens atingido.');
    await commit(draft => {
      const index = draft.sources.findIndex(s => s.id === source.id);
      if (index >= 0) draft.sources[index] = source;
      else draft.sources.push(source);
    });
    $('source-dialog').close(); notify(editingSourceId ? 'Origem atualizada.' : 'Origem criada.');
  } catch (error) { showFormError('source-error', errorMessage(error)); }
}

function confirmDialog({ title, message, confirmLabel = 'Confirmar', onConfirm }) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-yes').textContent = confirmLabel;
  $('confirm-yes').disabled = false;
  $('confirm-yes').onclick = async () => {
    $('confirm-yes').disabled = true;
    try { await onConfirm(); dialog.close(); notify('Operação concluída e salva.'); }
    catch (error) { notify(errorMessage(error), 'error'); }
    finally { $('confirm-yes').disabled = false; }
  };
  dialog.showModal();
}

function downloadBackup() {
  try {
    const snapshot = exportSnapshot(state);
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = create('a'); a.href = url; a.download = `clara-backup-${localToday()}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    notify('Backup JSON gerado. Guarde o arquivo em local seguro.');
  } catch (error) { notify(errorMessage(error), 'error'); }
}
async function importBackup(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 10_000_000) throw new Error('O arquivo ultrapassa 10 MB.');
    const imported = parseImport(await file.text());
    confirmDialog({
      title: 'Substituir todos os dados?',
      message: `O backup possui ${imported.entries.length} lançamentos e ${imported.sources.length} origens. Seus dados atuais (${state.entries.length} lançamentos e ${state.sources.length} origens) serão substituídos. Faça uma exportação antes de continuar, se necessário.`,
      confirmLabel: 'Substituir dados',
      onConfirm: () => commit(() => imported)
    });
  } catch (error) { notify(`Importação cancelada: ${errorMessage(error)}`, 'error'); }
}

async function updatePersistence() {
  const status = $('storage-status'), button = $('request-persistence');
  if (!navigator.storage?.persisted) { status.textContent = 'O navegador não informa o nível de proteção do armazenamento.'; button.disabled = true; return; }
  try {
    const isPersisted = await navigator.storage.persisted();
    status.textContent = isPersisted ? 'Armazenamento persistente autorizado pelo navegador.' : 'Armazenamento local ativo; o navegador pode limpar dados em condições de pouco espaço.';
    button.disabled = isPersisted || !navigator.storage.persist;
    button.textContent = isPersisted ? 'Proteção ativada' : 'Solicitar proteção contra limpeza automática';
  } catch { status.textContent = 'Não foi possível verificar a proteção do navegador.'; }
}

function connectEvents() {
  document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => setView(button.dataset.nav)));
  $('top-new').addEventListener('click', () => openEntry());
  document.querySelectorAll('[data-add-entry]').forEach(btn => btn.addEventListener('click', () => openEntry()));
  $('view-all').addEventListener('click', () => setView('transactions'));
  $('dashboard-simulate').addEventListener('click', () => setView('simulation'));
  $('previous-month').addEventListener('click', () => switchMonth(-1));
  $('next-month').addEventListener('click', () => switchMonth(1));
  for (const id of ['filter-search', 'filter-kind', 'filter-source', 'filter-payment', 'filter-from', 'filter-to']) {
    $(id).addEventListener(id === 'filter-search' ? 'input' : 'change', renderTransactions);
  }
  $('filter-reset').addEventListener('click', resetFilters);
  $('entry-form').addEventListener('submit', submitEntry);
  $('advance-form').addEventListener('submit', submitAdvance);
  $('advance-to').addEventListener('input', updateAdvancePreview);
  $('simulation-form').addEventListener('submit', event => { event.preventDefault(); renderSimulation(); });
  document.querySelectorAll('[data-sim-mode]').forEach(button => button.addEventListener('click', () => setSimulationMode(button.dataset.simMode)));
  $('sim-advance-form').addEventListener('submit', addSimulatedAdvance);
  $('sim-advance-entry').addEventListener('change', () => { try { populateAdvanceOccurrences(advanceWindow()); } catch (error) { notify(errorMessage(error), 'error'); } });
  $('sim-advance-occurrence').addEventListener('change', () => { try { updateAdvanceDestination(advanceWindow()); } catch (error) { notify(errorMessage(error), 'error'); } });
  $('sim-advance-clear').addEventListener('click', () => { simulatedAdvances = []; renderSimulation(); });
  for (const id of ['sim-start', 'sim-amount', 'sim-recurrence', 'sim-term', 'sim-months', 'sim-payment', 'sim-installments', 'sim-value-mode', 'sim-horizon']) {
    $(id).addEventListener('input', updateSimulationFields);
    $(id).addEventListener('change', updateSimulationFields);
  }
  $('entry-kind').addEventListener('change', () => { fillSourceSelect($('entry-kind').value); updateEntryFields(); });
  for (const id of ['entry-recurrence', 'entry-payment', 'entry-term', 'entry-months', 'entry-installments', 'entry-value-mode', 'entry-amount', 'entry-date']) {
    $(id).addEventListener('input', updateEntryFields);
    $(id).addEventListener('change', updateEntryFields);
  }
  $('new-source').addEventListener('click', () => openSource());
  $('source-form').addEventListener('submit', submitSource);
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  $('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close());
  $('export-data').addEventListener('click', downloadBackup);
  $('import-data').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', importBackup);
  $('cloud-login').addEventListener('click', () => cloudAccountAction('login'));
  $('cloud-register').addEventListener('click', () => cloudAccountAction('register'));
  $('cloud-pull').addEventListener('click', () => cloudAdoption('download'));
  $('cloud-upload').addEventListener('click', () => cloudAdoption('upload'));
  $('cloud-override').addEventListener('click', () => cloudAdoption('upload'));
  $('cloud-discard').addEventListener('click', () => cloudAdoption('download'));
  $('cloud-sync-now').addEventListener('click', () => requestCloudSync().catch(error => notify(errorMessage(error), 'error')));
  $('cloud-top-status').addEventListener('click', () => setView('settings'));
  $('cloud-logout').addEventListener('click', () => confirmDialog({
    title: 'Sair da conta?',
    message: 'A conexão será encerrada, mas a cópia financeira local continuará neste aparelho e poderá ser lida por quem usar este navegador. Se o dispositivo for compartilhado, remova os dados do site nas configurações do navegador após exportar seu backup.',
    confirmLabel: 'Sair da conta',
    onConfirm: async () => {
      clearTimeout(cloudSyncTimer);
      await queue;
      try { await cloud.logout(); } catch { /* sessão local removida pelo finally */ }
      cloudVerified = false;
      cloudConflict = false;
      cloudStatusSet('desconectado');
    }
  }));
  window.addEventListener('online', () => { cloudConflict = false; if (cloud?.authenticated && !cloudVerified) beginCloudSession(); else scheduleCloudSync(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (cloud?.authenticated && !cloudVerified && navigator.onLine) beginCloudSession(); else scheduleCloudSync(); } });
  setInterval(() => { if (!document.hidden) scheduleCloudSync(); }, 35000);
  $('request-persistence').addEventListener('click', async () => {
    try { const granted = await navigator.storage.persist(); notify(granted ? 'Proteção autorizada pelo navegador.' : 'O navegador não autorizou a proteção. Continue fazendo backups.', granted ? 'success' : 'error'); }
    catch (error) { notify(errorMessage(error), 'error'); }
    updatePersistence();
  });
}
function resetFilters() {
  $('filter-search').value = '';
  $('filter-kind').value = 'all';
  $('filter-source').value = 'all';
  $('filter-payment').value = 'all';
  $('filter-from').value = selectedMonth;
  $('filter-to').value = selectedMonth;
  renderTransactions();
}
function switchMonth(offset) {
  const next = addMonths(selectedMonth, offset);
  if (next < '1900-01' || next > '2100-12') return;
  selectedMonth = next;
  // O painel mensal e o período de lançamentos acompanham a navegação.
  resetFilters(); renderDashboard();
}
async function boot() {
  try {
    db = await openStorage();
    const stored = await readState(db);
    if (stored === null) {
      state = initialState();
      revision = await saveState(db, state, 0);
    } else {
      if (!Number.isSafeInteger(stored.revision) || stored.revision < 1) throw new Error('Revisão do banco de dados incompatível.');
      state = validateState(stored.data);
      revision = stored.revision;
      syncMeta = stored.sync && typeof stored.sync === 'object' ? stored.sync : null;
      if (syncMeta && (typeof syncMeta.userId !== 'string' || !Number.isSafeInteger(syncMeta.remoteRevision) || syncMeta.remoteRevision < 1)) syncMeta = null;
      if (syncMeta?.base) { try { syncMeta.base = validateState(syncMeta.base); } catch { syncMeta = null; } }
    }
    $('sim-start').value = selectedMonth;
    connectEvents();
    updateSimulationFields();
    resetFilters();
    renderAll();
    setView('dashboard');
    $('app-shell').hidden = false;
    $('loading-screen').hidden = true;
    updatePersistence();
    if (cloud) {
      try { if (cloud.restore()) beginCloudSession(); }
      catch (error) { cloudStatusSet('erro', errorMessage(error)); }
    }
    if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
  } catch (error) {
    // Não iniciar em modo volátil: isso evitaria falsa sensação de dados salvos.
    $('loading-screen').textContent = `Não foi possível abrir seu armazenamento local: ${errorMessage(error)}. Verifique as permissões do navegador e recarregue a página. Os dados não foram alterados.`;
    $('loading-screen').classList.add('loading-error');
  }
}
boot();
