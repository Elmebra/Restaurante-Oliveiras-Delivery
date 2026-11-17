// Gera uma chave de licença para o cliente.
// Uso:  node tools/gerar-chave.mjs 20261231        (válida até 31/12/2026)
//       node tools/gerar-chave.mjs +30             (válida por 30 dias a partir de hoje)
// Antes de usar com clientes, troque SECRET em js/license.js por uma frase só sua.
import { makeKey, SECRET } from '../js/license.js';

const arg = process.argv[2];
if (!arg) { console.error('Uso: node tools/gerar-chave.mjs AAAAMMDD   ou   +DIAS'); process.exit(1); }
let ymd = arg;
if (/^\+\d+$/.test(arg)) {
  const d = new Date(Date.now() + Number(arg.slice(1)) * 86400000);
  ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
if (SECRET.startsWith('TROQUE')) console.error('ATENÇÃO: você ainda não trocou o SECRET em js/license.js. Qualquer cópia deste projeto gera as mesmas chaves.\n');
console.log(makeKey(ymd));
