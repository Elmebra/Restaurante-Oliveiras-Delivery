// Página de pedido do cliente (sem login). Cardápio e preços vêm do restaurante pela internet;
// os dados de entrega ficam salvos só no celular do cliente para o próximo pedido ser rápido.
import { money, esc, parseMoney, DAY_NAMES } from '../js/util.js';
import { SIZES, MODOS } from '../js/pricing.js';
import { pixPayload } from '../js/pix.js';
import config from './config.js';

const LS_CLIENTE = 'oliveiras2.cliente';
const LS_ULTIMO = 'oliveiras2.ultimo';
const LS_SALVAR = 'oliveiras2.salvar';
const LS_PEDIDO = 'oliveiras2.pedido'; // pedido em andamento (para acompanhar mesmo depois de fechar a página)
const ACOMPANHA_MS = 18 * 3600 * 1000;

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

/* ---------- armazenamento do aparelho (nunca quebra se estiver bloqueado) ---------- */
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* sem armazenamento */ } };

/* ---------- estado ---------- */
const freshCur = () => ({ dish: '', size: 'M', modo: 'individual', acomp: [] });
const saved = lsGet(LS_CLIENTE, {});
const st = {
  view: 'loading', // loading | menu | checkout | done | closed | error
  data: null,
  err: '',
  cart: [],
  bebidas: {},
  cur: freshCur(),
  sending: false,
  order: null, // pedido em andamento: { id, ref, total, pagamento, tipo, nome, ts, s, pix, at, fin, dismissed }
  trackErr: false,
  nonce: '',
  form: {
    nome: saved.nome || '', telefone: saved.telefone || '', rua: saved.rua || '', numero: saved.numero || '',
    complemento: saved.complemento || '', bairro: saved.bairro || '', referencia: saved.referencia || '',
    tipo: 'entrega', pagamento: '', troco: '', obs: '',
    salvar: lsGet(LS_SALVAR, true),
  },
};

let toastTimer;
function toast(msg, type = '') {
  $toast.textContent = msg;
  $toast.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = ''; }, 3000);
}

/* ---------- regras de preço (iguais às do servidor; o servidor é quem vale) ---------- */
const dishOf = (name) => st.data.menu.dishes.find((d) => d.name === name);
const isFei = (name) => dishOf(name)?.tipo === 'feijoada';
function itemPrice(it) {
  const p = it.kind === 'feijoada' ? st.data.prices.feijoada?.[it.modo]?.[it.size] : st.data.prices.marmitex?.[it.size];
  return Number.isInteger(p) ? p : 0;
}
const itemLabel = (it) => (it.kind === 'feijoada' ? `Feijoada ${MODOS[it.modo]} ${SIZES[it.size]}` : `Marmita ${SIZES[it.size]} — ${it.dish}`);
const bebidasList = () => Object.entries(st.bebidas).filter(([, q]) => q > 0).map(([productId, qty]) => ({ productId, qty }));
const prodOf = (id) => st.data.products.find((p) => p.id === id);
const subtotal = () => st.cart.reduce((t, it) => t + itemPrice(it), 0)
  + bebidasList().reduce((t, b) => t + (prodOf(b.productId)?.price || 0) * b.qty, 0);
const taxa = () => (st.form.tipo === 'entrega' ? st.data.prices.taxa || 0 : 0);
const total = () => subtotal() + taxa();

function buildItem() {
  const c = st.cur;
  if (isFei(c.dish)) return { kind: 'feijoada', modo: c.modo, size: c.size === 'P' ? 'M' : c.size, dish: c.dish, acomp: [] };
  return { kind: 'marmitex', size: c.size, dish: c.dish, acomp: [...c.acomp] };
}

const waNumber = () => {
  const d = String(st.data?.whatsapp || '').replace(/\D/g, '');
  if (!d) return '';
  return d.length <= 11 ? `55${d}` : d;
};

/* ---------- telas ---------- */
function header() {
  const d = st.data;
  return `<header class="top"><div class="brand">${esc(d?.nome || "Oliveira's")}</div>
    <div class="sub">${d?.dia ? `Cardápio de hoje · ${DAY_NAMES[d.dia]}` : 'Peça sua marmita'}</div></header>`;
}

function viewLoading() {
  return `${header()}<main><div class="boot">Carregando o cardápio…</div></main>`;
}

function viewClosed() {
  const wa = waNumber();
  return `${header()}<main><div class="card center"><h2>Pedidos indisponíveis</h2><p>${esc(st.data.motivo || 'Volte mais tarde.')}</p>
    ${wa ? `<a class="btn" href="https://wa.me/${wa}" target="_blank" rel="noopener">Falar pelo WhatsApp</a>` : ''}</div></main>`;
}

function viewError() {
  return `${header()}<main><div class="card center"><h2>Não consegui abrir o cardápio</h2><p>${esc(st.err)}</p>
    <button class="btn" data-a="reload">Tentar de novo</button></div></main>`;
}

const FLOW = {
  entrega: [['recebido', 'Pedido recebido'], ['preparo', 'Em preparo'], ['pronto', 'Pronto'], ['saiu', 'Saiu para entrega'], ['entregue', 'Entregue']],
  retirada: [['recebido', 'Pedido recebido'], ['preparo', 'Em preparo'], ['pronto_retirada', 'Pronto para retirar'], ['retirado', 'Retirado']],
};
const STATUS_TXT = {
  recebido: { t: 'Recebemos o seu pedido', d: 'Já estamos conferindo. Esta tela atualiza sozinha.' },
  preparo: { t: 'Sua marmita está sendo preparada', d: 'Assim que ficar pronta, avisamos aqui.' },
  pronto: { t: 'Pronto! Aguardando o motoboy', d: 'Já já ele sai com o seu pedido.' },
  pronto_retirada: { t: 'Pronto! Pode vir retirar', d: 'Seu pedido está esperando no balcão.' },
  saiu: { t: '🛵 Saiu para entrega!', d: 'Fique de olho no portão e no telefone.' },
  entregue: { t: 'Entregue. Bom apetite!', d: '' },
  retirado: { t: 'Retirado. Bom apetite!', d: '' },
  cancelado: { t: 'Pedido cancelado', d: 'Qualquer dúvida, fale com o restaurante pelo WhatsApp.' },
};
const hm = (ms) => (ms ? new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');

function viewStatus(o) {
  const code = STATUS_TXT[o.s] ? o.s : 'recebido';
  const info = STATUS_TXT[code];
  const flow = FLOW[o.tipo] || FLOW.entrega;
  const idx = flow.findIndex(([k]) => k === code);
  const steps = code === 'cancelado' ? '' : `<ol class="steps">${flow.map(([k, l], i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}"><span class="dt"></span>${esc(l)}${i === idx && o.at && (code === 'saiu' || code === 'entregue' || code === 'retirado') ? ` <small>às ${hm(o.at)}</small>` : ''}</li>`).join('')}</ol>`;
  return `<section class="card status ${code === 'saiu' ? 'hot' : ''} ${code === 'cancelado' ? 'bad' : ''}"><h2>${info.t}</h2>${info.d ? `<p class="muted">${info.d}</p>` : ''}${steps}
    ${st.trackErr && !o.fin ? '<p class="muted small">Sem conexão agora — tentando atualizar…</p>' : ''}</section>`;
}

function viewMenu() {
  const d = st.data;
  const c = st.cur;
  const fei = c.dish && isFei(c.dish);
  const sizes = fei ? ['M', 'G'] : ['P', 'M', 'G'];
  const sizePrice = (z) => (fei ? d.prices.feijoada?.[c.modo]?.[z] : d.prices.marmitex?.[z]) || 0;
  const ultimo = lsGet(LS_ULTIMO, null);
  const repetir = ultimo?.itens?.length && ultimo.itens.every((it) => dishOf(it.dish))
    ? `<button class="btn ghost block" data-a="repeat">↻ Pedir o mesmo de novo (${esc(ultimo.itens.map((i) => itemLabel(i)).join(' + ').slice(0, 60))})</button>` : '';
  const banner = st.order && !st.order.fin && st.order.dismissed
    ? `<button class="note blue block track" data-a="track">Seu pedido <b>${esc(st.order.ref)}</b>: ${esc(STATUS_TXT[st.order.s || 'recebido'].t)} — toque para acompanhar</button>` : '';
  const cartHTML = st.cart.map((it, i) => `<div class="line"><div class="grow"><b>${esc(itemLabel(it))}</b>${it.acomp.length ? `<div class="muted">+ ${esc(it.acomp.join(', '))}</div>` : ''}</div>
    <b>${money(itemPrice(it))}</b><button class="x" data-a="rm" data-i="${i}" aria-label="Remover">×</button></div>`).join('');
  const drinks = d.products.length ? `<section class="card"><h2>Bebidas e doces</h2><div class="prods">${d.products.map((p) => `<div class="prod ${st.bebidas[p.id] ? 'has' : ''}">
      <div class="pn">${esc(p.name)}</div><div class="pp">${money(p.price)}</div>
      <div class="step"><button data-a="bdec" data-id="${esc(p.id)}" aria-label="Menos">−</button><span>${st.bebidas[p.id] || 0}</span><button data-a="binc" data-id="${esc(p.id)}" aria-label="Mais">+</button></div></div>`).join('')}</div></section>` : '';
  return `${header()}<main>
    ${d.aviso ? `<div class="note">${esc(d.aviso)}</div>` : ''}
    ${banner}
    ${repetir}
    <section class="card"><h2>1 · Escolha o prato</h2>
      ${d.menu.dishes.map((x) => `<button class="dish ${c.dish === x.name ? 'on' : ''}" data-a="dish" data-v="${esc(x.name)}"><span class="dot"></span><span class="grow">${esc(x.name)}</span>${x.tipo === 'feijoada' ? '<span class="tag">feijoada</span>' : ''}</button>`).join('')}
      ${c.dish ? `<h3>Tamanho</h3><div class="seg c${sizes.length}">${sizes.map((z) => `<button class="chip ${c.size === z || (fei && c.size === 'P' && z === 'M') ? 'on' : ''}" data-a="size" data-v="${z}">${SIZES[z]}<span>${money(sizePrice(z))}</span></button>`).join('')}</div>
      ${fei ? `<h3>Feijoada</h3><div class="seg c2">${Object.entries(MODOS).map(([k, l]) => `<button class="chip ${c.modo === k ? 'on' : ''}" data-a="modo" data-v="${k}">${l}<span>${money(d.prices.feijoada?.[k]?.[c.size === 'P' ? 'M' : c.size] || 0)}</span></button>`).join('')}</div>`
        : `<h3>Acompanhamentos</h3><div class="chips">${d.menu.acomp.map((a) => `<button class="chip multi ${c.acomp.includes(a.name) ? 'on' : ''}" data-a="acomp" data-v="${esc(a.name)}">${c.acomp.includes(a.name) ? '✓ ' : ''}${esc(a.name)}</button>`).join('') || '<span class="muted">Sem acompanhamentos hoje.</span>'}</div>`}
      <button class="btn block" data-a="add">+ Adicionar ao pedido</button>` : '<p class="muted">Toque em um prato para montar sua marmita.</p>'}
    </section>
    ${st.cart.length ? `<section class="card"><h2>Seu pedido</h2>${cartHTML}</section>` : ''}
    ${drinks}
    </main>
    <footer class="bar"><div><div class="muted">${st.cart.length} marmita(s)</div><b class="tot">${money(subtotal())}</b></div>
      <button class="btn ${st.cart.length ? '' : 'off'}" data-a="checkout">Continuar</button></footer>`;
}

function field(label, key, extra = '') {
  return `<label class="field"><span class="lbl">${label}</span><input class="inp" data-f="${key}" value="${esc(st.form[key])}" ${extra}></label>`;
}

function viewCheckout() {
  const f = st.form;
  const entrega = f.tipo === 'entrega';
  const onde = entrega ? 'na entrega' : 'na retirada';
  const pix = st.data.pix.chave
    ? `<button class="chip ${f.pagamento === 'pix' ? 'on' : ''}" data-a="pag" data-v="pix">Pix<span>pague agora</span></button>` : '';
  return `${header()}<main>
    <button class="link" data-a="backmenu">← Voltar ao cardápio</button>
    <section class="card"><h2>Resumo</h2>
      ${st.cart.map((it) => `<div class="line"><div class="grow">${esc(itemLabel(it))}</div><b>${money(itemPrice(it))}</b></div>`).join('')}
      ${bebidasList().map((b) => `<div class="line"><div class="grow">${b.qty}x ${esc(prodOf(b.productId)?.name || '')}</div><b>${money((prodOf(b.productId)?.price || 0) * b.qty)}</b></div>`).join('')}
      ${entrega ? `<div class="line"><div class="grow">Taxa de entrega</div><b>${money(taxa())}</b></div>` : ''}
      <div class="line total"><div class="grow">Total</div><b>${money(total())}</b></div></section>
    <section class="card"><h2>Entrega ou retirada?</h2>
      <div class="seg c2"><button class="chip ${entrega ? 'on' : ''}" data-a="tipo" data-v="entrega">Entrega</button><button class="chip ${!entrega ? 'on' : ''}" data-a="tipo" data-v="retirada">Retirar no restaurante</button></div></section>
    <section class="card"><h2>Seus dados</h2>
      ${field('Seu nome', 'nome', 'autocomplete="name"')}
      ${field('Telefone / WhatsApp (com DDD)', 'telefone', 'inputmode="tel" autocomplete="tel"')}
      ${entrega ? `${field('Rua', 'rua', 'autocomplete="address-line1"')}
        <div class="two">${field('Número', 'numero', 'inputmode="numeric"')}${field('Complemento', 'complemento')}</div>
        ${field('Bairro', 'bairro')}${field('Ponto de referência (opcional)', 'referencia')}` : ''}
      <label class="check"><input type="checkbox" data-c="salvar" ${f.salvar ? 'checked' : ''}> Salvar meus dados neste celular para o próximo pedido</label>
      <p class="muted small">Usamos seus dados só para entregar este pedido e falar com você sobre ele. Eles ficam no restaurante e, se você marcar acima, no seu celular — sem criar conta. <button class="link inline" data-a="forget">Apagar meus dados deste celular</button></p></section>
    <section class="card"><h2>Como vai pagar?</h2>
      <div class="seg c${pix ? 3 : 2}">${pix}<button class="chip ${f.pagamento === 'dinheiro' ? 'on' : ''}" data-a="pag" data-v="dinheiro">Dinheiro<span>${onde}</span></button>
      <button class="chip ${f.pagamento === 'cartao' ? 'on' : ''}" data-a="pag" data-v="cartao">Cartão<span>${onde}</span></button></div>
      ${f.pagamento === 'pix' ? '<div class="note blue mt8">Depois de enviar o pedido você recebe o Pix copia e cola. Pague e mande o comprovante pelo WhatsApp do restaurante — o pedido só sai depois disso.</div>' : ''}
      ${f.pagamento === 'dinheiro' ? `<label class="field mt8"><span class="lbl">Precisa de troco? Troco para quanto? (opcional)</span><input class="inp" data-f="troco" inputmode="decimal" placeholder="Ex.: 50,00" value="${esc(f.troco)}"></label>` : ''}
      <label class="field mt8"><span class="lbl">Observações (opcional)</span><textarea class="inp" data-f="obs" rows="2" placeholder="Ex.: sem cebola">${esc(f.obs)}</textarea></label></section>
    </main>
    <footer class="bar"><div><div class="muted">Total</div><b class="tot">${money(total())}</b></div>
      <button class="btn ${st.sending ? 'off' : ''}" data-a="send">${st.sending ? 'Enviando…' : 'Enviar pedido'}</button></footer>`;
}

function viewDone() {
  const r = st.order;
  const d = st.data;
  const wa = waNumber();
  const pixPend = r.pagamento === 'pix' && r.pix !== false && !r.fin && r.s !== 'cancelado';
  const pix = pixPend ? pixPayload({ chave: d.pix.chave, nome: d.pix.nome, cidade: d.pix.cidade, valorCents: r.total, txid: r.ref }) : '';
  const msg = `Olá! Segue o comprovante do pedido ${r.ref} (${r.nome}) — ${money(r.total)}.`;
  return `${header()}<main>
    <section class="card center"><div class="ok">✓</div><h2>${r.fin ? 'Pedido' : 'Pedido enviado!'}</h2>
      <p>Seu código é</p><div class="code">${esc(r.ref)}</div><p class="muted">Total: <b>${money(r.total)}</b>${r.tipo === 'entrega' ? ' (com entrega)' : ' — retirada no restaurante'}</p></section>
    ${r.id ? viewStatus(r) : ''}
    ${r.pagamento === 'pix' && r.pix === false ? '<div class="note blue">✓ Pix confirmado pelo restaurante.</div>' : ''}
    ${pix ? `<section class="card"><h2>Pague com Pix</h2>
      <p class="muted">Valor exato: <b>${money(r.total)}</b>. Abra o app do seu banco, escolha <b>Pix copia e cola</b> e cole o código:</p>
      <textarea class="inp code-box" readonly rows="4" id="pixcode">${esc(pix)}</textarea>
      <button class="btn block" data-a="copypix">Copiar código Pix</button>
      <div class="note mt8">Depois de pagar, envie o <b>comprovante</b> para o WhatsApp do restaurante com o código <b>${esc(r.ref)}</b>. Seu pedido só sai depois que o comprovante chegar.</div>
      ${wa ? `<a class="btn block gold mt8" href="https://wa.me/${wa}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Enviar comprovante pelo WhatsApp</a><p class="muted small">Na conversa, toque no clipe 📎 para anexar a imagem do comprovante.</p>` : ''}</section>`
    : (r.pagamento === 'pix' ? '' : `<section class="card center"><p>Pagamento <b>${r.pagamento === 'dinheiro' ? 'em dinheiro' : 'no cartão'}</b> ${r.tipo === 'entrega' ? 'na entrega' : 'na retirada'}. Obrigado!</p></section>`)}
    ${pixPend && !pix ? '<div class="note err">O restaurante ainda não cadastrou a chave Pix. Fale com ele pelo WhatsApp.</div>' : ''}
    ${wa ? `<a class="btn ghost block" href="https://wa.me/${wa}" target="_blank" rel="noopener">Falar com o restaurante</a>` : ''}
    <button class="btn ghost block mt8" data-a="again">Fazer outro pedido</button>
    </main>`;
}

function render() {
  const y = window.scrollY;
  const html = { loading: viewLoading, menu: viewMenu, checkout: viewCheckout, done: viewDone, closed: viewClosed, error: viewError }[st.view]();
  $app.innerHTML = html;
  window.scrollTo(0, y);
}

/* ---------- acompanhamento do pedido ---------- */
function loadOrder() {
  const o = lsGet(LS_PEDIDO, null);
  if (!o || !o.ref || !o.id || Date.now() - (o.ts || 0) > ACOMPANHA_MS) { if (o) lsDel(LS_PEDIDO); return null; }
  return o;
}
function saveOrder() { if (st.order) lsSet(LS_PEDIDO, st.order); else lsDel(LS_PEDIDO); }

const FINAL = ['entregue', 'retirado', 'cancelado'];
let pollTimer = null;
let trackBusy = false;

async function refreshStatus() {
  const o = st.order;
  if (!o || !o.id || o.fin || trackBusy || !config.scriptUrl) return;
  trackBusy = true;
  try {
    const res = await fetch(`${config.scriptUrl}${config.scriptUrl.includes('?') ? '&' : '?'}action=status&id=${encodeURIComponent(o.id)}&t=${Date.now()}`, { cache: 'no-store' });
    const r = await res.json();
    if (!r.ok) throw new Error('status');
    const before = JSON.stringify([o.s, o.pix, o.at, st.trackErr]);
    st.trackErr = false;
    if (r.s !== 'desconhecido' && r.s !== 'recebido') { o.s = r.s; o.pix = r.pix; o.at = r.at || 0; }
    else if (!o.s) o.s = 'recebido';
    if (FINAL.includes(o.s)) o.fin = true;
    saveOrder();
    if (JSON.stringify([o.s, o.pix, o.at, st.trackErr]) !== before) {
      if (o.s === 'saiu') { toast('Seu pedido saiu para entrega! 🛵', 'ok'); try { navigator.vibrate?.([200, 100, 200]); } catch { /* sem vibração */ } }
      else if (o.s === 'pronto_retirada') toast('Seu pedido está pronto para retirar!', 'ok');
      if (st.view === 'done' || st.view === 'menu') render();
    }
  } catch {
    if (!st.trackErr) { st.trackErr = true; if (st.view === 'done') render(); }
  } finally {
    trackBusy = false;
    if (st.order?.fin) stopTracking();
  }
}
function stopTracking() { clearInterval(pollTimer); pollTimer = null; }
function startTracking() {
  stopTracking();
  if (!st.order || !st.order.id || st.order.fin) return;
  refreshStatus();
  pollTimer = setInterval(() => { if (!document.hidden) refreshStatus(); }, 20000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
window.addEventListener('online', refreshStatus);

/* ---------- servidor ---------- */
async function loadMenu() {
  st.view = 'loading'; render();
  if (!config.scriptUrl) { st.err = 'Este link ainda não foi ligado ao restaurante (c/config.js).'; st.view = 'error'; render(); return; }
  try {
    const res = await fetch(`${config.scriptUrl}${config.scriptUrl.includes('?') ? '&' : '?'}action=cardapio&t=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'indisponível');
    st.data = data;
    st.view = data.aberto ? 'menu' : 'closed';
    if (st.order && !st.order.fin && !st.order.dismissed) st.view = 'done'; // pedido em andamento: abre direto o acompanhamento
  } catch {
    st.err = navigator.onLine === false ? 'Você está sem internet.' : 'Verifique sua conexão e tente de novo.';
    st.view = 'error';
  }
  render();
}

function formOrder() {
  const f = st.form;
  const trocoPara = f.pagamento === 'dinheiro' && f.troco.trim() ? parseMoney(f.troco) : 0;
  return {
    nome: f.nome, telefone: f.telefone, tipo: f.tipo, pagamento: f.pagamento,
    endereco: f.tipo === 'entrega' ? { rua: f.rua, numero: f.numero, complemento: f.complemento, bairro: f.bairro, referencia: f.referencia } : null,
    trocoPara: Number.isNaN(trocoPara) ? -1 : trocoPara,
    obs: f.obs,
    itens: st.cart.map(({ kind, size, modo, dish, acomp }) => ({ kind, size, modo, dish, acomp })),
    bebidas: bebidasList(),
    nonce: st.nonce,
  };
}

function checkForm() {
  const f = st.form;
  if (f.nome.trim().length < 2) return 'Informe seu nome.';
  if (f.telefone.replace(/\D/g, '').length < 10) return 'Informe seu telefone com DDD.';
  if (f.tipo === 'entrega' && (!f.rua.trim() || !f.numero.trim() || !f.bairro.trim())) return 'Preencha rua, número e bairro.';
  if (!f.pagamento) return 'Escolha como vai pagar.';
  if (f.pagamento === 'dinheiro' && f.troco.trim()) {
    const v = parseMoney(f.troco);
    if (Number.isNaN(v) || v < total()) return `O troco deve ser para um valor maior que ${money(total())}.`;
  }
  return '';
}

async function send() {
  if (st.sending) return;
  const bad = checkForm();
  if (bad) { toast(bad, 'err'); return; }
  st.sending = true;
  st.nonce = st.nonce || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  render();
  try {
    const res = await fetch(config.scriptUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'pedido', order: formOrder() }) });
    const r = await res.json();
    if (!r.ok) { toast(r.error || 'Não foi possível enviar.', 'err'); return; }
    st.order = { id: r.id || '', ref: r.ref, total: r.total, pagamento: st.form.pagamento, tipo: st.form.tipo, nome: st.form.nome.trim(), ts: Date.now(), s: 'recebido', fin: false };
    if (r.id) saveOrder(); else lsDel(LS_PEDIDO); // servidor antigo (sem acompanhamento): não guarda
    // lembra do pedido para repetir e, se o cliente quiser, dos dados de entrega
    lsSet(LS_ULTIMO, { itens: st.cart, bebidas: st.bebidas });
    lsSet(LS_SALVAR, st.form.salvar);
    if (st.form.salvar) {
      const { nome, telefone, rua, numero, complemento, bairro, referencia } = st.form;
      lsSet(LS_CLIENTE, { nome, telefone, rua, numero, complemento, bairro, referencia });
    } else lsDel(LS_CLIENTE);
    st.nonce = '';
    st.view = 'done';
    startTracking();
  } catch {
    toast('Sem conexão. Seu pedido NÃO foi enviado — tente de novo.', 'err');
  } finally {
    st.sending = false;
    render();
    window.scrollTo(0, 0);
  }
}

/* ---------- eventos ---------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const a = el.dataset.a;
  const v = el.dataset.v;
  if (a === 'reload') { loadMenu(); return; }
  if (a === 'dish') { st.cur = { ...freshCur(), dish: st.cur.dish === v ? '' : v }; }
  else if (a === 'size') st.cur.size = v;
  else if (a === 'modo') st.cur.modo = v;
  else if (a === 'acomp') { const i = st.cur.acomp.indexOf(v); if (i >= 0) st.cur.acomp.splice(i, 1); else st.cur.acomp.push(v); }
  else if (a === 'add') {
    if (!st.cur.dish) { toast('Escolha o prato.', 'err'); return; }
    st.cart.push(buildItem());
    st.cur = freshCur();
    toast('Adicionado ao pedido', 'ok');
  } else if (a === 'rm') st.cart.splice(Number(el.dataset.i), 1);
  else if (a === 'binc') st.bebidas[el.dataset.id] = (st.bebidas[el.dataset.id] || 0) + 1;
  else if (a === 'bdec') { st.bebidas[el.dataset.id] = Math.max(0, (st.bebidas[el.dataset.id] || 0) - 1); if (!st.bebidas[el.dataset.id]) delete st.bebidas[el.dataset.id]; }
  else if (a === 'repeat') {
    const u = lsGet(LS_ULTIMO, null);
    if (u) {
      st.cart = u.itens.filter((it) => dishOf(it.dish)).map((it) => ({ ...it }));
      st.bebidas = Object.fromEntries(Object.entries(u.bebidas || {}).filter(([id]) => prodOf(id)));
      toast('Pedido anterior carregado — confira os preços.', 'ok');
    }
  } else if (a === 'checkout') {
    if (!st.cart.length) { toast('Adicione pelo menos uma marmita.', 'err'); return; }
    st.view = 'checkout'; render(); window.scrollTo(0, 0); return;
  } else if (a === 'backmenu') { st.view = 'menu'; render(); window.scrollTo(0, 0); return; }
  else if (a === 'tipo') st.form.tipo = v;
  else if (a === 'pag') st.form.pagamento = v;
  else if (a === 'forget') { lsDel(LS_CLIENTE); lsDel(LS_ULTIMO); Object.assign(st.form, { nome: '', telefone: '', rua: '', numero: '', complemento: '', bairro: '', referencia: '' }); toast('Dados apagados deste celular.', 'ok'); }
  else if (a === 'send') { send(); return; }
  else if (a === 'copypix') {
    const t = document.getElementById('pixcode');
    const done = () => toast('Código copiado! Cole no app do seu banco.', 'ok');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t.value).then(done, () => { t.select(); toast('Selecione e copie o código.', 'err'); });
    else { t.select(); document.execCommand?.('copy'); done(); }
    return;
  } else if (a === 'again') {
    st.cart = []; st.bebidas = {}; st.cur = freshCur(); st.form.pagamento = ''; st.form.troco = ''; st.form.obs = '';
    if (st.order) { if (st.order.fin || !st.order.id) st.order = null; else st.order.dismissed = true; saveOrder(); }
    st.view = 'menu'; render(); window.scrollTo(0, 0); loadMenu(); return;
  } else if (a === 'track') { st.order.dismissed = false; saveOrder(); st.view = 'done'; render(); window.scrollTo(0, 0); refreshStatus(); return; }
  render();
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-f]');
  if (el) st.form[el.dataset.f] = el.value;
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-c]');
  if (el) st.form[el.dataset.c] = el.checked;
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
st.order = loadOrder();
loadMenu().then(startTracking);
window.__pedido = { st, formOrder, total };
