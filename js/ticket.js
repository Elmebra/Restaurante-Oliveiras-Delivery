// Cupom para impressora térmica (80 mm ou 58 mm). Funções puras: devolvem HTML pronto para imprimir.
import { money, esc, timeHM, dateBR } from './util.js';
import { PAGAMENTOS } from './store.js';

const CSS = (mm) => `
@page { size: ${mm}mm auto; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { width: ${mm === 80 ? 72 : 48}mm; padding: 2mm 2mm 6mm; font: 700 ${mm === 80 ? 13 : 12}px/1.25 'Courier New', Consolas, monospace; color: #000; }
.c { text-align: center; } .r { text-align: right; }
h1 { margin: 0; font: 900 20px/1.1 Georgia, serif; text-align: center; }
.big { font: 900 18px/1.2 'Courier New', monospace; }
.hr { border-top: 2px dashed #000; margin: 6px 0; }
.row { display: flex; justify-content: space-between; gap: 6px; }
.mid { font: 900 24px/1.1 'Courier New', monospace; margin-top: 6px; }
.sub { font-weight: 700; padding-left: 10px; }
.tot { font: 900 17px/1.2 'Courier New', monospace; }
.box { border: 2px solid #000; padding: 3px 5px; margin: 4px 0; }
.foot { margin-top: 8px; text-align: center; font: 900 12px/1.2 'Courier New', monospace; border-top: 2px dashed #000; padding-top: 5px; }
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
`;

const FOOT = '<div class="foot">NÃO É DOCUMENTO FISCAL</div>';
const doc = (mm, pages) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Cupom</title><style>${CSS(mm)}</style></head><body>${pages.map((p) => `<div class="page">${p}${FOOT}</div>`).join('')}</body></html>`;

function pedidoPage(p, via, nome) {
  const total = p.subtotal + p.taxa;
  const entrega = p.tipo === 'entrega';
  const online = p.origem === 'online';
  const pagLinha = p.pagamento === 'pix'
    ? `PIX${p.pixOk ? ' (comprovante recebido)' : ' - AGUARDANDO COMPROVANTE'}`
    : `${esc(PAGAMENTOS[p.pagamento] || p.pagamento)} na ${entrega ? 'entrega' : 'retirada'}`;
  return `<h1>${esc(nome)}</h1>
    <div class="c">${via ? esc(via) : ''}</div>
    <div class="hr"></div>
    <div class="row big"><span>PEDIDO #${p.num}</span><span>${timeHM(p.ts)}</span></div>
    <div class="c">${dateBR(p.ts)}${online ? ' · PEDIDO ONLINE' : ''}</div>
    ${p.ref ? `<div class="c big">Código: ${esc(p.ref)}</div>` : ''}
    <div class="box c big">${entrega ? 'ENTREGA' : 'RETIRADA NO BALCÃO'}</div>
    <div>Cliente: ${esc(p.cliente)}</div>
    ${p.telefone ? `<div>Tel: ${esc(p.telefone)}</div>` : ''}
    ${entrega ? `<div>End.: ${esc(p.endereco)}</div>` : ''}
    <div class="hr"></div>
    ${p.itens.map((i) => `<div class="mid">${esc(i.mid)}</div><div>${esc(i.label)}</div>${i.acomp.length ? `<div class="sub">+ ${esc(i.acomp.join(', '))}</div>` : ''}<div class="r">${money(i.price)}</div>`).join('')}
    ${p.bebidas.length ? `<div class="hr"></div><div>Bebidas:</div>${p.bebidas.map((b) => `<div class="row"><span>${b.qty}x ${esc(b.name)}</span><span>${money(b.amount)}</span></div>`).join('')}` : ''}
    ${p.obs ? `<div class="hr"></div><div class="box">OBS: ${esc(p.obs)}</div>` : ''}
    <div class="hr"></div>
    <div class="row"><span>Subtotal</span><span>${money(p.subtotal)}</span></div>
    ${entrega ? `<div class="row"><span>Taxa entrega</span><span>${money(p.taxa)}</span></div>` : ''}
    <div class="row tot"><span>TOTAL</span><span>${money(total)}</span></div>
    <div class="box">Pagamento: ${pagLinha}</div>
    ${p.pagamento === 'dinheiro' && p.trocoPara ? `<div>Troco para ${money(p.trocoPara)} (levar ${money(Math.max(0, p.trocoPara - total))})</div>` : ''}`;
}

/** Cupom de um pedido. `copies` = 1 (cozinha) ou 2 (cozinha + via do motoboy/entrega). */
export function ticketPedido(p, { width = 80, copies = 1, nome = "Oliveira's" } = {}) {
  const pages = [pedidoPage(p, copies > 1 ? 'VIA COZINHA' : '', nome)];
  if (copies > 1) pages.push(pedidoPage(p, p.tipo === 'entrega' ? 'VIA ENTREGA' : 'VIA BALCÃO', nome));
  return doc(width, pages);
}

export function ticketTeste({ width = 80, nome = "Oliveira's" } = {}) {
  return doc(width, [`<h1>${esc(nome)}</h1><div class="hr"></div><div class="c big">TESTE DE IMPRESSÃO</div><div class="c">${width} mm</div><div class="mid c">M-001</div><div class="hr"></div><div class="c">Se leu isto, a impressora está ok.</div>`]);
}
