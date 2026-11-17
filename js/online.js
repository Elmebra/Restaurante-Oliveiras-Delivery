// Pedidos online: busca na planilha (Apps Script) os pedidos feitos pelos clientes na página /c/
// e os transforma em pedidos normais (que a impressão automática imprime sozinha).
// Só UM aparelho deve ter isto ligado (o do balcão/cozinha, ao lado da impressora).

const KEY = 'oliveiras2.online';

/** Pedido recebido do servidor -> rascunho para store.createPedido. */
export function orderToDraft(o) {
  return {
    cliente: o.nome,
    telefone: o.telefone,
    tipo: o.tipo,
    endereco: o.endereco,
    pagamento: o.pagamento,
    obs: o.obs,
    itens: o.itens,
    bebidas: o.bebidas,
    origem: 'online',
    src: `w-${o.id}`,
    ref: o.ref,
    trocoPara: o.trocoPara || 0,
  };
}

export function createOnline({ store, sync, storage = globalThis.localStorage, onNew = () => {}, everyMs = 15000 }) {
  let cfg = { on: false };
  try { cfg = { on: false, ...JSON.parse(storage.getItem(KEY) || '{}') }; } catch { /* padrão */ }
  const st = { last: 0, error: '', failed: [], total: 0 };
  let timer = null;
  let busy = false;

  async function poll() {
    if (!cfg.on || !sync.configured || busy) return { ok: false, skipped: true };
    busy = true;
    try {
      const r = await sync.call({ action: 'inbox' });
      if (!r.ok) { st.error = r.error; return r; }
      st.error = '';
      st.last = Date.now();
      const ack = [];
      const failed = [];
      let imported = 0;
      for (const o of r.orders || []) {
        const res = store.createPedido(orderToDraft(o));
        if (res.ok) { imported += 1; ack.push(o.id); } else if (res.error === 'Pedido online já importado') ack.push(o.id);
        else failed.push({ id: o.id, ref: o.ref, error: res.error });
      }
      st.failed = failed;
      if (ack.length) await sync.call({ action: 'ack', ids: ack });
      st.total += imported;
      if (imported) onNew(imported);
      return { ok: true, imported, failed: failed.length };
    } finally {
      busy = false;
    }
  }

  return {
    poll,
    get on() { return cfg.on; },
    set(on) {
      cfg = { ...cfg, on: !!on };
      try { storage.setItem(KEY, JSON.stringify(cfg)); } catch { /* sem storage */ }
      if (cfg.on) poll();
    },
    start() {
      if (timer) return;
      timer = setInterval(poll, everyMs);
      if (cfg.on) poll();
    },
    get status() { return { ...st, on: cfg.on }; },
  };
}
