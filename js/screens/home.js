import { icons } from '../icons.js';
import { esc } from '../util.js';

const PROFILES = [
  ['cozinha', 'Cozinha', 'Pedidos online e fila de montagem', 'pot', '#1f4a34'],
  ['expedicao', 'Expedição', 'Comprovante do Pix, motoboys e retiradas', 'moto', '#2e6f9e'],
  ['painel', 'Painel do Dono', 'Faturamento, cardápio, preços, Pix e loja', 'chart', '#7a3b3b'],
];

export default {
  render({ s }) {
    const nome = s.config.nome;
    const cards = PROFILES.map(([k, t, s, ic, c]) => `
      <a class="profile" href="#/${k}"><span class="pic" style="background:${c}">${icons[ic]}</span>
        <span><div class="pt">${t}</div><div class="ps">${s}</div></span><span class="chev">${icons.chev}</span></a>`).join('');
    return {
      body: `<div style="display:flex;flex-direction:column;height:100%;overflow-y:auto">
        <div class="hero">${icons.cloche}<div class="rest">DELIVERY</div><div class="logo">${esc(nome)}</div></div>
        <div style="padding:22px 16px 28px"><div class="sec" style="margin-top:0">Quem está usando este aparelho?</div>${cards}</div></div>`,
    };
  },
};
