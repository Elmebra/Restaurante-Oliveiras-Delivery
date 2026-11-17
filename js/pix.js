// Pix "copia e cola" estático (BR Code, padrão do Banco Central). Funções puras.
// O cliente paga o valor exato; o dono recebe direto na própria chave, sem intermediário.

/** CRC16/CCITT-FALSE usado pelo BR Code (4 dígitos hexadecimais maiúsculos). */
export function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i += 1) {
    crc ^= (str.charCodeAt(i) & 0xFF) << 8;
    for (let b = 0; b < 8; b += 1) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const tlv = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** Nome/cidade no padrão do Pix: sem acento, maiúsculo, só letras/números/espaço. */
export function pixText(s, max) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/['’`´]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Aceita a chave como o dono digita: CPF/CNPJ com máscara, celular com máscara, e-mail, chave aleatória. */
export function normalizeChave(input) {
  const t = String(input || '').trim();
  if (!t) return '';
  if (t.includes('@')) return t.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return t.toLowerCase();
  if (t.startsWith('+')) return `+${t.replace(/\D/g, '')}`;
  if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(t) || /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(t)) return t.replace(/\D/g, '');
  if (/^\(?\d{2}\)?\s?9?\d{4}-?\d{4}$/.test(t) && /[()\s-]/.test(t)) return `+55${t.replace(/\D/g, '')}`;
  return t.replace(/\s+/g, '');
}

/**
 * @param {{chave:string, nome:string, cidade:string, valorCents?:number, txid?:string}} d
 * @returns {string} código para o Pix copia e cola ('' se faltar a chave)
 */
export function pixPayload({ chave, nome, cidade, valorCents = 0, txid = '' }) {
  const key = normalizeChave(chave);
  if (!key) return '';
  const merchant = tlv('00', 'br.gov.bcb.pix') + tlv('01', key);
  const id = String(txid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const body = tlv('00', '01') + tlv('01', '11') + tlv('26', merchant) + tlv('52', '0000') + tlv('53', '986')
    + (valorCents > 0 ? tlv('54', (valorCents / 100).toFixed(2)) : '')
    + tlv('58', 'BR') + tlv('59', pixText(nome, 25) || 'RESTAURANTE') + tlv('60', pixText(cidade, 15) || 'BRASIL')
    + tlv('62', tlv('05', id)) + '6304';
  return body + crc16(body);
}
