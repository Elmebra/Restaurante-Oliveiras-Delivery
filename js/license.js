// Validade do teste / licença. Funções puras + um pequeno gerenciador (localStorage).
//
// AVISO HONESTO: isto roda no aparelho do cliente, então impede uso casual depois do prazo,
// mas não é à prova de quem entende de programação. A trava "de verdade" é: (1) a página de
// pedido fecha sozinha no servidor (Apps Script) quando a validade passa; (2) você controla a
// planilha/Apps Script; (3) o kit de encerramento (kill-switch) derruba o site.
//
// ANTES DE ENTREGAR PARA UM CLIENTE: troque SECRET abaixo por uma frase só sua (e use a mesma
// no tools/gerar-chave.mjs, que lê este arquivo).

export const SECRET = 'TROQUE-ESTE-SEGREDO-ANTES-DE-ENTREGAR';
export const TRIAL_DAYS = 14;
export const SUPORTE = 'Fale com o seu fornecedor do sistema para renovar.';
const DAY = 86400000;
const KEY = 'oliveiras2.lic';

/** Hash de 53 bits (cyrb53) — suficiente para uma chave de licença simples. */
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const check = (ymd, secret) => cyrb53(`${ymd}|${secret}`).toString(36).toUpperCase().padStart(6, '0').slice(-6);

/** Chave válida até o fim do dia `ymd` (AAAAMMDD). */
export function makeKey(ymd, secret = SECRET) {
  if (!/^\d{8}$/.test(ymd)) throw new Error('Data deve ser AAAAMMDD');
  return `OLV-${ymd}-${check(ymd, secret)}`;
}

/** @returns {{ok:true, until:number}|{ok:false}} `until` = último instante do dia (hora local). */
export function parseKey(key, secret = SECRET) {
  const m = /^OLV-(\d{4})(\d{2})(\d{2})-([0-9A-Z]{6})$/.exec(String(key || '').trim().toUpperCase());
  if (!m) return { ok: false };
  const ymd = `${m[1]}${m[2]}${m[3]}`;
  if (check(ymd, secret) !== m[4]) return { ok: false };
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, until: d.getTime() };
}

/**
 * Situação da licença.
 * first = 1º uso (ms); key = chave digitada; shared = validade vinda da planilha (opcional).
 * @returns {{state:'trial'|'active'|'expired', until:number, daysLeft:number}}
 */
export function licenseStatus({ first, key, shared = 0, now, secret = SECRET }) {
  const trialEnd = first + TRIAL_DAYS * DAY;
  const k = parseKey(key, secret);
  const keyEnd = k.ok ? k.until : 0;
  const until = Math.max(trialEnd, keyEnd, shared || 0);
  const state = now > until ? 'expired' : (until > trialEnd ? 'active' : 'trial');
  return { state, until, daysLeft: Math.max(0, Math.ceil((until - now) / DAY)) };
}

export function createLicense({ store, storage = globalThis.localStorage, now = () => Date.now(), secret = SECRET }) {
  const read = () => { try { return JSON.parse(storage.getItem(KEY)) || {}; } catch { return {}; } };
  const write = (v) => { try { storage.setItem(KEY, JSON.stringify(v)); } catch { /* sem storage */ } };

  function status() {
    const saved = read();
    const t = now();
    const shared = store.state.config;
    // primeiro uso: o mais antigo entre este aparelho e o que a planilha já conhece
    let first = saved.first || t;
    if (shared.inicio && shared.inicio < first) first = shared.inicio;
    if (saved.first !== first) write({ ...saved, first });
    const st = licenseStatus({ first, key: saved.key, shared: shared.validade, now: t, secret });
    // publica na planilha (a página de pedido do cliente fecha sozinha quando vence)
    const patch = {};
    if (!shared.inicio || shared.inicio > first) patch.inicio = first;
    if (st.until > (shared.validade || 0)) patch.validade = st.until;
    if (Object.keys(patch).length) store.setConfig(patch);
    return { ...st, first, key: saved.key || '' };
  }

  function activate(key) {
    const r = parseKey(key, secret);
    if (!r.ok) return { ok: false, error: 'Chave inválida. Confira se digitou igual ao que recebeu.' };
    if (r.until < now()) return { ok: false, error: 'Esta chave já venceu.' };
    write({ ...read(), key: String(key).trim().toUpperCase() });
    return { ok: true, until: r.until };
  }

  return { status, activate };
}
