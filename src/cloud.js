/** Cliente mínimo da API oficial Supabase Auth + PostgREST (sem SDK, sem build).
 * Um único documento versionado por usuário, com atualização CAS via revision.
 * Somente a chave PUBLICÁVEL é enviada do navegador; RLS é obrigatória. */
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './cloud-config.js';
import { validateState } from './core.js';

const AUTH_STORE = 'clara-cloud-session-v1';
const TIMEOUT_MS = 12000;
export class CloudError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'CloudError'; this.status = status; }
}
export class CloudRevisionError extends CloudError {
  constructor() { super('Outro dispositivo alterou os dados antes desta gravação.', 409); this.name = 'CloudRevisionError'; }
}
export function cloudConfigured(url = SUPABASE_URL, key = SUPABASE_PUBLISHABLE_KEY) {
  try {
    const parsed = new URL(url);
    const secureUrl = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname));
    if (!secureUrl || typeof key !== 'string') return false;
    if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)) return true;
    // Chave pública legacy: recusa explicitamente um JWT service_role acidental.
    const parts = key.split('.');
    if (parts.length !== 3) return false;
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.role === 'anon';
    } catch { return false; }
  } catch { return false; }
}
const BASE = SUPABASE_URL.replace(/\/$/, '');

/** Persiste token rotativo para login entre visitas. Não é um cofre criptografado. */
export class ClaraCloud {
  constructor({ fetcher = globalThis.fetch.bind(globalThis), store = globalThis.localStorage, url = BASE, key = SUPABASE_PUBLISHABLE_KEY } = {}) {
    this.fetcher = fetcher;
    this.store = store;
    this.url = url.replace(/\/$/, '');
    this.key = key;
    this.session = null;
    this.refreshInFlight = null;
  }
  get user() { return this.session?.user || null; }
  get authenticated() { return Boolean(this.session?.access_token && this.user?.id); }
  persist(session) {
    if (!session?.access_token || !session?.refresh_token || !session?.user?.id) throw new CloudError('Resposta de autenticação incompleta.');
    this.session = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600),
      user: { id: session.user.id, email: session.user.email || '' }
    };
    try { this.store.setItem(AUTH_STORE, JSON.stringify(this.session)); }
    catch { this.session = null; throw new CloudError('Não foi possível guardar a sessão neste navegador.'); }
  }
  restore() {
    let raw;
    try { raw = this.store.getItem(AUTH_STORE); } catch { throw new CloudError('Armazenamento de sessão bloqueado pelo navegador.'); }
    if (!raw) return false;
    try {
      const session = JSON.parse(raw);
      if (!session.access_token || !session.refresh_token || !session.user?.id || !Number.isFinite(session.expires_at)) throw Error('malformed');
      this.session = session;
      return true;
    } catch { this.clear(); return false; }
  }
  clear() {
    this.session = null;
    try { this.store.removeItem(AUTH_STORE); } catch { /* salvaguarda: token em RAM apagado */ }
  }
  async request(path, { method = 'GET', body, authorized = false, headers = {}, retry = true } = {}) {
    if (!cloudConfigured(this.url, this.key)) throw new CloudError('Configure URL e chave publicável do Supabase em src/cloud-config.js.');
    if (authorized) await this.ensureFreshToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await this.fetcher(`${this.url}${path}`, {
        method, signal: controller.signal,
        headers: {
          apikey: this.key,
          ...(authorized ? { Authorization: `Bearer ${this.session.access_token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      throw new CloudError(error?.name === 'AbortError' ? 'O servidor não respondeu no tempo limite.' : 'Sem conexão com a nuvem. Os dados continuam salvos neste dispositivo.');
    } finally { clearTimeout(timeout); }
    if (response.status === 401 && authorized && retry && this.session) {
      await this.refresh();
      return this.request(path, { method, body, authorized, headers, retry: false });
    }
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const details = typeof failure.msg === 'string' ? failure.msg : typeof failure.message === 'string' ? failure.message : typeof failure.error_description === 'string' ? failure.error_description : '';
      const messages = { 401: 'Sessão inválida ou expirada. Entre novamente.', 403: 'Acesso negado. Verifique RLS e permissões no Supabase.', 404: 'Tabela ou endpoint não encontrado. Execute o SQL de configuração.', 429: 'Muitas solicitações. Aguarde antes de tentar novamente.', 500: 'O serviço está temporariamente indisponível.' };
      throw new CloudError(`${messages[response.status] || 'Falha na comunicação com a nuvem.'}${details ? ` (${details.slice(0, 170)})` : ''}`, response.status);
    }
    if (response.status === 204) return null;
    return response.json().catch(() => { throw new CloudError('O servidor retornou dados inválidos.'); });
  }
  async register(email, password) {
    const result = await this.request('/auth/v1/signup', { method: 'POST', body: { email, password } });
    if (result.access_token) this.persist(result);
    return { requiresConfirmation: !result.access_token };
  }
  async login(email, password) {
    const result = await this.request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    this.persist(result);
    await this.verifyUser();
    return this.user;
  }
  async refresh() {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!this.session?.refresh_token) throw new CloudError('Você precisa entrar novamente.');
    this.refreshInFlight = (async () => {
      try {
        const result = await this.request('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', body: { refresh_token: this.session.refresh_token }
        });
        this.persist(result);
      } catch (error) {
        if ([400, 401, 403].includes(error.status)) this.clear();
        throw error;
      }
    })();
    try { await this.refreshInFlight; } finally { this.refreshInFlight = null; }
  }
  async ensureFreshToken() {
    if (!this.authenticated) throw new CloudError('Entre na sua conta para sincronizar.');
    if (this.session.expires_at * 1000 < Date.now() + 90000) await this.refresh();
  }
  async verifyUser() {
    const profile = await this.request('/auth/v1/user', { authorized: true });
    if (profile?.id !== this.user?.id) { this.clear(); throw new CloudError('Identidade da sessão não confere. Faça login novamente.'); }
    this.session.user.email = profile.email || this.user.email;
    this.persist(this.session);
    return this.user;
  }
  async logout() {
    try {
      if (this.authenticated) await this.request('/auth/v1/logout?scope=local', { method: 'POST', authorized: true });
    } finally { this.clear(); }
  }
  path() {
    if (!this.user?.id || !/^[0-9a-f-]{36}$/i.test(this.user.id)) throw new CloudError('Usuário inválido.');
    return `/rest/v1/finance_snapshots?user_id=eq.${encodeURIComponent(this.user.id)}&select=user_id,revision,payload,updated_at`;
  }
  async getRevision() {
    // Polling leve: verifica somente o contador, sem baixar todo o histórico.
    const rows = await this.request(`/rest/v1/finance_snapshots?user_id=eq.${encodeURIComponent(this.user.id)}&select=revision`, { authorized: true });
    if (!Array.isArray(rows) || rows.length > 1) throw new CloudError('Resposta inesperada da revisão remota.');
    if (!rows.length) return null;
    if (!Number.isSafeInteger(rows[0].revision) || rows[0].revision < 1) throw new CloudError('Revisão remota inválida.');
    return rows[0].revision;
  }
  async getSnapshot() {
    const rows = await this.request(this.path(), { authorized: true, headers: { Accept: 'application/json' } });
    if (!Array.isArray(rows)) throw new CloudError('Resposta inesperada do banco remoto.');
    if (rows.length === 0) return null;
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0].revision) || rows[0].revision < 1) throw new CloudError('Revisão remota inválida.');
    return { revision: rows[0].revision, data: validateState(rows[0].payload) };
  }
  async insertSnapshot(data) {
    const rows = await this.request('/rest/v1/finance_snapshots?on_conflict=user_id&select=user_id,revision,payload', {
      method: 'POST', authorized: true,
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: { user_id: this.user.id, revision: 1, payload: validateState(data) }
    });
    if (!Array.isArray(rows)) throw new CloudError('Resposta inesperada ao inicializar a nuvem.');
    if (!rows.length) throw new CloudRevisionError();
    return 1;
  }
  async updateSnapshot(data, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new CloudError('Revisão anterior inválida.');
    const rows = await this.request(`${this.path()}&revision=eq.${expectedRevision}`, {
      method: 'PATCH', authorized: true,
      headers: { Prefer: 'return=representation' },
      body: { revision: expectedRevision + 1, payload: validateState(data) }
    });
    if (!Array.isArray(rows)) throw new CloudError('Resposta inesperada ao gravar a nuvem.');
    if (rows.length === 0) throw new CloudRevisionError();
    if (rows.length !== 1 || rows[0].revision !== expectedRevision + 1) throw new CloudError('O servidor retornou revisão inesperada.');
    return expectedRevision + 1;
  }
}
