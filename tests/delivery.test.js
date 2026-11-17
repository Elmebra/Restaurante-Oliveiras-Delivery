import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createStore } from '../js/store.js';
import { createSync } from '../js/sync.js';
import { createOnline, orderToDraft } from '../js/online.js';
import { crc16, pixPayload, normalizeChave, pixText } from '../js/pix.js';
import { makeKey, parseKey, licenseStatus, createLicense, TRIAL_DAYS } from '../js/license.js';
import { ticketPedido } from '../js/ticket.js';

const DAY = 86400000;
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

/* ---------- servidor falso: roda o MESMO Code.gs (validação, cardápio, mesclagem) em memória ---------- */
function fakeServer({ token = 'segredo', now = () => Date.now(), dayKey = 'qua' } = {}) {
  const ctx = vm.createContext({ console });
  vm.runInContext(`${fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8')}
    this.api = { mergeChanges_, dataFromTable_, buildCardapio_, validateOrder_, makeRef_ };`, ctx);
  const api = ctx.api;
  const table = new Map();
  const inbox = []; // { id, ref, status, order }
  let rev = 0;
  const respond = (o) => ({ json: async () => JSON.parse(JSON.stringify(o)) });
  const data = () => api.dataFromTable_(table, dayKey);

  function handle(b) {
    if (b.action === 'pedido') {
      const v = api.validateOrder_(b.order, data(), now());
      if (!v.ok) return { ok: false, error: v.error };
      const taken = Object.fromEntries(inbox.map((x) => [x.ref, true]));
      const ref = api.makeRef_(Math.random, taken);
      const order = { ...v.order, id: `id${inbox.length + 1}`, ref, ts: now() };
      inbox.push({ id: order.id, ref, status: 'novo', order });
      return { ok: true, ref, total: v.total, taxa: v.taxa };
    }
    if (b.token !== token) return { ok: false, error: 'senha' };
    if (b.action === 'inbox') return { ok: true, orders: inbox.filter((x) => x.status === 'novo').map((x) => x.order) };
    if (b.action === 'ack') { inbox.forEach((x) => { if (b.ids.includes(x.id)) x.status = 'importado'; }); return { ok: true }; }
    const r = api.mergeChanges_(table, b.changes, b.since, rev);
    rev = r.rev;
    return { ok: true, rev, changes: r.out };
  }
  return {
    table, inbox, data,
    fetchFn: async (url, init) => {
      if (!init) return respond(api.buildCardapio_(data(), now()));
      return respond(handle(JSON.parse(init.body)));
    },
    cardapio: () => api.buildCardapio_(data(), now()),
    submit: (order) => handle({ action: 'pedido', order }),
  };
}

function restaurant(srv, t0 = 1.8e12) {
  let t = t0;
  const store = createStore({ storage: memStorage(), now: () => (t += 1000) });
  const sync = createSync({ store, fetchFn: srv.fetchFn, storage: memStorage() });
  sync.setConfig('https://script.google.com/macros/s/ABC/exec', 'segredo');
  return { store, sync, tick: (ms) => { t += ms; } };
}

const pedidoCliente = (over = {}) => ({
  nome: 'Marta Souza', telefone: '(11) 98888-7777', tipo: 'entrega', pagamento: 'pix',
  endereco: { rua: 'Rua das Palmeiras', numero: '45', complemento: 'casa 2', bairro: 'Centro', referencia: 'portão azul' },
  itens: [{ kind: 'marmitex', size: 'G', dish: 'Strogonoff x', acomp: [] }],
  bebidas: [{ productId: 'refri_lata', qty: 2 }], obs: 'sem pimenta',
  ...over,
});

async function openShop(srv) {
  const dono = restaurant(srv);
  dono.store.setConfig({ pixChave: 'dono@x.com', whatsapp: '11999990000' });
  await dono.sync.syncNow();
  return dono;
}

/* ---------- Pix ---------- */
test('CRC16 do BR Code confere com o vetor padrão e com um payload conhecido', () => {
  assert.equal(crc16('123456789'), '29B1');
  const code = pixPayload({ chave: 'dono@x.com', nome: 'Restaurante Olivéira\'s', cidade: 'Mogi das Cruzes', valorCents: 4350, txid: 'WK7Q' });
  assert.ok(code.startsWith('000201010211'));
  assert.ok(code.includes('0014br.gov.bcb.pix0110dono@x.com'));
  assert.ok(code.includes('540543.50'));
  assert.ok(code.includes('5802BR'));
  assert.ok(code.includes('RESTAURANTE OLIVEIRAS'));
  assert.ok(code.includes('0504WK7Q'));
  assert.equal(code.slice(-4), crc16(code.slice(0, -4)));
  assert.equal(pixPayload({ chave: '', nome: 'a', cidade: 'b' }), '');
});

test('chave Pix: aceita como o dono digita', () => {
  assert.equal(normalizeChave('123.456.789-09'), '12345678909');
  assert.equal(normalizeChave('12.345.678/0001-95'), '12345678000195');
  assert.equal(normalizeChave('(11) 99999-0000'), '+5511999990000');
  assert.equal(normalizeChave('+55 11 99999-0000'), '+5511999990000');
  assert.equal(normalizeChave(' Dono@X.com '), 'dono@x.com');
  assert.equal(normalizeChave('123E4567-E89B-12D3-A456-426614174000'), '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(pixText('Olivéira\'s & Filhos Ltda — Mogi', 25), 'OLIVEIRAS FILHOS LTDA MOG');
});

/* ---------- Servidor (Code.gs) ---------- */
test('servidor: o cliente não consegue mudar preço, prato fora do cardápio nem pedir fechado', async () => {
  const srv = fakeServer();
  const dono = await openShop(srv);
  dono.store.menuAdd('qua', 'dishes', 'Strogonoff x'); // 'qua' = dia do servidor falso
  await dono.sync.syncNow();

  const card = srv.cardapio();
  assert.equal(card.aberto, true);
  assert.equal(card.prices.taxa, 400);
  assert.equal(card.pix.chave, 'dono@x.com');
  assert.ok(card.products.some((p) => p.id === 'refri_lata'));
  assert.equal(card.token, undefined);

  // preço vindo do navegador é ignorado: total = 22,00 + 2x6,00 + 4,00 = 38,00
  const ok = srv.submit({ ...pedidoCliente(), total: 1, preco: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.total, 2200 + 1200 + 400);
  assert.match(ok.ref, /^W[A-Z2-9]{3}$/);

  assert.match(srv.submit(pedidoCliente({ itens: [{ kind: 'marmitex', size: 'G', dish: 'Lagosta', acomp: [] }] })).error, /cardápio/);
  assert.match(srv.submit(pedidoCliente({ itens: [{ kind: 'marmitex', size: 'XG', dish: 'Strogonoff x', acomp: [] }] })).error, /tamanho|Feijoada/i);
  assert.match(srv.submit(pedidoCliente({ itens: [{ kind: 'marmitex', size: 'M', dish: 'Strogonoff x', acomp: ['Caviar'] }] })).error, /acompanhamento/);
  assert.equal(srv.submit(pedidoCliente({ itens: [] })).ok, false);
  assert.equal(srv.submit(pedidoCliente({ nome: '' })).ok, false);
  assert.equal(srv.submit(pedidoCliente({ telefone: '123' })).ok, false);
  assert.equal(srv.submit(pedidoCliente({ endereco: { rua: '', numero: '', bairro: '' } })).ok, false);
  assert.equal(srv.submit(pedidoCliente({ pagamento: 'fiado' })).ok, false);
  assert.equal(srv.submit(pedidoCliente({ bebidas: [{ productId: 'nao-existe', qty: 1 }] })).ok, false);
  assert.equal(srv.submit(pedidoCliente({ bebidas: [{ productId: 'refri_lata', qty: -3 }] })).ok, false);
  assert.match(srv.submit(pedidoCliente({ pagamento: 'dinheiro', trocoPara: 1000 })).error, /troco/);
  assert.equal(srv.submit(pedidoCliente({ pagamento: 'dinheiro', trocoPara: 5000 })).ok, true);

  // restaurante fecha a página: ninguém consegue pedir
  dono.store.setConfig({ aberto: false, aviso: 'Voltamos amanhã' });
  await dono.sync.syncNow();
  assert.equal(srv.cardapio().aberto, false);
  assert.equal(srv.cardapio().motivo, 'Voltamos amanhã');
  assert.equal(srv.submit(pedidoCliente()).ok, false);
});

test('servidor: feijoada exige tamanho M/G e usa o preço do modo escolhido', async () => {
  const srv = fakeServer();
  const dono = await openShop(srv);
  await dono.sync.syncNow();
  const mk = (over) => srv.submit(pedidoCliente({ bebidas: [], tipo: 'retirada', endereco: null, itens: [{ kind: 'feijoada', modo: 'separada', size: 'G', dish: 'Feijoada', acomp: [], ...over }] }));
  assert.equal(mk({}).total, 7000);
  assert.equal(mk({ modo: 'individual', size: 'M' }).total, 2200);
  assert.equal(mk({ size: 'P' }).ok, false);
});

test('servidor fecha sozinho quando a licença/teste do restaurante vence', async () => {
  let now = 1.8e12;
  const srv = fakeServer({ now: () => now });
  const dono = await openShop(srv);
  dono.store.setConfig({ validade: now + 2 * DAY });
  await dono.sync.syncNow();
  assert.equal(srv.cardapio().aberto, true);
  now += 3 * DAY;
  assert.equal(srv.cardapio().aberto, false);
  assert.equal(srv.submit(pedidoCliente()).ok, false);
});

test('servidor: sem cardápio no dia (ex.: domingo) não aceita pedido', async () => {
  const srv = fakeServer({ dayKey: 'dom' });
  await openShop(srv);
  assert.equal(srv.cardapio().aberto, false);
  assert.match(srv.cardapio().motivo, /cardápio/);
});

/* ---------- fluxo completo: cliente -> servidor -> cozinha -> cupom ---------- */
test('pedido do cliente vira pedido na cozinha uma única vez e o cupom sai completo', async () => {
  const srv = fakeServer();
  const dono = await openShop(srv);
  dono.store.menuAdd('qua', 'dishes', 'Strogonoff x');
  await dono.sync.syncNow();

  const feito = srv.submit(pedidoCliente());
  assert.equal(feito.ok, true);

  const novos = [];
  const online = createOnline({ store: dono.store, sync: dono.sync, storage: memStorage(), onNew: (n) => novos.push(n) });
  assert.equal((await online.poll()).skipped, true, 'desligado não busca');
  online.set(true);
  await new Promise((r) => setTimeout(r, 20));
  const p = dono.store.state.pedidos.at(-1);
  assert.equal(dono.store.state.pedidos.length, 1);
  assert.equal(p.origem, 'online');
  assert.equal(p.ref, feito.ref);
  assert.equal(p.cliente, 'Marta Souza');
  assert.equal(p.endereco, 'Rua das Palmeiras, 45 - casa 2 - Centro (ref.: portão azul)');
  assert.equal(p.pagamento, 'pix');
  assert.equal(p.pixOk, false);
  assert.equal(dono.store.pedidoTotal(p), feito.total);
  assert.deepEqual(novos, [1]);
  assert.equal(srv.inbox[0].status, 'importado');

  // buscar de novo não duplica
  assert.deepEqual(await online.poll(), { ok: true, imported: 0, failed: 0 });
  assert.equal(dono.store.state.pedidos.length, 1);

  // o Pix só libera a saída depois do comprovante
  for (const it of p.itens) dono.store.setItemReady(p.id, it.id, true);
  dono.store.addMotoboy('Zeca');
  assert.equal(dono.store.dispatch(p.id, dono.store.state.motoboys[0].id).ok, false);
  dono.store.setPixOk(p.id, true);
  assert.equal(dono.store.dispatch(p.id, dono.store.state.motoboys[0].id).ok, true);

  const cupom = ticketPedido(p);
  for (const t of [`Código: ${feito.ref}`, 'PEDIDO ONLINE', 'Marta Souza', 'portão azul', 'sem pimenta', '2x Refrigerante Lata', 'NÃO É DOCUMENTO FISCAL']) assert.ok(cupom.includes(t), t);
});

test('se o pedido falhar ao importar, ele NÃO é confirmado e fica para a próxima tentativa', async () => {
  const srv = fakeServer();
  const dono = await openShop(srv);
  dono.store.menuAdd('qua', 'dishes', 'Strogonoff x');
  await dono.sync.syncNow();
  const feito = srv.submit(pedidoCliente());
  // dono apaga o produto depois (aparelho dele ainda não conhece o pedido)
  const online = createOnline({ store: dono.store, sync: dono.sync, storage: memStorage() });
  const bad = orderToDraft({ ...srv.inbox[0].order, nome: '' });
  assert.equal(dono.store.createPedido(bad).ok, false);
  srv.inbox[0].order.nome = '';
  online.set(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(srv.inbox[0].status, 'novo');
  assert.equal(online.status.failed[0].ref, feito.ref);
});

/* ---------- licença ---------- */
test('licença: chave por data, período de teste e vencimento', () => {
  const k = makeKey('20261231', 'seg');
  assert.match(k, /^OLV-20261231-[0-9A-Z]{6}$/);
  assert.equal(parseKey(k, 'seg').ok, true);
  assert.equal(parseKey(k, 'outro-segredo').ok, false);
  assert.equal(parseKey(k.replace('20261231', '20271231'), 'seg').ok, false, 'trocar a data invalida a chave');
  assert.equal(parseKey('lixo', 'seg').ok, false);

  const first = new Date(2026, 10, 1).getTime();
  const st = (now, key = '', shared = 0) => licenseStatus({ first, key, shared, now, secret: 'seg' });
  assert.equal(st(first + 1 * DAY).state, 'trial');
  assert.equal(st(first + 1 * DAY).daysLeft, TRIAL_DAYS - 1);
  assert.equal(st(first + (TRIAL_DAYS + 1) * DAY).state, 'expired');
  assert.equal(st(first + 20 * DAY, k).state, 'active');
  assert.equal(st(new Date(2027, 0, 2).getTime(), k).state, 'expired');
  assert.equal(st(first + 30 * DAY, '', first + 60 * DAY).state, 'active'); // validade vinda da planilha
});

test('licença: ativar chave, não zerar o teste limpando o aparelho e publicar a validade para o servidor', async () => {
  const srv = fakeServer();
  let now = new Date(2026, 10, 1).getTime();
  const secret = 'seg';
  const a = restaurant(srv);
  const lic = createLicense({ store: a.store, storage: memStorage(), now: () => now, secret });
  assert.equal(lic.status().state, 'trial');
  assert.equal(a.store.state.config.inicio, now);
  assert.equal(a.store.state.config.validade, now + TRIAL_DAYS * DAY);
  await a.sync.syncNow();

  // aparelho "zerado" (cache limpo) 20 dias depois: a planilha lembra o 1º uso
  now += 20 * DAY;
  const b = restaurant(srv, 1.9e12);
  await b.sync.syncNow();
  const licB = createLicense({ store: b.store, storage: memStorage(), now: () => now, secret });
  assert.equal(licB.status().state, 'expired');

  assert.equal(licB.activate('OLV-20260101-AAAAAA').ok, false);
  assert.equal(licB.activate(makeKey('20260105', secret)).ok, false, 'chave já vencida');
  const ok = licB.activate(makeKey('20270301', secret));
  assert.equal(ok.ok, true);
  assert.equal(licB.status().state, 'active');
  assert.equal(b.store.state.config.validade, ok.until);
  // a validade nova chega ao servidor e ao outro aparelho
  await b.sync.syncNow(); await a.sync.syncNow();
  assert.equal(a.store.state.config.validade, ok.until);
  assert.equal(createLicense({ store: a.store, storage: memStorage(), now: () => now, secret }).status().state, 'active');
});
