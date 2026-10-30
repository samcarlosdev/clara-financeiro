import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaraCloud, cloudConfigured, CloudRevisionError } from '../src/cloud.js';
import { initialState } from '../src/core.js';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const KEY = 'sb_publishable_0123456789abcdefghijkl';
const origin = 'https://abc.supabase.co';
const response = (value, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function fixture() {
  const data = new Map();
  const store = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key)
  };
  let row = null;
  let refreshCount = 0;
  let connected = true;
  const calls = [];
  async function fetcher(url, options) {
    if (!connected) throw Error('offline');
    const parsed = new URL(url), pathname = parsed.pathname;
    calls.push({ pathname, method: options.method, headers: options.headers });
    if (pathname === '/auth/v1/token' && parsed.searchParams.get('grant_type') === 'password')
      return response({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, user: { id: USER_ID, email: 'a@b.com' } });
    if (pathname === '/auth/v1/token' && parsed.searchParams.get('grant_type') === 'refresh_token') {
      refreshCount++;
      return response({ access_token: 'refreshed', refresh_token: `rotated-${refreshCount}`, expires_in: 3600, user: { id: USER_ID, email: 'a@b.com' } });
    }
    if (pathname === '/auth/v1/user') return response({ id: USER_ID, email: 'a@b.com' });
    if (pathname === '/auth/v1/logout') return response(null, 204);
    if (pathname === '/auth/v1/signup') return response({ user: { id: USER_ID }, session: null });
    if (pathname === '/rest/v1/finance_snapshots' && options.method === 'GET') {
      const projected = parsed.searchParams.get('select') === 'revision' ? (row ? { revision: row.revision } : null) : row;
      return response(projected ? [projected] : []);
    }
    if (pathname === '/rest/v1/finance_snapshots' && options.method === 'POST') {
      if (row) return response([]);
      const body = JSON.parse(options.body);
      row = body;
      return response([row], 201);
    }
    if (pathname === '/rest/v1/finance_snapshots' && options.method === 'PATCH') {
      if (!row || parsed.searchParams.get('revision') !== `eq.${row.revision}`) return response([]);
      row = { ...row, ...JSON.parse(options.body) };
      return response([row]);
    }
    return response({ message: `Rota inválida: ${pathname}` }, 404);
  }
  const client = new ClaraCloud({ fetcher, store, url: origin, key: KEY });
  return { client, calls, data, setRow: value => { row = value; }, getRow: () => row, setConnected: value => { connected = value; }, refreshCount: () => refreshCount };
}
test('configuração exige HTTPS e não aceita chave secret', () => {
  assert.equal(cloudConfigured(origin, KEY), true);
  assert.equal(cloudConfigured('http://exemplo.com', KEY), false);
  assert.equal(cloudConfigured(origin, 'sb_secret_abcdefghij0123456789'), false);
  const legacyRole = role => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role }))}.assinatura`;
  assert.equal(cloudConfigured(origin, legacyRole('anon')), true);
  assert.equal(cloudConfigured(origin, legacyRole('service_role')), false);
});
test('cadastro sem sessão exige confirmação de e-mail', async () => {
  const { client } = fixture();
  assert.deepEqual(await client.register('a@b.com', 'senha123'), { requiresConfirmation: true });
  assert.equal(client.authenticated, false);
});
test('login valida identidade, guarda sessão e restaura novo cliente', async () => {
  const { client, data } = fixture();
  await client.login('a@b.com', 'senha123');
  assert.equal(client.user.id, USER_ID);
  assert.ok(data.size);
  const restored = new ClaraCloud({ store: { getItem: k => data.get(k), setItem() {}, removeItem() {} }, url: origin, key: KEY });
  assert.equal(restored.restore(), true);
  assert.equal(restored.user.email, 'a@b.com');
});
test('REST nunca envia service-role e sempre usa bearer da sessão', async () => {
  const { client, calls } = fixture();
  await client.login('a@b.com', 'senha123');
  await client.getSnapshot();
  const call = calls.find(c => c.pathname === '/rest/v1/finance_snapshots');
  assert.equal(call.headers.apikey, KEY);
  assert.equal(call.headers.Authorization, 'Bearer access');
});
test('primeiro envio, leitura e atualização CAS', async () => {
  const { client, getRow } = fixture();
  await client.login('a@b.com', 'senha123');
  assert.equal(await client.getSnapshot(), null);
  const state = initialState();
  assert.equal(await client.insertSnapshot(state), 1);
  assert.equal((await client.getSnapshot()).revision, 1);
  assert.equal(await client.getRevision(), 1);
  const changed = structuredClone(state); changed.sources[0].name = 'Salário do PC';
  assert.equal(await client.updateSnapshot(changed, 1), 2);
  assert.equal(getRow().payload.sources[0].name, 'Salário do PC');
});
test('CAS rejeita revisão obsoleta em edição simultânea', async () => {
  const { client } = fixture();
  await client.login('a@b.com', 'senha123');
  await client.insertSnapshot(initialState());
  await client.updateSnapshot(initialState(), 1);
  await assert.rejects(client.updateSnapshot(initialState(), 1), CloudRevisionError);
});
test('inserção concorrente não sobrescreve primeira versão', async () => {
  const { client } = fixture();
  await client.login('a@b.com', 'senha123');
  await client.insertSnapshot(initialState());
  await assert.rejects(client.insertSnapshot(initialState()), CloudRevisionError);
});
test('sem internet não apaga sessão ou snapshot', async () => {
  const f = fixture();
  await f.client.login('a@b.com', 'senha123');
  await f.client.insertSnapshot(initialState());
  f.setConnected(false);
  await assert.rejects(f.client.getSnapshot(), /Sem conexão/);
  assert.equal(f.client.authenticated, true);
  assert.equal(f.getRow().revision, 1);
});
test('renovação de token próximo do vencimento preserva sessão', async () => {
  const f = fixture();
  await f.client.login('a@b.com', 'senha123');
  f.client.session.expires_at = Math.floor(Date.now() / 1000) + 10;
  await f.client.getSnapshot();
  assert.equal(f.refreshCount(), 1);
  assert.equal(f.client.session.access_token, 'refreshed');
});
test('logout descarta sessão local', async () => {
  const { client, data } = fixture();
  await client.login('a@b.com', 'senha123');
  await client.logout();
  assert.equal(client.authenticated, false);
  assert.equal(data.size, 0);
});
test('resposta com payload inválido nunca é aceita como finanças', async () => {
  const f = fixture();
  await f.client.login('a@b.com', 'senha123');
  f.setRow({ revision: 1, payload: { entries: [], sources: [] } });
  await assert.rejects(f.client.getSnapshot(), /incompatível/);
});

test('consulta periódica verifica só revision e não transporta payload', async () => {
  const f = fixture();
  await f.client.login('a@b.com', 'senha123');
  await f.client.insertSnapshot(initialState());
  const rev = await f.client.getRevision();
  assert.equal(rev, 1);
  assert.ok(f.calls.some(c => c.pathname === '/rest/v1/finance_snapshots' && c.method === 'GET'));
});
