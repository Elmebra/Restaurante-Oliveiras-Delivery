/**
 * Oliveira's Delivery v2.1 — servidor (Google Apps Script ligado a uma planilha).
 *
 * Faz quatro coisas:
 *   1) Sincroniza os aparelhos do restaurante (cozinha, expedição, painel) — com senha (TOKEN).
 *   2) Entrega o cardápio de hoje para a página de pedido dos clientes — público, só leitura.
 *   3) Informa ao cliente em que pé está o pedido dele (preparo, saiu para entrega...) — público, só pelo código secreto do pedido.
 *   4) Recebe os pedidos feitos pelos clientes — público, mas validado e limitado — e os guarda
 *      na aba "Pedidos_Online" até o aparelho da cozinha buscá-los (e imprimir).
 *
 * Abas criadas automaticamente:
 *   Dados             - base técnica da sincronização (não edite)
 *   Pedidos_Online    - caixa de entrada dos pedidos feitos pelos clientes
 *   Caixa_Vendas      - todas as vendas, legível (pode filtrar, somar, gerar gráficos)
 *   Pedidos_Marmitex  - pedidos com status e motoboy
 *
 * IMPORTANTE: o fuso da planilha precisa ser o do Brasil (Arquivo > Configurações da planilha > Fuso horário).
 */

// TROQUE por uma senha sua (a mesma será digitada no app). Não use espaços.
var TOKEN = 'PATRÃO10pix';

var HEADER = ['k', 'u', 'rev', 'del', 'v'];
var INBOX_HEADER = ['id', 'ref', 'ts', 'status', 'json', 'Cliente', 'Total (R$)'];
var DAY_BY_ISO_ = { '1': 'seg', '2': 'ter', '3': 'qua', '4': 'qui', '5': 'sex', '6': 'sab', '7': 'dom' };
var MAX_PER_PHONE_ = 4;   // pedidos por telefone a cada 10 minutos
var MAX_PER_HOUR_ = 120;  // pedidos no total por hora (proteção contra abuso)

/* ============================ lógica pura (testável fora do Google) ============================ */

/** Aplica alterações na tabela (Map chave -> linha) e devolve o que o aparelho ainda não tem. */
function mergeChanges_(table, changes, since, rev0) {
  var rev = rev0;
  var accepted = {};
  var touched = {};
  (changes || []).forEach(function (ch) {
    var row = table.get(ch.k);
    if (row && row.u >= ch.u) return; // o servidor já tem versão igual ou mais nova
    rev += 1;
    table.set(ch.k, { k: ch.k, u: ch.u, rev: rev, del: !!ch.del, v: ch.del ? '' : JSON.stringify(ch.v) });
    accepted[ch.k] = true;
    touched[ch.k.split(':')[0]] = true;
  });
  var out = [];
  table.forEach(function (row) {
    if (row.rev > since && !accepted[row.k]) {
      out.push({ k: row.k, u: row.u, del: row.del, v: row.del ? null : JSON.parse(row.v) });
    }
  });
  return { rev: rev, out: out, touched: touched };
}

function val_(table, key) {
  var row = table.get(key);
  return row && !row.del && row.v ? JSON.parse(row.v) : null;
}

function live_(table, prefix) {
  var list = [];
  table.forEach(function (row) {
    if (!row.del && row.k.indexOf(prefix + ':') === 0) list.push(JSON.parse(row.v));
  });
  return list;
}

/** Tudo que a página de pedido precisa, tirado da tabela sincronizada. */
function dataFromTable_(table, dayKey) {
  var menu = val_(table, 'menu:' + dayKey) || { dishes: [], acomp: [] };
  return {
    prices: val_(table, 'prices') || {},
    config: val_(table, 'config') || {},
    menu: { dishes: menu.dishes || [], acomp: menu.acomp || [] },
    products: live_(table, 'products'),
    dayKey: dayKey,
  };
}

/** Motivo de estar fechado ('' = aberto). */
function closedReason_(data, nowMs) {
  var c = data.config || {};
  if (!data.prices || !data.prices.marmitex) return 'O cardápio ainda não foi enviado pelo restaurante.';
  if (c.validade && nowMs > c.validade) return 'Pedidos online indisponíveis no momento.';
  if (c.aberto === false) return c.aviso || 'Estamos fechados no momento.';
  if (!data.menu.dishes.length) return c.aviso || 'Hoje não há cardápio cadastrado.';
  return '';
}

/** Resposta pública do cardápio (sem dados internos). */
function buildCardapio_(data, nowMs) {
  var c = data.config || {};
  var p = data.prices || {};
  var closed = closedReason_(data, nowMs);
  return {
    ok: true,
    aberto: closed === '',
    motivo: closed,
    aviso: c.aviso || '',
    nome: c.nome || "Oliveira's",
    whatsapp: c.whatsapp || '',
    pix: { chave: c.pixChave || '', nome: c.pixNome || c.nome || '', cidade: c.pixCidade || '' },
    dia: data.dayKey,
    prices: { marmitex: p.marmitex, feijoada: p.feijoada, taxa: p.entrega ? p.entrega.taxaPadrao : 0 },
    menu: { dishes: data.menu.dishes, acomp: data.menu.acomp },
    products: data.products
      .map(function (x) { return { id: x.id, name: x.name, price: x.price, grupo: x.grupo }; }),
  };
}

function str_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function intIn_(v, min, max) {
  var n = Number(v);
  return isFinite(n) && Math.floor(n) === n && n >= min && n <= max ? n : null;
}

/**
 * Valida o pedido do cliente. Nunca confia em preço vindo do navegador: recalcula tudo pela tabela.
 * Devolve { ok, order, total } ou { ok:false, error }.
 */
function validateOrder_(raw, data, nowMs) {
  var fail = function (e) { return { ok: false, error: e }; };
  if (!raw || typeof raw !== 'object') return fail('Pedido inválido.');
  var closed = closedReason_(data, nowMs);
  if (closed) return fail(closed);

  var nome = str_(raw.nome, 60);
  if (nome.length < 2) return fail('Informe seu nome.');
  var tel = String(raw.telefone || '').replace(/\D/g, '');
  if (tel.length < 10 || tel.length > 13) return fail('Informe seu telefone com DDD.');
  var tipo = raw.tipo === 'retirada' ? 'retirada' : (raw.tipo === 'entrega' ? 'entrega' : '');
  if (!tipo) return fail('Escolha entrega ou retirada.');
  var pagamento = raw.pagamento;
  if (pagamento !== 'pix' && pagamento !== 'dinheiro' && pagamento !== 'cartao') return fail('Escolha a forma de pagamento.');

  var endereco = '';
  if (tipo === 'entrega') {
    var e = raw.endereco || {};
    var rua = str_(e.rua, 80); var numero = str_(e.numero, 12); var bairro = str_(e.bairro, 50);
    if (!rua || !numero || !bairro) return fail('Preencha rua, número e bairro.');
    var compl = str_(e.complemento, 50); var refer = str_(e.referencia, 80);
    endereco = rua + ', ' + numero + (compl ? ' - ' + compl : '') + ' - ' + bairro + (refer ? ' (ref.: ' + refer + ')' : '');
  }

  var itensIn = raw.itens;
  if (!Array.isArray(itensIn) || itensIn.length < 1 || itensIn.length > 15) return fail('Escolha de 1 a 15 marmitas.');
  var dishes = {};
  data.menu.dishes.forEach(function (d) { dishes[d.name] = d; });
  var acomps = {};
  data.menu.acomp.forEach(function (a) { acomps[a.name] = true; });
  var prices = data.prices;
  var itens = [];
  var subtotal = 0;
  for (var i = 0; i < itensIn.length; i++) {
    var it = itensIn[i] || {};
    var dish = dishes[it.dish];
    if (!dish) return fail('Um dos pratos não está mais no cardápio de hoje. Atualize a página.');
    var size = it.size;
    var price;
    var item;
    if (dish.tipo === 'feijoada') {
      var modo = it.modo === 'separada' ? 'separada' : 'individual';
      if (size !== 'M' && size !== 'G') return fail('Feijoada só em tamanho Médio ou Grande.');
      price = prices.feijoada && prices.feijoada[modo] ? prices.feijoada[modo][size] : null;
      item = { kind: 'feijoada', modo: modo, size: size, dish: dish.name, acomp: [] };
    } else {
      if (size !== 'P' && size !== 'M' && size !== 'G') return fail('Escolha o tamanho da marmita.');
      price = prices.marmitex ? prices.marmitex[size] : null;
      item = { kind: 'marmitex', size: size, dish: dish.name, acomp: [] };
    }
    if (intIn_(price, 0, 1000000) === null) return fail('Preço indisponível. Atualize a página.');
    var ac = Array.isArray(it.acomp) ? it.acomp : [];
    if (ac.length > 10) return fail('Acompanhamentos demais.');
    for (var j = 0; j < ac.length; j++) {
      if (!acomps[ac[j]]) return fail('Um acompanhamento não está mais disponível. Atualize a página.');
      if (item.acomp.indexOf(ac[j]) < 0) item.acomp.push(ac[j]);
    }
    subtotal += price;
    itens.push(item);
  }

  var bebidas = [];
  var bIn = Array.isArray(raw.bebidas) ? raw.bebidas : [];
  if (bIn.length > 20) return fail('Itens demais.');
  var byId = {};
  data.products.forEach(function (p) { byId[p.id] = p; });
  for (var k = 0; k < bIn.length; k++) {
    var qty = intIn_(bIn[k] && bIn[k].qty, 1, 20);
    var prod = byId[bIn[k] && bIn[k].productId];
    if (qty === null || !prod) return fail('Bebida inválida. Atualize a página.');
    bebidas.push({ productId: prod.id, qty: qty });
    subtotal += prod.price * qty;
  }

  var taxa = tipo === 'entrega' ? (intIn_(prices.entrega && prices.entrega.taxaPadrao, 0, 1000000) || 0) : 0;
  var total = subtotal + taxa;

  var trocoPara = 0;
  if (pagamento === 'dinheiro' && raw.trocoPara) {
    trocoPara = intIn_(raw.trocoPara, 1, 10000000);
    if (trocoPara === null || trocoPara < total) return fail('O valor para troco deve ser maior que o total do pedido.');
  }

  return {
    ok: true,
    total: total,
    taxa: taxa,
    order: {
      nome: nome, telefone: tel, tipo: tipo, endereco: endereco, pagamento: pagamento,
      trocoPara: trocoPara, obs: str_(raw.obs, 200), itens: itens, bebidas: bebidas,
    },
  };
}

/** Em que etapa o pedido está, do ponto de vista do cliente (o Pix pendente é um aviso à parte). */
function statusCode_(p) {
  if (p.status === 'cancelado') return 'cancelado';
  if (p.status === 'entregue') return 'entregue';
  if (p.status === 'retirado') return 'retirado';
  if (p.status === 'saiu') return 'saiu';
  var itens = p.itens || [];
  var ready = itens.every(function (i) { return i.status === 'pronto'; });
  if (!ready) return 'preparo';
  return p.tipo === 'entrega' ? 'pronto' : 'pronto_retirada';
}

function pixPending_(p) {
  return p.pagamento === 'pix' && !p.pixOk && p.status !== 'cancelado' && p.status !== 'entregue' && p.status !== 'retirado';
}

/** Mapa id-do-pedido-online -> situação, só com os pedidos das últimas 36 h. */
function statusMap_(table, nowMs) {
  var out = {};
  live_(table, 'pedidos').forEach(function (p) {
    if (!p.src || String(p.src).indexOf('w-') !== 0 || p.ts < nowMs - 36 * 3600000) return;
    var done = p.status === 'entregue' || p.status === 'retirado';
    out[String(p.src).slice(2)] = {
      s: statusCode_(p),
      pix: pixPending_(p),
      at: p.status === 'saiu' ? (p.saiuAt || 0) : (done ? (p.entregueAt || 0) : 0),
    };
  });
  return out;
}

var REF_CHARS_ = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRef_(rand, taken) {
  for (var n = 0; n < 50; n++) {
    var r = 'W';
    for (var i = 0; i < 3; i++) r += REF_CHARS_.charAt(Math.floor(rand() * REF_CHARS_.length));
    if (!taken[r]) return r;
  }
  return 'W' + String(Math.floor(rand() * 1e6));
}

/* ============================ Google Apps Script ============================ */

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'cardapio') {
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var dayKey = DAY_BY_ISO_[Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'u')];
      var data = dataFromTable_(readTable_(ss), dayKey);
      return json_(buildCardapio_(data, Date.now()));
    } catch (err) {
      return json_({ ok: false, error: 'indisponível' });
    }
  }
  if (action === 'status') {
    try {
      return json_(orderStatus_(SpreadsheetApp.getActiveSpreadsheet(), String(e.parameter.id || '')));
    } catch (err) {
      return json_({ ok: false, error: 'indisponível' });
    }
  }
  return json_({ ok: true, app: 'oliveiras-delivery' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var body = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // público: cliente envia um pedido
    if (body.action === 'pedido') return json_(submitOrder_(ss, body.order));

    if (body.token !== TOKEN) return json_({ ok: false, error: 'senha' });

    // restaurante: busca / confirma pedidos online
    if (body.action === 'inbox') return json_({ ok: true, orders: readInbox_(ss) });
    if (body.action === 'ack') { ackInbox_(ss, body.ids || []); return json_({ ok: true }); }

    // restaurante: sincronização
    var sh = ss.getSheetByName('Dados') || ss.insertSheet('Dados');
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    var table = readTable_(ss);
    var props = PropertiesService.getScriptProperties();
    var rev0 = Number(props.getProperty('rev') || 0);
    var res = mergeChanges_(table, body.changes, Number(body.since || 0), rev0);
    if (res.rev !== rev0) {
      var rows = [];
      table.forEach(function (row) { rows.push([row.k, row.u, row.rev, row.del, row.v]); });
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, HEADER.length).clearContent();
      if (rows.length) sh.getRange(2, 1, rows.length, HEADER.length).setValues(rows);
      props.setProperty('rev', String(res.rev));
      if (res.touched.ledger) writeVendas_(ss, table);
      if (res.touched.pedidos) writePedidos_(ss, table);
    }
    return json_({ ok: true, rev: res.rev, changes: res.out });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function readTable_(ss) {
  var table = new Map();
  var sh = ss.getSheetByName('Dados');
  if (!sh) return table;
  var n = sh.getLastRow() - 1;
  if (n > 0) {
    sh.getRange(2, 1, n, HEADER.length).getValues().forEach(function (r) {
      if (r[0]) table.set(String(r[0]), { k: String(r[0]), u: Number(r[1]), rev: Number(r[2]), del: r[3] === true || r[3] === 'TRUE', v: String(r[4] || '') });
    });
  }
  return table;
}

function inboxSheet_(ss) {
  var sh = ss.getSheetByName('Pedidos_Online');
  if (!sh) {
    sh = ss.insertSheet('Pedidos_Online');
    sh.getRange(1, 1, 1, INBOX_HEADER.length).setValues([INBOX_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function submitOrder_(ss, raw) {
  var cache = CacheService.getScriptCache();
  // se o celular do cliente reenviar o mesmo pedido (internet ruim), devolve a resposta anterior em vez de duplicar
  var nonce = raw && raw.nonce ? String(raw.nonce).replace(/[^A-Za-z0-9]/g, '').slice(0, 40) : '';
  if (nonce) {
    var prev = cache.get('n' + nonce);
    if (prev) return JSON.parse(prev);
  }
  var tel = String((raw && raw.telefone) || '').replace(/\D/g, '');
  var hourKey = 'h' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
  var perHour = Number(cache.get(hourKey) || 0);
  if (perHour >= MAX_PER_HOUR_) return { ok: false, error: 'Muitos pedidos agora. Chame o restaurante pelo WhatsApp.' };
  var phoneKey = 't' + tel;
  var perPhone = Number(cache.get(phoneKey) || 0);
  if (tel && perPhone >= MAX_PER_PHONE_) return { ok: false, error: 'Você já enviou vários pedidos há pouco. Aguarde alguns minutos ou chame no WhatsApp.' };

  var dayKey = DAY_BY_ISO_[Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'u')];
  var data = dataFromTable_(readTable_(ss), dayKey);
  var v = validateOrder_(raw, data, Date.now());
  if (!v.ok) return { ok: false, error: v.error };

  var sh = inboxSheet_(ss);
  var taken = {};
  var last = sh.getLastRow();
  if (last > 1) {
    var from = Math.max(2, last - 300);
    sh.getRange(from, 2, last - from + 1, 1).getValues().forEach(function (r) { taken[String(r[0])] = true; });
  }
  var id = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  var ref = makeRef_(Math.random, taken);
  var order = v.order;
  order.id = id; order.ref = ref; order.ts = Date.now();
  sh.appendRow([id, ref, order.ts, 'novo', JSON.stringify(order), order.nome, v.total / 100]);

  cache.put(hourKey, String(perHour + 1), 3600);
  if (tel) cache.put(phoneKey, String(perPhone + 1), 600);
  var out = { ok: true, id: id, ref: ref, total: v.total, taxa: v.taxa };
  if (nonce) cache.put('n' + nonce, JSON.stringify(out), 21600);
  return out;
}

/**
 * Situação do pedido para a página do cliente. O código (id) tem 16 caracteres aleatórios que só o
 * celular do cliente conhece; a resposta traz apenas a etapa — nunca nome, endereço ou valores.
 * O mapa fica 10 s em cache para muitos clientes atualizando ao mesmo tempo não pesarem na planilha.
 */
function orderStatus_(ss, id) {
  if (!/^[a-f0-9]{16}$/.test(id)) return { ok: false, error: 'código inválido' };
  var cache = CacheService.getScriptCache();
  var raw = cache.get('stmap');
  var map;
  if (raw) map = JSON.parse(raw);
  else {
    map = statusMap_(readTable_(ss), Date.now());
    try { cache.put('stmap', JSON.stringify(map), 10); } catch (err) { /* grande demais: segue sem cache */ }
  }
  var hit = map[id];
  if (hit) return { ok: true, s: hit.s, pix: hit.pix, at: hit.at };
  // ainda não chegou na cozinha (o aparelho da impressora busca a cada 15 s)
  var sh = ss.getSheetByName('Pedidos_Online');
  if (sh && sh.getLastRow() > 1) {
    var last = sh.getLastRow();
    var from = Math.max(2, last - 400);
    var ids = sh.getRange(from, 1, last - from + 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return { ok: true, s: 'recebido' };
  }
  return { ok: true, s: 'desconhecido' };
}

function readInbox_(ss) {
  var sh = ss.getSheetByName('Pedidos_Online');
  var out = [];
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach(function (r) {
    if (r[3] === 'novo') { try { out.push(JSON.parse(r[4])); } catch (err) { /* linha estragada: ignora */ } }
  });
  return out;
}

function ackInbox_(ss, ids) {
  var sh = ss.getSheetByName('Pedidos_Online');
  if (!sh || sh.getLastRow() < 2) return;
  var want = {};
  ids.forEach(function (i) { want[String(i)] = true; });
  var range = sh.getRange(2, 1, sh.getLastRow() - 1, 4);
  var vals = range.getValues();
  var changed = false;
  vals.forEach(function (r) { if (want[String(r[0])] && r[3] === 'novo') { r[3] = 'importado'; changed = true; } });
  if (changed) range.setValues(vals);
}

function fill_(ss, name, header, rows) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  var data = [header].concat(rows);
  sh.getRange(1, 1, data.length, header.length).setValues(data);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sh.setFrozenRows(1);
}

var CATS_ = { marmitex: 'Marmitex e feijoada', bebidas: 'Bebidas / Doces', taxa: 'Taxa de entrega', pesagem: 'Pesagem (Salão)', pratos: 'Pratos Prontos' };
var PAGS_ = { dinheiro: 'Dinheiro', cartao: 'Cartão (maquininha)', pix: 'PIX', debito: 'Débito', credito: 'Crédito' };

function writeVendas_(ss, table) {
  var tz = ss.getSpreadsheetTimeZone();
  var list = live_(table, 'ledger').sort(function (a, b) { return a.ts - b.ts; });
  fill_(ss, 'Caixa_Vendas', ['Data', 'Hora', 'Categoria', 'Descrição', 'Valor (R$)', 'Pagamento'],
    list.map(function (l) {
      var d = new Date(l.ts);
      return [Utilities.formatDate(d, tz, 'dd/MM/yyyy'), Utilities.formatDate(d, tz, 'HH:mm'), CATS_[l.cat] || l.cat, l.desc, l.amount / 100, PAGS_[l.pagamento] || l.pagamento];
    }));
}

function writePedidos_(ss, table) {
  var tz = ss.getSpreadsheetTimeZone();
  var list = live_(table, 'pedidos').sort(function (a, b) { return a.ts - b.ts; });
  fill_(ss, 'Pedidos_Marmitex', ['Data', 'Hora', 'Nº', 'Origem', 'Código', 'Cliente', 'Tipo', 'Status', 'Motoboy', 'Itens', 'Total (R$)', 'Pagamento'],
    list.map(function (p) {
      var d = new Date(p.ts);
      return [Utilities.formatDate(d, tz, 'dd/MM/yyyy'), Utilities.formatDate(d, tz, 'HH:mm'), p.num, p.origem === 'online' ? 'Online' : 'Balcão', p.ref || '', p.cliente, p.tipo, p.status, p.motoboyNome || '',
        p.itens.map(function (i) { return i.mid + ' ' + i.label; }).join('; '), (p.subtotal + p.taxa) / 100, PAGS_[p.pagamento] || p.pagamento];
    }));
}
