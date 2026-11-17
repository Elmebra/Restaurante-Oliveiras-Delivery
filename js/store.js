// Estado do app + todas as regras de negócio (v2.0 Delivery). Sem DOM: roda igual no navegador e no Node (testes).
// Persistência: localStorage (neste aparelho) + sincronização entre aparelhos via Google Sheets/Apps Script.

import { makeSeed, DEFAULT_CONFIG } from './seed.js';
import {
  DAYS, dateKey, dayKeyOf, rangeBounds, timeHM, dateBR,
} from './util.js';
import { itemPrice, itemLabel } from './pricing.js';

export const PAGAMENTOS = { dinheiro: 'Dinheiro', cartao: 'Cartão (maquininha)', pix: 'PIX' };
export const CATS = {
  marmitex: 'Marmitex e feijoada',
  bebidas: 'Bebidas / Doces',
};
export const STORAGE_KEY = 'oliveiras.delivery.v2';

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });

export function defaultStorage() {
  try {
    const ls = globalThis.localStorage;
    ls.setItem('__oliveiras_test', '1');
    ls.removeItem('__oliveiras_test');
    return ls;
  } catch {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); },
    };
  }
}

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createStore({ storage = defaultStorage(), now = () => Date.now() } = {}) {
  let clockFn = now;
  const clock = () => clockFn();
  const subs = new Set();
  let saveFailed = false;
  const acked = new Map(); // chave -> carimbo vindo do servidor (não precisa reenviar)
  const snap = new Map(); // chave -> JSON do último estado conhecido (sem o carimbo `u`)
  let state = load();

  function normalize(loaded) {
    const seed = makeSeed();
    const out = { ...seed, ...loaded };
    out.prices = deepMerge(seed.prices, loaded.prices || {});
    out.menu = { ...seed.menu, ...(loaded.menu || {}) };
    for (const d of DAYS) out.menu[d] = { dishes: [], acomp: [], ...(out.menu[d] || {}) };
    for (const k of ['products', 'motoboys', 'pedidos', 'ledger']) out[k] = Array.isArray(out[k]) ? out[k] : [];
    out.config = { ...DEFAULT_CONFIG, ...(loaded.config && typeof loaded.config === 'object' ? loaded.config : {}) };
    delete out.cards;
    out.seq = { day: '', m: 0, pedido: 0, ...(out.seq || {}) };
    out.uid = Number.isInteger(out.uid) ? out.uid : 0;
    out.tomb = out.tomb && typeof out.tomb === 'object' ? out.tomb : {};
    out.meta = out.meta && typeof out.meta === 'object' ? out.meta : {};
    out.sync = { rev: 0, pushedAt: 0, ...(out.sync || {}) };
    out.dev = typeof out.dev === 'string' ? out.dev : '';
    return out;
  }

  function load() {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch { /* dados corrompidos: começa do padrão */ }
    return makeSeed();
  }

  function save(source = 'local') {
    stamp(clock());
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      saveFailed = false;
    } catch {
      saveFailed = true;
    }
    subs.forEach((fn) => fn(state, source));
  }

  // IDs únicos por aparelho (dois aparelhos nunca geram o mesmo id).
  const uid = (p) => {
    if (!state.dev) state.dev = Math.random().toString(36).slice(2, 5);
    return `${p}${state.dev}${(++state.uid).toString(36)}`;
  };

  // ---------------------------------------------------------------- sincronização (registro a registro)
  const COLLS = ['pedidos', 'ledger', 'products', 'motoboys'];
  const SINGLES = () => ['prices', 'seq', 'config', ...DAYS.map((d) => `menu:${d}`)];
  const recJSON = (rec) => { const { u, ...r } = rec; return JSON.stringify(r); };
  const singleVal = (k) => (k === 'prices' ? state.prices : k === 'seq' ? state.seq : k === 'config' ? state.config : state.menu[k.slice(5)]);

  function initSnap() {
    snap.clear();
    for (const k of SINGLES()) snap.set(k, JSON.stringify(singleVal(k)));
    for (const c of COLLS) for (const r of state[c]) if (r.u !== undefined) snap.set(`${c}:${r.id}`, recJSON(r));
  }

  /** Carimba o que mudou desde o último estado conhecido e registra o que foi apagado. */
  function stamp(t) {
    const seen = new Set();
    const check = (key, rec) => {
      seen.add(key);
      const j = recJSON(rec);
      if (snap.get(key) !== j) { rec.u = t; snap.set(key, j); delete state.tomb[key]; }
    };
    for (const c of COLLS) for (const r of state[c]) check(`${c}:${r.id}`, r);
    for (const k of [...snap.keys()]) {
      if (SINGLES().includes(k)) {
        const j = JSON.stringify(singleVal(k));
        if (snap.get(k) !== j) { snap.set(k, j); state.meta[k] = t; }
      } else if (!seen.has(k)) { snap.delete(k); state.tomb[k] = t; }
    }
  }

  const localU = (k) => {
    if (SINGLES().includes(k)) return state.meta[k] || 0;
    const [c, id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    const rec = COLLS.includes(c) ? state[c].find((r) => r.id === id) : null;
    return rec ? rec.u || 0 : state.tomb[k] || 0;
  };

  /** Alterações locais ainda não enviadas. Na 1ª sincronização, envia tudo. */
  function syncCollect() {
    stamp(clock());
    const pa = state.sync.pushedAt;
    const first = pa === 0;
    const changes = [];
    let maxU = 0;
    const add = (k, u, del, v) => { if (acked.get(k) === u) return; changes.push({ k, u, del, v }); maxU = Math.max(maxU, u); };
    for (const c of COLLS) for (const r of state[c]) if (first || r.u > pa) add(`${c}:${r.id}`, r.u, false, r);
    for (const k of SINGLES()) { const u = state.meta[k] || 0; if (first || u > pa) add(k, u, false, singleVal(k)); }
    for (const [k, u] of Object.entries(state.tomb)) if (first || u > pa) add(k, u, true, null);
    return { changes, maxU: Math.max(maxU, 1) };
  }

  function syncPending() {
    stamp(clock());
    const pa = state.sync.pushedAt;
    let n = 0;
    const cnt = (k, u) => { if (u > pa && acked.get(k) !== u) n += 1; };
    for (const c of COLLS) for (const r of state[c]) cnt(`${c}:${r.id}`, r.u);
    for (const k of SINGLES()) cnt(k, state.meta[k] || 0);
    for (const [k, u] of Object.entries(state.tomb)) cnt(k, u);
    return n;
  }

  /** Aplica o que veio do servidor (mais novo vence) e guarda até onde já sincronizou. */
  function syncApply(changes, rev, pushedAt) {
    stamp(clock());
    let applied = 0;
    for (const ch of changes) {
      const { k, u, del, v } = ch;
      const coll = k.slice(0, k.indexOf(':'));
      // ignora o que esta versão não conhece (ex.: dados antigos de comandas do salão)
      if (!SINGLES().includes(k) && !COLLS.includes(coll)) continue;
      if (localU(k) >= u) continue;
      applied += 1;
      acked.set(k, u);
      if (SINGLES().includes(k)) {
        if (k === 'prices') state.prices = v;
        else if (k === 'seq') {
          const me = state.seq;
          state.seq = me.day === v.day ? { day: v.day, m: Math.max(me.m, v.m), pedido: Math.max(me.pedido, v.pedido) } : (v.day > me.day ? v : me);
        } else if (k === 'config') state.config = { ...DEFAULT_CONFIG, ...v };
        else state.menu[k.slice(5)] = v;
        state.meta[k] = u;
        snap.set(k, JSON.stringify(singleVal(k)));
        continue;
      }
      const c = k.slice(0, k.indexOf(':'));
      const id = k.slice(k.indexOf(':') + 1);
      const arr = state[c];
      const i = arr.findIndex((r) => r.id === id);
      if (del) { if (i >= 0) arr.splice(i, 1); } else if (i >= 0) arr[i] = { ...v, u }; else arr.push({ ...v, u });
      if (del) { state.tomb[k] = u; snap.delete(k); } else { delete state.tomb[k]; snap.set(k, recJSON({ ...v })); }
    }
    state.sync.rev = Math.max(state.sync.rev, rev || 0);
    if (pushedAt) state.sync.pushedAt = Math.max(state.sync.pushedAt, pushedAt);
    save('remote');
    return applied;
  }

  function rollDay() {
    const k = dateKey(clock());
    if (state.seq.day !== k) state.seq = { day: k, m: 0, pedido: 0 };
  }

  function ledgerAdd(cat, desc, amount, pagamento, ref) {
    if (!(amount > 0)) return;
    state.ledger.push({ id: uid('l'), ts: clock(), cat, desc, amount, pagamento, ref: ref || null });
  }

  const product = (id) => state.products.find((p) => p.id === id);
  const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);

  // ---------------------------------------------------------------- preços
  function setPrice(path, cents) {
    if (!Number.isInteger(cents) || cents < 0) return fail('Valor inválido');
    const keys = path.split('.');
    let obj = state.prices;
    for (const k of keys.slice(0, -1)) {
      obj = obj?.[k];
      if (!obj || typeof obj !== 'object') return fail('Preço não encontrado');
    }
    const last = keys[keys.length - 1];
    if (!(last in obj)) return fail('Preço não encontrado');
    obj[last] = cents;
    save();
    return ok();
  }

  // ---------------------------------------------------------------- loja (nome, WhatsApp, Pix, aberto/fechado)
  const CONFIG_TEXT = ['nome', 'pixChave', 'pixNome', 'pixCidade', 'aviso'];
  function setConfig(patch) {
    const next = { ...state.config };
    for (const k of CONFIG_TEXT) if (k in patch) next[k] = String(patch[k] ?? '').trim().slice(0, 140);
    if ('whatsapp' in patch) {
      const d = String(patch.whatsapp ?? '').replace(/\D/g, '');
      if (d && (d.length < 10 || d.length > 13)) return fail('WhatsApp inválido: use DDD + número (ex.: 11 99999-0000)');
      next.whatsapp = d;
    }
    if ('aberto' in patch) next.aberto = !!patch.aberto;
    for (const k of ['inicio', 'validade']) if (k in patch) next[k] = Number.isFinite(patch[k]) && patch[k] > 0 ? Math.round(patch[k]) : 0;
    if (!next.nome) return fail('Digite o nome do restaurante');
    if (JSON.stringify(next) === JSON.stringify(state.config)) return ok({ same: true });
    state.config = next;
    save();
    return ok();
  }

  // ---------------------------------------------------------------- cardápio
  const menuDay = (day) => state.menu[day];
  const LISTS = ['dishes', 'acomp'];

  function menuAdd(day, list, name) {
    if (!menuDay(day) || !LISTS.includes(list)) return fail('Dia inválido');
    const nm = String(name || '').trim();
    if (!nm) return fail('Digite o nome');
    if (menuDay(day)[list].some((x) => x.name.toLowerCase() === nm.toLowerCase())) return fail('Esse item já está na lista');
    const entry = list === 'dishes'
      ? { id: uid('d'), name: nm, tipo: /feijoada/i.test(nm) ? 'feijoada' : 'normal' }
      : { id: uid('a'), name: nm };
    menuDay(day)[list].push(entry);
    save();
    return ok({ entry });
  }

  function menuUpdate(day, list, id, patch) {
    const entry = menuDay(day)?.[list]?.find((x) => x.id === id);
    if (!entry) return fail('Item não encontrado');
    if ('name' in patch) {
      const nm = String(patch.name || '').trim();
      if (!nm) return fail('O nome não pode ficar vazio');
      entry.name = nm;
    }
    if ('tipo' in patch && list === 'dishes') entry.tipo = patch.tipo === 'feijoada' ? 'feijoada' : 'normal';
    save();
    return ok();
  }

  function menuRemove(day, list, id) {
    const arr = menuDay(day)?.[list];
    if (!arr) return fail('Dia inválido');
    const i = arr.findIndex((x) => x.id === id);
    if (i < 0) return fail('Item não encontrado');
    arr.splice(i, 1);
    save();
    return ok();
  }

  function menuMove(day, list, id, dir) {
    const arr = menuDay(day)?.[list];
    if (!arr) return fail('Dia inválido');
    const i = arr.findIndex((x) => x.id === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= arr.length) return fail('Não dá para mover');
    [arr[i], arr[j]] = [arr[j], arr[i]];
    save();
    return ok();
  }

  function menuCopy(from, to) {
    if (!menuDay(from) || !menuDay(to) || from === to) return fail('Escolha outro dia');
    state.menu[to] = {
      dishes: menuDay(from).dishes.map((d) => ({ ...d, id: uid('d') })),
      acomp: menuDay(from).acomp.map((a) => ({ ...a, id: uid('a') })),
    };
    save();
    return ok();
  }

  // ---------------------------------------------------------------- produtos (venda rápida)
  function addProduct({ name, price, cat = 'bottle', grupo = 'bebida' }) {
    const nm = String(name || '').trim();
    if (!nm) return fail('Digite o nome do produto');
    if (!Number.isInteger(price) || price < 0) return fail('Preço inválido');
    const p = { id: uid('p'), name: nm, price, cat, grupo: grupo === 'doce' ? 'doce' : 'bebida' };
    state.products.push(p);
    save();
    return ok({ product: p });
  }

  function updateProduct(id, patch) {
    const p = product(id);
    if (!p) return fail('Produto não encontrado');
    if ('name' in patch) {
      const nm = String(patch.name || '').trim();
      if (!nm) return fail('O nome não pode ficar vazio');
      p.name = nm;
    }
    if ('price' in patch) {
      if (!Number.isInteger(patch.price) || patch.price < 0) return fail('Preço inválido');
      p.price = patch.price;
    }
    if ('cat' in patch) p.cat = patch.cat;
    if ('grupo' in patch) p.grupo = patch.grupo === 'doce' ? 'doce' : 'bebida';
    save();
    return ok();
  }

  function removeProduct(id) {
    const i = state.products.findIndex((p) => p.id === id);
    if (i < 0) return fail('Produto não encontrado');
    state.products.splice(i, 1);
    save();
    return ok();
  }

  // ---------------------------------------------------------------- motoboys
  function addMotoboy(name) {
    const nm = String(name || '').trim();
    if (!nm) return fail('Digite o nome do motoboy');
    const same = state.motoboys.find((m) => m.name.toLowerCase() === nm.toLowerCase());
    if (same && same.active) return fail('Esse motoboy já está na lista');
    if (same) {
      same.active = true;
      save();
      return ok({ motoboy: same });
    }
    const m = { id: uid('m'), name: nm, active: true };
    state.motoboys.push(m);
    save();
    return ok({ motoboy: m });
  }

  function removeMotoboy(id) {
    const m = state.motoboys.find((x) => x.id === id);
    if (!m) return fail('Motoboy não encontrado');
    m.active = false; // fica no histórico das entregas já feitas
    save();
    return ok();
  }

  // ---------------------------------------------------------------- itens avulsos (bebidas/doces)
  function resolveItems(items) {
    const out = [];
    for (const it of items || []) {
      const qty = Number(it.qty);
      if (!(qty > 0)) continue;
      const p = product(it.productId);
      if (!p) return fail('Produto não encontrado');
      out.push({ productId: p.id, name: p.name, grupo: p.grupo, qty, unit: p.price, amount: p.price * qty });
    }
    if (!out.length) return fail('Escolha pelo menos um item');
    return ok({ lines: out });
  }

  // ---------------------------------------------------------------- pedidos (marmitex e feijoada, entrega/retirada)
  const pedidoTotal = (p) => p.subtotal + p.taxa;

  function createPedido(draft) {
    const src = draft.src ? String(draft.src) : '';
    if (src && state.pedidos.some((p) => p.src === src)) return fail('Pedido online já importado');
    const itens = draft.itens || [];
    if (!itens.length) return fail('Adicione pelo menos um item ao pedido');
    const cliente = String(draft.cliente || '').trim();
    if (!cliente) return fail('Informe o nome do cliente');
    if (!PAGAMENTOS[draft.pagamento]) return fail('Escolha a forma de pagamento');
    const tipo = draft.tipo === 'entrega' ? 'entrega' : 'retirada';
    const endereco = String(draft.endereco || '').trim();
    if (tipo === 'entrega' && !endereco) return fail('Informe o bairro/endereço da entrega');
    const taxa = tipo === 'entrega' ? Number(draft.taxa ?? state.prices.entrega.taxaPadrao) : 0;
    if (!Number.isInteger(taxa) || taxa < 0) return fail('Taxa de entrega inválida');

    let bebidas = [];
    if ((draft.bebidas || []).some((b) => Number(b.qty) > 0)) {
      const r = resolveItems(draft.bebidas);
      if (!r.ok) return r;
      bebidas = r.lines.map(({ productId, name, qty, unit, amount }) => ({ productId, name, qty, unit, amount }));
    }

    if (itens.some((it) => it.kind !== 'marmitex' && it.kind !== 'feijoada')) return fail('Item inválido');
    rollDay();
    const built = [];
    try {
      for (const it of itens) {
        const price = itemPrice(state.prices, it);
        built.push({ ...it, price });
      }
    } catch (e) {
      return fail(e.message);
    }

    const pedido = {
      id: uid('o'),
      num: ++state.seq.pedido,
      ts: clock(),
      tipo,
      cliente,
      telefone: String(draft.telefone || '').trim(),
      endereco,
      taxa,
      pagamento: draft.pagamento,
      pixOk: false,
      origem: draft.origem === 'online' ? 'online' : 'balcao',
      src,
      ref: String(draft.ref || '').trim(),
      trocoPara: Number.isInteger(draft.trocoPara) && draft.trocoPara > 0 ? draft.trocoPara : 0,
      obs: String(draft.obs || '').trim(),
      itens: built.map((it) => ({
        id: uid('t'),
        mid: `M-${String(++state.seq.m).padStart(3, '0')}`,
        kind: it.kind,
        size: it.size || null,
        modo: it.modo || null,
        tipo: it.tipo || null,
        dish: it.dish || '',
        label: itemLabel(it),
        acomp: [...(it.acomp || [])],
        price: it.price,
        status: 'preparo',
      })),
      bebidas,
      subtotal: 0,
      status: 'aguardando',
      motoboyId: null,
      motoboyNome: '',
      pagoMotoboy: 0,
      saiuAt: null,
      entregueAt: null,
    };
    pedido.subtotal = sum(pedido.itens, (i) => i.price) + sum(bebidas, (b) => b.amount);

    const ref = pedido.id;
    const tag = `Pedido #${pedido.num} · ${cliente}`;
    ledgerAdd('marmitex', tag, sum(pedido.itens, (i) => i.price), pedido.pagamento, ref);
    ledgerAdd('bebidas', `${tag} · bebidas`, sum(bebidas, (b) => b.amount), pedido.pagamento, ref);
    ledgerAdd('taxa', `${tag} · taxa de entrega`, taxa, pedido.pagamento, ref);

    state.pedidos.push(pedido);
    save();
    return ok({ pedido });
  }

  const findPedido = (id) => state.pedidos.find((p) => p.id === id);
  const pedidoReady = (p) => p.itens.length > 0 && p.itens.every((i) => i.status === 'pronto');
  const pixBlocked = (p) => p.pagamento === 'pix' && !p.pixOk;

  function setItemReady(pedidoId, itemId, ready) {
    const p = findPedido(pedidoId);
    const it = p?.itens.find((i) => i.id === itemId);
    if (!it) return fail('Item não encontrado');
    it.status = ready ? 'pronto' : 'preparo';
    // voltar para o preparo desfaz um despacho que ainda não foi entregue
    if (!ready && p.status === 'saiu') {
      p.status = 'aguardando';
      p.motoboyId = null; p.motoboyNome = ''; p.pagoMotoboy = 0; p.saiuAt = null;
    }
    save();
    return ok();
  }

  function setPixOk(pedidoId, value) {
    const p = findPedido(pedidoId);
    if (!p) return fail('Pedido não encontrado');
    p.pixOk = !!value;
    save();
    return ok();
  }

  function dispatch(pedidoId, motoboyId) {
    const p = findPedido(pedidoId);
    if (!p) return fail('Pedido não encontrado');
    if (p.tipo !== 'entrega') return fail('Este pedido é para retirada');
    if (p.status !== 'aguardando') return fail('Este pedido já saiu');
    if (!pedidoReady(p)) return fail('Ainda há marmitex em preparo');
    if (pixBlocked(p)) return fail('Aguardando o comprovante do PIX');
    const m = state.motoboys.find((x) => x.id === motoboyId && x.active);
    if (!m) return fail('Escolha o motoboy');
    p.status = 'saiu';
    p.motoboyId = m.id;
    p.motoboyNome = m.name;
    p.pagoMotoboy = state.prices.entrega.pagamentoMotoboy;
    p.saiuAt = clock();
    save();
    return ok();
  }

  function undoDispatch(pedidoId) {
    const p = findPedido(pedidoId);
    if (!p || p.status !== 'saiu') return fail('Pedido não está na rua');
    p.status = 'aguardando';
    p.motoboyId = null; p.motoboyNome = ''; p.pagoMotoboy = 0; p.saiuAt = null;
    save();
    return ok();
  }

  function markDelivered(pedidoId) {
    const p = findPedido(pedidoId);
    if (!p || p.status !== 'saiu') return fail('Pedido não está na rua');
    p.status = 'entregue';
    p.entregueAt = clock();
    save();
    return ok();
  }

  function undoDelivered(pedidoId) {
    const p = findPedido(pedidoId);
    if (!p || p.status !== 'entregue') return fail('Pedido não foi entregue');
    p.status = 'saiu';
    p.entregueAt = null;
    save();
    return ok();
  }

  function markPickedUp(pedidoId) {
    const p = findPedido(pedidoId);
    if (!p) return fail('Pedido não encontrado');
    if (p.tipo !== 'retirada') return fail('Este pedido é para entrega');
    if (p.status !== 'aguardando') return fail('Pedido já finalizado');
    if (!pedidoReady(p)) return fail('Ainda há marmitex em preparo');
    if (pixBlocked(p)) return fail('Aguardando o comprovante do PIX');
    p.status = 'retirado';
    p.entregueAt = clock();
    save();
    return ok();
  }

  function undoPickedUp(pedidoId) {
    const p = findPedido(pedidoId);
    if (!p || p.status !== 'retirado') return fail('Pedido não foi retirado');
    p.status = 'aguardando';
    p.entregueAt = null;
    save();
    return ok();
  }

  function cancelPedido(pedidoId) {
    const p = findPedido(pedidoId);
    if (!p) return fail('Pedido não encontrado');
    if (p.status === 'cancelado') return fail('Pedido já cancelado');
    p.status = 'cancelado';
    state.ledger = state.ledger.filter((l) => l.ref !== p.id);
    save();
    return ok();
  }

  // ---------------------------------------------------------------- consultas
  const today = () => dateKey(clock());
  const sameDay = (ts) => dateKey(ts) === today();

  /** Pedidos com algo ainda a fazer (cozinha/expedição), mais os finalizados hoje. */
  function pedidosAbertos() {
    return state.pedidos.filter((p) => p.status === 'aguardando' || p.status === 'saiu');
  }

  function filaCozinha() {
    return pedidosAbertos()
      .filter((p) => p.itens.some((i) => i.status === 'preparo'))
      .sort((a, b) => a.ts - b.ts);
  }

  function finalizadosHoje() {
    return state.pedidos
      .filter((p) => (p.status === 'entregue' || p.status === 'retirado') && sameDay(p.entregueAt || p.ts))
      .sort((a, b) => (b.entregueAt || 0) - (a.entregueAt || 0));
  }

  function summary(kind) {
    const [from, to] = rangeBounds(kind, clock());
    const inRange = (ts) => ts >= from && ts < to;
    const entries = state.ledger.filter((l) => inRange(l.ts));
    const byCat = { marmitex: 0, bebidas: 0 };
    const byPagamento = Object.fromEntries(Object.keys(PAGAMENTOS).map((k) => [k, 0]));
    let taxas = 0;
    for (const l of entries) {
      if (l.cat === 'taxa') taxas += l.amount;
      else byCat[l.cat] = (byCat[l.cat] || 0) + l.amount;
      if (byPagamento[l.pagamento] !== undefined) byPagamento[l.pagamento] += l.amount;
    }
    const total = sum(Object.values(byCat), (v) => v);

    const trips = new Map();
    for (const p of state.pedidos) {
      if (p.status !== 'entregue' || p.tipo !== 'entrega' || !inRange(p.entregueAt || 0)) continue;
      const row = trips.get(p.motoboyId) || { id: p.motoboyId, nome: p.motoboyNome, viagens: 0, valor: 0 };
      row.viagens += 1;
      row.valor += p.pagoMotoboy;
      trips.set(p.motoboyId, row);
    }
    const motoboys = [...trips.values()].sort((a, b) => b.viagens - a.viagens || a.nome.localeCompare(b.nome));
    const custoMotoboys = sum(motoboys, (m) => m.valor);
    const valid = state.pedidos.filter((p) => p.status !== 'cancelado' && inRange(p.ts));
    const nPedidos = valid.length;
    const nOnline = valid.filter((p) => p.origem === 'online').length;
    return {
      from, to, total, byCat, byPagamento, taxas, motoboys, custoMotoboys,
      viagens: sum(motoboys, (m) => m.viagens), nPedidos, nOnline,
    };
  }

  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  /** CSV (separador ;) com vírgula decimal, pronto para abrir no Excel/Planilhas brasileiro. */
  function ledgerCSV() {
    const head = ['Data', 'Hora', 'Categoria', 'Descrição', 'Valor (R$)', 'Pagamento'];
    const rows = [...state.ledger].sort((a, b) => a.ts - b.ts).map((l) => [
      dateBR(l.ts), timeHM(l.ts),
      l.cat === 'taxa' ? 'Taxa de entrega' : CATS[l.cat] || l.cat,
      l.desc, (l.amount / 100).toFixed(2).replace('.', ','), PAGAMENTOS[l.pagamento] || l.pagamento,
    ]);
    return `﻿${[head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n')}`;
  }

  // ---------------------------------------------------------------- dados
  function exportJSON() {
    return JSON.stringify({ app: 'oliveiras', exportedAt: clock(), data: state }, null, 1);
  }

  function importJSON(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return fail('Arquivo inválido'); }
    const data = parsed?.data || parsed;
    if (!data || typeof data !== 'object' || !data.prices || !data.menu || !Array.isArray(data.ledger)) {
      return fail('Este arquivo não é um backup do Oliveira\'s');
    }
    const keep = { sync: state.sync, dev: state.dev };
    state = normalize(data);
    state.sync = keep.sync; state.dev = keep.dev || state.dev;
    save();
    return ok();
  }

  /** Apaga vendas, pedidos e cartões (ex.: depois dos testes). Preços, cardápio e produtos ficam. */
  function resetOperational() {
    state.pedidos = [];
    state.ledger = [];
    state.seq = { day: '', m: 0, pedido: 0 };
    save();
    return ok();
  }

  function resetAll() {
    const keep = { sync: state.sync, dev: state.dev };
    state = makeSeed();
    state.sync = keep.sync; state.dev = keep.dev;
    save();
    return ok();
  }

  function reload() {
    state = load();
    initSnap();
    subs.forEach((fn) => fn(state, 'remote'));
  }

  initSnap();
  stamp(clock());

  return {
    get state() { return state; },
    get saveFailed() { return saveFailed; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    now: clock,
    setClock(fn) { clockFn = fn || now; },
    today,
    todayKey: () => dayKeyOf(clock()),
    // preços
    setPrice,
    // cardápio
    menuAdd, menuUpdate, menuRemove, menuMove, menuCopy,
    // produtos
    addProduct, updateProduct, removeProduct,
    // motoboys
    addMotoboy, removeMotoboy,
    // loja
    setConfig,
    // pedidos
    createPedido, setItemReady, setPixOk, dispatch, undoDispatch, markDelivered, undoDelivered,
    markPickedUp, undoPickedUp, cancelPedido, pedidoReady, pedidoTotal, pixBlocked,
    // consultas
    filaCozinha, pedidosAbertos, finalizadosHoje, summary, ledgerCSV,
    // dados
    exportJSON, importJSON, resetOperational, resetAll, reload,
    // sincronização
    syncCollect, syncApply, syncPending,
    get syncState() { return state.sync; },
  };
}
