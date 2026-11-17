// Dados de demonstração (só para testar o app). Gera pedidos online e de balcão realistas.
export function loadDemo(store) {
  let t = Date.now() - 3 * 3600e3;
  store.setClock(() => (t += 60e3));
  try {
    for (const nome of ['Carlos', 'Diego', 'Marcos']) store.addMotoboy(nome);
    const mot = store.state.motoboys.filter((m) => m.active);
    const mk = (extra) => store.createPedido({ tipo: 'entrega', endereco: 'Rua das Flores, 120 - Centro', pagamento: 'dinheiro', ...extra });
    const a = mk({ cliente: 'Dona Lúcia', itens: [{ kind: 'marmitex', size: 'G', dish: 'Virado', acomp: ['Couve', 'Farofa'] }, { kind: 'marmitex', size: 'M', dish: 'Picadinho', acomp: [] }], origem: 'online', ref: 'WK7Q', src: 'w-demo1' });
    const b = mk({ cliente: 'Sr. Paulo', itens: [{ kind: 'feijoada', modo: 'separada', size: 'G', dish: 'Feijoada', acomp: [] }], pagamento: 'pix', origem: 'online', ref: 'WM3D', src: 'w-demo2' });
    mk({ cliente: 'Ana', tipo: 'retirada', itens: [{ kind: 'feijoada', modo: 'individual', size: 'M', dish: 'Feijoada', acomp: [] }], bebidas: [{ productId: 'refri_lata', qty: 1 }] });
    store.setPixOk(b.pedido.id, true);
    for (const p of [a, b]) {
      for (const it of p.pedido.itens) store.setItemReady(p.pedido.id, it.id, true);
    }
    store.dispatch(a.pedido.id, mot[0].id);
    store.markDelivered(a.pedido.id);
  } finally {
    store.setClock(null);
  }
}
