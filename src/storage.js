/** Persistência transacional: um snapshot válido por gravação, sem estado parcial. */
const DB_NAME = 'clara-financas-db';
const STORE = 'snapshots';
const KEY = 'current';

export function openStorage() {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('IndexedDB não está disponível neste navegador.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      if (!settled) { settled = true; resolve(db); }
      else db.close();
    };
    req.onerror = () => { settled = true; reject(req.error || new Error('Não foi possível abrir o banco local.')); };
    req.onblocked = () => { if (!settled) { settled = true; reject(new Error('Banco bloqueado por outra aba. Feche as outras abas do aplicativo e recarregue.')); } };
  });
}

export function readState(db) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(STORE, 'readonly'); } catch (error) { reject(error); return; }
    const req = tx.objectStore(STORE).get(KEY);
    let result;
    req.onsuccess = () => { result = req.result ?? null; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Falha ao carregar os dados locais.'));
    tx.onabort = () => reject(tx.error || new Error('Leitura cancelada pelo navegador.'));
  });
}

export function saveState(db, state, expectedRevision, sync = undefined) {
  return new Promise((resolve, reject) => {
    let tx;
    let conflict = false;
    try {
      tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.get(KEY);
      req.onsuccess = () => {
        const currentRevision = req.result?.revision ?? 0;
        if (currentRevision !== expectedRevision) {
          // Uma segunda aba mudou os dados desde a leitura. Não sobrescrever.
          conflict = true;
          tx.abort();
          return;
        }
        store.put({ revision: expectedRevision + 1, data: state, sync: sync === undefined ? (req.result?.sync ?? null) : sync }, KEY);
      };
    } catch (error) { reject(error); return; }
    // Só confirma a gravação após o commit da transação, não após o put().
    tx.oncomplete = () => resolve(expectedRevision + 1);
    tx.onerror = () => reject(tx.error || new Error('Falha ao salvar os dados locais.'));
    tx.onabort = () => reject(conflict ? new Error('Os dados foram modificados em outra aba. Recarregue esta página antes de editar novamente.') : (tx.error || new Error('Gravação interrompida ou armazenamento cheio.')));
  });
}
