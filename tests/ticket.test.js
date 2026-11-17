import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { ticketPedido } from '../js/ticket.js';

const mk = () => createStore({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });

test('cupom do pedido traz M-xxx grande, endereço, acompanhamentos, bebida, taxa e total', () => {
  const s = mk();
  const { pedido } = s.createPedido({
    cliente: 'Ana <b>', telefone: '(11) 99999-0000', tipo: 'entrega', endereco: 'Rua A, 10', pagamento: 'pix', obs: 'sem cebola',
    itens: [{ kind: 'marmitex', size: 'G', dish: 'Bife acebolado', acomp: ['Farofa', 'Couve'] }, { kind: 'feijoada', modo: 'separada', size: 'M', dish: 'Feijoada', acomp: [] }],
    bebidas: [{ productId: 'refri_lata', qty: 2 }],
  });
  const h = ticketPedido(pedido);
  for (const t of ['M-001', 'M-002', 'ENTREGA', 'Rua A, 10', 'Farofa, Couve', '2x Refrigerante Lata', 'sem cebola', 'Taxa entrega', 'R$ 4,00', 'R$ 98,00', 'AGUARDANDO COMPROVANTE', 'size: 80mm', 'NÃO É DOCUMENTO FISCAL']) assert.ok(h.includes(t), t);
  assert.ok(!h.includes('<b>'), 'nome do cliente deve ser escapado');
  assert.equal((ticketPedido(pedido, { copies: 2 }).match(/class="page"/g) || []).length, 2);
  assert.ok(ticketPedido(pedido, { width: 58 }).includes('size: 58mm'));
});

test('cupom de retirada não mostra taxa; usa o nome do restaurante configurado', () => {
  const s = mk();
  const { pedido } = s.createPedido({ cliente: 'Bia', tipo: 'retirada', pagamento: 'dinheiro', itens: [{ kind: 'marmitex', size: 'P', dish: 'Virado', acomp: [] }] });
  const h = ticketPedido(pedido, { nome: 'Cantina do Zé' });
  assert.ok(h.includes('RETIRADA') && !h.includes('Taxa entrega'));
  assert.ok(h.includes('Cantina do Zé') && !h.includes("Oliveira's"));
  assert.ok(h.includes('Dinheiro na retirada'));
});

test('cupom de pedido online: código, origem, Pix confirmado e troco', () => {
  const s = mk();
  const on = s.createPedido({ cliente: 'Caio', tipo: 'entrega', endereco: 'Rua B, 5', pagamento: 'dinheiro', trocoPara: 10000, origem: 'online', ref: 'WK7Q', src: 'w-1', itens: [{ kind: 'marmitex', size: 'M', dish: 'Virado', acomp: [] }] }).pedido;
  const h = ticketPedido(on);
  for (const t of ['PEDIDO ONLINE', 'Código: WK7Q', 'Dinheiro na entrega', 'Troco para R$ 100,00', 'levar R$ 76,00']) assert.ok(h.includes(t), t);
  const pix = s.createPedido({ cliente: 'Dani', tipo: 'retirada', pagamento: 'pix', itens: [{ kind: 'marmitex', size: 'M', dish: 'Virado', acomp: [] }] }).pedido;
  assert.ok(ticketPedido(pix).includes('AGUARDANDO COMPROVANTE'));
  s.setPixOk(pix.id, true);
  assert.ok(ticketPedido(s.state.pedidos.find((p) => p.id === pix.id)).includes('comprovante recebido'));
});
