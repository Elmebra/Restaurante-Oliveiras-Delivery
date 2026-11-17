// Regras de preço (puras). Valores em centavos.
//
//  - Marmitex comum ........ Pequena / Média / Grande (prices.marmitex)
//  - Feijoada individual ... Média / Grande            (prices.feijoada.individual)
//  - Feijoada separada ..... Média / Grande            (prices.feijoada.separada)
//
// (v2.0 Delivery: balança e pratos só do salão foram retirados.)

export const SIZES = { P: 'Pequena', M: 'Média', G: 'Grande' };
export const MODOS = { individual: 'Individual', separada: 'Separada' };

/** Tamanhos disponíveis: a feijoada só existe em Média e Grande. */
export function sizesFor(kind) {
  return kind === 'feijoada' ? ['M', 'G'] : ['P', 'M', 'G'];
}

/**
 * item = { kind: 'marmitex', size }
 *      | { kind: 'feijoada', modo: 'individual'|'separada', size: 'M'|'G' }
 */
export function itemPrice(prices, item) {
  let p;
  if (item.kind === 'marmitex') p = prices.marmitex?.[item.size];
  else if (item.kind === 'feijoada') p = prices.feijoada?.[item.modo]?.[item.size];
  if (!Number.isInteger(p) || p < 0) throw new Error('Preço indisponível para este item');
  return p;
}

export function itemLabel(item) {
  if (item.kind === 'marmitex') {
    return `Marmitex ${SIZES[item.size]}${item.dish ? ` — ${item.dish}` : ''}`;
  }
  return `Feijoada ${MODOS[item.modo]} ${SIZES[item.size]}`;
}
