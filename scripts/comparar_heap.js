const fs = require('fs');
const path = require('path');
const { carregarObservacoes, metricas_descritivas } = require('./agregar');
const { resumoAmostra, welchTTest, holm } = require('./estatistica');

const ajuda = `
Uso: node scripts/comparar_heap.js --complementar <pasta> [--base resultados/final] [--cenario cenarioB] [--payload grande]

Compara o Node da coleta complementar (heap do V8 ampliado com --node-heap-mb) com o Node,
o Bun e o Bun com pg da coleta definitiva, na mesma condição, nível a nível de VUs.
Grava <complementar>/comparacao_heap.csv com médias, IC de 95%, teste de Welch, Holm por
comparação × métrica e diferença relativa sobre a referência da coleta definitiva.
`;

function argumento(nome, padrao) {
  const posicao = process.argv.indexOf(`--${nome}`);
  return posicao >= 0 && process.argv[posicao + 1] ? process.argv[posicao + 1] : padrao;
}

if (process.argv.includes('--help')) {
  console.log(ajuda);
  process.exit(0);
}
const raiz = path.resolve(__dirname, '..');
const pasta_complementar = argumento('complementar', null);
if (!pasta_complementar) {
  console.error(`Erro: --complementar é obrigatório\n${ajuda}`);
  process.exit(2);
}
const pasta_base = argumento('base', 'resultados/final');
const cenario = argumento('cenario', 'cenarioB');
const payload = argumento('payload', 'grande');

const complementar = carregarObservacoes(path.resolve(raiz, pasta_complementar)).observacoes;
const definitiva = carregarObservacoes(path.resolve(raiz, pasta_base)).observacoes;

const referencias = ['node', 'bun', 'bunpg'];
const linhas = [];
for (const chave of Object.keys(complementar).sort()) {
  const [c, p, vus, metrica] = chave.split('|');
  if (c !== cenario || p !== payload || metricas_descritivas.has(metrica)) continue;
  const heap = (complementar[chave].node || []).map((o) => o.v);
  if (!heap.length) continue;
  const resumo_heap = resumoAmostra(heap);
  for (const referencia of referencias) {
    const valores = (definitiva[chave]?.[referencia] || []).map((o) => o.v);
    if (!valores.length) continue;
    const resumo_ref = resumoAmostra(valores);
    const teste = welchTTest(valores, heap);
    const emPercentual = (valor) => (valor === null || !resumo_ref.media ? null : +((valor / resumo_ref.media) * 100).toFixed(2));
    linhas.push({
      cenario: c, payload: p, vus: Number(vus), metrica, comparacao: `nodeheap_vs_${referencia}`, ref: referencia,
      n_ref: resumo_ref.n, media_ref: resumo_ref.media, n_nodeheap: resumo_heap.n, media_nodeheap: resumo_heap.media,
      nodeheap_ic95_lo: resumo_heap.ic95_lo, nodeheap_ic95_hi: resumo_heap.ic95_hi,
      t: teste.t, df: teste.df, p: teste.p, dif: teste.dif, dif_ic95_lo: teste.dif_ic95_lo, dif_ic95_hi: teste.dif_ic95_hi,
      dif_rel_pct: emPercentual(teste.dif), dif_rel_ic95_lo_pct: emPercentual(teste.dif_ic95_lo), dif_rel_ic95_hi_pct: emPercentual(teste.dif_ic95_hi),
    });
  }
}

const familias = {};
linhas.forEach((linha, posicao) => (familias[`${linha.comparacao}|${linha.metrica}`] ??= []).push(posicao));
for (const posicoes of Object.values(familias)) {
  const ajustados = holm(posicoes.map((posicao) => linhas[posicao].p));
  posicoes.forEach((posicao, ordem) => {
    linhas[posicao].p_holm = ajustados[ordem] === null ? null : +ajustados[ordem].toFixed(4);
    linhas[posicao].significativo_holm_5pct = ajustados[ordem] === null ? null : ajustados[ordem] < 0.05;
  });
}
linhas.sort((a, b) => a.comparacao.localeCompare(b.comparacao) || a.metrica.localeCompare(b.metrica) || a.vus - b.vus);

const colunas = [
  'cenario', 'payload', 'vus', 'metrica', 'comparacao', 'ref', 'n_ref', 'media_ref', 'n_nodeheap', 'media_nodeheap',
  'nodeheap_ic95_lo', 'nodeheap_ic95_hi', 't', 'df', 'p', 'p_holm', 'significativo_holm_5pct', 'dif', 'dif_ic95_lo',
  'dif_ic95_hi', 'dif_rel_pct', 'dif_rel_ic95_lo_pct', 'dif_rel_ic95_hi_pct',
];
const destino = path.join(path.resolve(raiz, pasta_complementar), 'comparacao_heap.csv');
fs.writeFileSync(destino, [colunas.join(','), ...linhas.map((linha) => colunas.map((coluna) => linha[coluna] ?? '').join(','))].join('\n'));
console.log(`Gravado ${destino} (${linhas.length} comparações, ${cenario}/${payload})`);
