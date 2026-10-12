const fs = require('fs');
const path = require('path');
const { resumoAmostra, welchTTest, holm, contrasteWelch } = require('./estatistica');

const margem_janela_s = 2;
const margem_equivalencia_pct = 10;
const classes_resposta = ['ok', 'timeout', 'conexao', 'http_4xx', 'http_5xx'];
const runtimes = ['node', 'bun', 'bunpg'];
const ordem_payloads = ['pequeno', 'medio', 'grande'];
const comparacoes = [
  { referencia: 'node', alternativa: 'bun', nome: 'bun_vs_node', cenarios: ['cenarioA', 'cenarioB'] },
  { referencia: 'node', alternativa: 'bunpg', nome: 'bunpg_vs_node', cenarios: ['cenarioB'] },
  { referencia: 'bunpg', alternativa: 'bun', nome: 'bunsql_vs_bunpg', cenarios: ['cenarioB'] },
];

const metricas_descritivas = new Set(['requisicoes_total', 'requisicoes_ok']);
const criterio_saturacao = {
  erro_pct: 1,
  crescimento_minimo_vazao: 1.05,
  fator_latencia: 1.5,
  metrica_latencia: 'latencia_ok_p99_ms',
};

const metricas_interacao = ['vazao_util_rps', 'latencia_p95_ms', 'latencia_p99_ms', 'latencia_ok_p95_ms', 'latencia_ok_p99_ms'];
const metricas_decomposicao = [
  'latencia_media_ms', 'latencia_p95_ms', 'latencia_p99_ms',
  'latencia_ok_media_ms', 'latencia_ok_p95_ms', 'latencia_ok_p99_ms',
  'vazao_util_rps',
];
const maiorEMelhor = (metrica) => metrica.startsWith('vazao');

const base_no_cenario_A = { node: 'node', bun: 'bun', bunpg: 'bun' };

let pasta_base = null;

const arredondar = (valor, casas = 4) => (valor === null || valor === undefined || !Number.isFinite(valor) ? null : +valor.toFixed(casas));
const csv = (colunas, linhas) => [colunas.join(','), ...linhas.map((linha) => colunas.map((coluna) => linha[coluna] ?? '').join(','))].join('\n');

function lerJson(caminho) {
  try {
    return JSON.parse(fs.readFileSync(caminho, 'utf8'));
  } catch (_) {
    return null;
  }
}

function listarRepeticoes() {
  const repeticoes = fs.readdirSync(pasta_base).filter((nome) => /^rep\d+$/.test(nome)).sort();
  if (!repeticoes.length) {
    console.error(`Erro: nenhuma pasta repNN em ${pasta_base}`);
    process.exit(2);
  }
  return repeticoes;
}

function descobrirPayloads(repeticoes) {
  const nomes = repeticoes.flatMap((repeticao) => runtimes.flatMap((runtime) => {
    const pasta = path.join(pasta_base, repeticao, runtime);
    if (!fs.existsSync(pasta)) return [];
    return fs.readdirSync(pasta)
      .map((arquivo) => /^resultado_cenario[AB]_(?:node|bunpg|bun)_(.+)\.json$/.exec(arquivo)?.[1])
      .filter(Boolean);
  }));
  const posicao = (nome) => (ordem_payloads.includes(nome) ? ordem_payloads.indexOf(nome) : ordem_payloads.length);
  return [...new Set(nomes)].sort((a, b) => posicao(a) - posicao(b) || a.localeCompare(b));
}

function recursosNaJanela(stats, inicio_epoch_ms, inicio_s, fim_s) {
  if (!stats || !stats.amostras) return null;
  const janela = stats.amostras.filter((amostra) => (
    amostra.mem_uso_mb > 0
    && amostra.t_epoch_ms >= inicio_epoch_ms + inicio_s * 1000
    && amostra.t_epoch_ms <= inicio_epoch_ms + fim_s * 1000
  ));
  if (janela.length < 3) return null;
  const mediaDe = (valores) => valores.reduce((soma, valor) => soma + valor, 0) / valores.length;
  return {
    cpu: mediaDe(janela.map((amostra) => amostra.cpu_percent)),
    mem_media: mediaDe(janela.map((amostra) => amostra.mem_uso_mb)),
    mem_pico: Math.max(...janela.map((amostra) => amostra.mem_uso_mb)),
  };
}

function metricasDeLatencia(prefixo, valores) {
  return [
    [`${prefixo}_media_ms`, valores.avg],
    [`${prefixo}_p95_ms`, valores['p(95)']],
    [`${prefixo}_p99_ms`, valores['p(99)']],
  ];
}

function metricasDoNivel(resultado, nivel, sustentacao_s) {
  const ler = (prefixo) => resultado[`${prefixo}_sustain_${nivel}`];
  const contagens = {};
  for (const classe of classes_resposta) contagens[classe] = ler(`resp_${classe}`)?.values.count ?? 0;
  const total = classes_resposta.reduce((soma, classe) => soma + contagens[classe], 0);
  if (total === 0) return [];

  const metricas = [
    ['vazao_util_rps', contagens.ok / sustentacao_s],
    ['vazao_bruta_rps', total / sustentacao_s],
    ['taxa_erro_pct', (1 - contagens.ok / total) * 100],
    ...classes_resposta.filter((classe) => classe !== 'ok').map((classe) => [`resp_${classe}_pct`, (contagens[classe] / total) * 100]),
    ['requisicoes_total', total],
    ['requisicoes_ok', contagens.ok],
  ];
  const latencia = ler('latencia')?.values;
  if (latencia) metricas.push(...metricasDeLatencia('latencia', latencia));
  const latencia_ok = ler('latencia_ok')?.values;
  if (latencia_ok && contagens.ok > 0) metricas.push(...metricasDeLatencia('latencia_ok', latencia_ok));
  const tempo_total = ler('tempo_total')?.values;
  if (tempo_total) metricas.push(...metricasDeLatencia('tempo_total', tempo_total));
  return metricas;
}

function coletarObservacoes(repeticoes, payloads) {
  const observacoes = {};
  const niveis_por_condicao = {};
  const registrarObservacao = (cenario, payload, vus, metrica, runtime, repeticao, valor) => {
    if (valor === null || valor === undefined || Number.isNaN(valor)) return;
    const chave = [cenario, payload, vus, metrica].join('|');
    ((observacoes[chave] ??= {})[runtime] ??= []).push({ rep: repeticao, v: valor });
  };

  for (const repeticao of repeticoes) {
    for (const cenario of ['cenarioA', 'cenarioB']) {
      for (const payload of payloads) {
        for (const runtime of runtimes) {
          if (runtime === 'bunpg' && cenario === 'cenarioA') continue;
          const nome = `${cenario}_${runtime}_${payload}`;
          const pasta = path.join(pasta_base, repeticao, runtime);
          const resultado = lerJson(path.join(pasta, `resultado_${nome}.json`));
          if (!resultado || !resultado._meta) {
            console.log(`  aviso: ${repeticao}/${nome} ausente ou sem _meta, ignorando`);
            continue;
          }
          const { ramp_s: rampa_s, sustain_s: sustentacao_s, inicio_epoch_ms, vu_levels: niveis } = resultado._meta;
          niveis_por_condicao[[cenario, payload, runtime].join('|')] = niveis;
          const recursos = [
            ['api', lerJson(path.join(pasta, `stats_${nome}.json`))],
            ['k6', lerJson(path.join(pasta, `stats_k6_${nome}.json`))],
            ['pg', lerJson(path.join(pasta, `stats_pg_${nome}.json`))],
          ];

          niveis.forEach((nivel, indice) => {
            const adicionar = (metrica, valor) => registrarObservacao(cenario, payload, nivel, metrica, runtime, repeticao, valor);
            for (const [metrica, valor] of metricasDoNivel(resultado, nivel, sustentacao_s)) adicionar(metrica, valor);

            const inicio_do_nivel_s = indice * (rampa_s + sustentacao_s);
            const inicio_da_janela_s = inicio_do_nivel_s + rampa_s + margem_janela_s;
            const fim_da_janela_s = inicio_do_nivel_s + rampa_s + sustentacao_s - margem_janela_s;
            for (const [prefixo, stats] of recursos) {
              const janela = recursosNaJanela(stats, inicio_epoch_ms, inicio_da_janela_s, fim_da_janela_s);
              if (!janela) continue;
              adicionar(`${prefixo}_cpu_pct`, janela.cpu);
              adicionar(`${prefixo}_mem_pico_mb`, janela.mem_pico);
              adicionar(`${prefixo}_mem_media_mb`, janela.mem_media);
            }
          });
        }
      }
    }
  }
  return { observacoes, niveis_por_condicao };
}

function nivelETempoDaMorte(resultado, amostras_vivas) {
  const tempo_s = (amostras_vivas[amostras_vivas.length - 1].t_epoch_ms - resultado._meta.inicio_epoch_ms) / 1000;
  const duracao_do_nivel_s = resultado._meta.ramp_s + resultado._meta.sustain_s;
  const indice = Math.min(resultado._meta.vu_levels.length - 1, Math.max(0, Math.floor(tempo_s / duracao_do_nivel_s)));
  return { nivel: resultado._meta.vu_levels[indice], tempo: tempo_s.toFixed(1) };
}

function lerTexto(arquivo) {
  try {
    return fs.readFileSync(arquivo, 'utf8');
  } catch (_) {
    return null;
  }
}

// Erro fatal do runtime registrado no log da API. O tempo vem do último registro de GC do V8,
// em ms desde o início do processo (alguns segundos antes do início do teste de carga).
function erroFatalNoLog(log) {
  if (!log || !/FATAL ERROR/.test(log)) return null;
  const tempos = [...log.matchAll(/\]\s+(\d+) ms:/g)].map((achado) => Number(achado[1]));
  return {
    heap_v8: /JavaScript heap out of memory/.test(log),
    tempo_processo_s: tempos.length ? tempos[tempos.length - 1] / 1000 : null,
  };
}

function causaDaMorte(estado, log, fatal, morreu) {
  if (!morreu) return '';
  if (/OOMKilled=true/.test(estado)) return 'oom_kernel_limite_conteiner';
  if (log === null) return 'desconhecida_sem_log';
  if (fatal && fatal.heap_v8) return 'limite_heap_v8';
  if (/out of memory|OutOfMemory/i.test(log)) return 'falta_de_memoria_runtime';
  return 'outra';
}

function gerarLinhasDeMortes(repeticoes) {
  const linhas = ['cenario,payload,runtime,rep,oom_killed,morreu,processo_travado,exit_code,causa,nivel_na_morte,tempo_morte_s,fonte_tempo,mem_max_mb'];
  for (const repeticao of repeticoes) {
    const manifesto = lerJson(path.join(pasta_base, repeticao, 'execucao.json')) || [];
    for (const entrada of manifesto) {
      const partes = /^(cenario[AB])_(node|bunpg|bun)_(.+)$/.exec(entrada.rodada || '');
      if (!partes) continue;
      const [, cenario, runtime, payload] = partes;
      const estado = entrada.apiEstado || '';
      const pasta = path.join(pasta_base, repeticao, runtime);
      const resultado = lerJson(path.join(pasta, `resultado_${entrada.rodada}.json`));
      const stats = lerJson(path.join(pasta, `stats_${entrada.rodada}.json`));
      const log = lerTexto(path.join(pasta_base, repeticao, 'logs', `api_${entrada.rodada}.log`));
      const fatal = erroFatalNoLog(log);
      const saiu = /Status=exited/.test(estado);
      // Depois do erro fatal o processo pode ficar travado, sem atender, com o contêiner ainda de pé.
      const morreu = saiu || fatal !== null;
      const travado = !saiu && fatal !== null;
      const causa = causaDaMorte(estado, log, fatal, morreu);

      let nivel = '';
      let tempo = '';
      let fonte = '';
      let mem_max = '';
      const vivas = stats && stats.amostras ? stats.amostras.filter((amostra) => amostra.mem_uso_mb > 0) : [];
      if (vivas.length) mem_max = Math.max(...vivas.map((amostra) => amostra.mem_uso_mb)).toFixed(1);
      if (morreu && resultado && resultado._meta) {
        const meta = resultado._meta;
        if (fatal && fatal.tempo_processo_s !== null) {
          const indice = Math.min(meta.vu_levels.length - 1, Math.floor(fatal.tempo_processo_s / (meta.ramp_s + meta.sustain_s)));
          nivel = meta.vu_levels[indice];
          tempo = fatal.tempo_processo_s.toFixed(1);
          fonte = 'log_erro_fatal';
        } else if (vivas.length) {
          const morte = nivelETempoDaMorte(resultado, vivas);
          nivel = morte.nivel;
          tempo = morte.tempo;
          fonte = 'fim_das_amostras';
        }
      }
      linhas.push([
        cenario, payload, runtime, repeticao,
        /OOMKilled=true/.test(estado) ? 1 : 0,
        morreu ? 1 : 0,
        travado ? 1 : 0,
        /ExitCode=(\d+)/.exec(estado)?.[1] ?? '',
        causa, nivel, tempo, fonte, mem_max,
      ].join(','));
    }
  }
  return linhas;
}

function compararRuntimes(observacoes) {
  const agregado = [];
  const linhas_agregado = ['cenario,payload,vus,metrica,runtime,n,media,dp,ic95_lo,ic95_hi'];
  const linhas_brutos = ['cenario,payload,vus,metrica,runtime,rep,valor'];
  const testes = [];

  for (const chave of Object.keys(observacoes).sort()) {
    const [cenario, payload, vus_texto, metrica] = chave.split('|');
    const vus = Number(vus_texto);
    const por_runtime = observacoes[chave];
    const resumos = {};
    for (const runtime of Object.keys(por_runtime)) {
      const resumo = resumoAmostra(por_runtime[runtime].map((observacao) => observacao.v));
      resumos[runtime] = resumo;
      linhas_agregado.push([cenario, payload, vus, metrica, runtime, resumo.n, resumo.media, resumo.dp, resumo.ic95_lo, resumo.ic95_hi].join(','));
      for (const observacao of por_runtime[runtime]) {
        linhas_brutos.push([cenario, payload, vus, metrica, runtime, observacao.rep, +observacao.v.toFixed(4)].join(','));
      }
    }
    agregado.push({ cenario, payload, vus, metrica, runtimes: resumos });
    if (metricas_descritivas.has(metrica)) continue;

    for (const { referencia, alternativa, nome, cenarios } of comparacoes) {
      if (!cenarios.includes(cenario) || !por_runtime[referencia] || !por_runtime[alternativa]) continue;
      const teste = welchTTest(por_runtime[referencia].map((observacao) => observacao.v), por_runtime[alternativa].map((observacao) => observacao.v));
      const media_referencia = resumos[referencia].media;
      const emPercentual = (valor) => (valor === null || !media_referencia ? null : +((valor / media_referencia) * 100).toFixed(2));
      const limite_inferior = emPercentual(teste.dif_ic95_lo);
      const limite_superior = emPercentual(teste.dif_ic95_hi);
      testes.push({
        cenario, payload, vus, metrica, comparacao: nome, ref: referencia, alt: alternativa,
        media_ref: media_referencia, media_alt: resumos[alternativa].media,
        ...teste,
        dif_rel_pct: emPercentual(teste.dif),
        dif_rel_ic95_lo_pct: limite_inferior,
        dif_rel_ic95_hi_pct: limite_superior,
        equivalente_10pct: limite_inferior === null || limite_superior === null
          ? null
          : limite_inferior > -margem_equivalencia_pct && limite_superior < margem_equivalencia_pct,
      });
    }
  }
  return { agregado, linhas_agregado, linhas_brutos, testes };
}

function ajustarPorFamilia(linhas, chaveDaFamilia, campo_p = 'p') {
  const familias = {};
  linhas.forEach((linha, posicao) => {
    (familias[chaveDaFamilia(linha)] ??= []).push(posicao);
  });
  for (const posicoes of Object.values(familias)) {
    const ajustados = holm(posicoes.map((posicao) => linhas[posicao][campo_p]));
    posicoes.forEach((posicao, ordem) => {
      linhas[posicao].p_holm = ajustados[ordem] === null ? null : +ajustados[ordem].toFixed(4);
      linhas[posicao].significativo_holm_5pct = ajustados[ordem] === null ? null : ajustados[ordem] < 0.05;
    });
  }
}

function ajustarComHolm(testes) {
  ajustarPorFamilia(testes, (teste) => `${teste.comparacao}|${teste.metrica}`);
}

function gerarLinhasDeTestes(testes) {
  const colunas = [
    'cenario', 'payload', 'vus', 'metrica', 'comparacao', 'ref', 'alt', 'media_ref', 'media_alt', 't', 'df', 'p', 'p_holm',
    'significativo_5pct', 'significativo_holm_5pct', 'dif', 'dif_ic95_lo', 'dif_ic95_hi', 'dif_rel_pct',
    'dif_rel_ic95_lo_pct', 'dif_rel_ic95_hi_pct', 'equivalente_10pct',
  ];
  return [colunas.join(','), ...testes.map((teste) => colunas.map((coluna) => teste[coluna]).join(','))];
}

function pontoDeSaturacao(serie, criterio = criterio_saturacao) {
  for (let i = 0; i < serie.length; i++) {
    const estagio = serie[i];
    if (estagio.erro_pct === null || estagio.erro_pct === undefined) return { vus: estagio.vus, motivo: 'sem_requisicoes' };
    if (estagio.erro_pct >= criterio.erro_pct) return { vus: estagio.vus, motivo: 'erro' };
    if (i === 0) continue;
    const anterior = serie[i - 1];
    const vazao_parou = anterior.vazao > 0 && estagio.vazao < criterio.crescimento_minimo_vazao * anterior.vazao;
    const latencia_disparou = anterior.latencia > 0 && estagio.latencia > criterio.fator_latencia * anterior.latencia;
    if (vazao_parou && latencia_disparou) return { vus: estagio.vus, motivo: 'vazao_e_latencia' };
  }
  return { vus: null, motivo: 'nao_saturou' };
}

function primeiroNivelComErro(serie, criterio = criterio_saturacao) {
  const estagio = serie.find((item) => item.erro_pct === null || item.erro_pct === undefined || item.erro_pct >= criterio.erro_pct);
  return estagio ? estagio.vus : null;
}

function calcularSaturacao(observacoes, niveis_por_condicao) {
  const valorDe = (cenario, payload, vus, metrica, runtime) => observacoes[[cenario, payload, vus, metrica].join('|')]?.[runtime] ?? [];
  const por_repeticao = [];
  const resumo = [];

  for (const [condicao, niveis] of Object.entries(niveis_por_condicao).sort()) {
    const [cenario, payload, runtime] = condicao.split('|');
    const repeticoes = [...new Set(niveis.flatMap((vus) => valorDe(cenario, payload, vus, 'taxa_erro_pct', runtime).map((o) => o.rep)))].sort();
    const serieDa = (escolher) => niveis.map((vus) => {
      const ler = (metrica) => escolher(valorDe(cenario, payload, vus, metrica, runtime));
      return { vus, erro_pct: ler('taxa_erro_pct'), vazao: ler('vazao_util_rps'), latencia: ler(criterio_saturacao.metrica_latencia) };
    });

    const ultimo = niveis[niveis.length - 1];
    const pontos = [];
    const niveis_com_erro = [];
    for (const rep of repeticoes) {
      const serie = serieDa((valores) => valores.find((o) => o.rep === rep)?.v ?? null);
      const ponto = pontoDeSaturacao(serie);
      const nivel_erro = primeiroNivelComErro(serie);
      pontos.push(ponto);
      niveis_com_erro.push(nivel_erro);
      por_repeticao.push({ cenario, payload, runtime, rep, vus_saturacao: ponto.vus ?? '', motivo: ponto.motivo, vus_erro_1pct: nivel_erro ?? `>${ultimo}` });
    }
    const mediaOuNulo = (valores) => (valores.length ? valores.reduce((soma, o) => soma + o.v, 0) / valores.length : null);
    const serie_media = serieDa(mediaOuNulo);
    const ponto_medio = pontoDeSaturacao(serie_media);

    const comoTexto = (valor) => (valor === Infinity || Number.isNaN(valor) ? `>${ultimo}` : valor);
    const estatisticasDe = (niveis_observados) => {
      const ordenados = niveis_observados.map((nivel) => nivel ?? Infinity).sort((a, b) => a - b);
      if (!ordenados.length) return { min: '', mediana: '', max: '' };
      const meio = ordenados.length / 2;
      const mediana = ordenados.length % 2 ? ordenados[Math.floor(meio)] : (ordenados[meio - 1] + ordenados[meio]) / 2;
      return { min: comoTexto(ordenados[0]), mediana: comoTexto(mediana), max: comoTexto(ordenados[ordenados.length - 1]) };
    };
    const saturacao = estatisticasDe(pontos.map((ponto) => ponto.vus));
    const erro = estatisticasDe(niveis_com_erro);
    const motivos = {};
    for (const ponto of pontos) motivos[ponto.motivo] = (motivos[ponto.motivo] || 0) + 1;
    resumo.push({
      cenario, payload, runtime,
      n_reps: pontos.length,
      n_nao_saturou: motivos.nao_saturou || 0,
      vus_min: saturacao.min,
      vus_mediana: saturacao.mediana,
      vus_max: saturacao.max,
      motivos: Object.entries(motivos).map(([motivo, quantidade]) => `${motivo}:${quantidade}`).join(';'),
      vus_curva_media: ponto_medio.vus ?? `>${ultimo}`,
      motivo_curva_media: ponto_medio.motivo,
      vus_erro_1pct_min: erro.min,
      vus_erro_1pct_mediana: erro.mediana,
      vus_erro_1pct_max: erro.max,
      vus_erro_1pct_curva_media: primeiroNivelComErro(serie_media) ?? `>${ultimo}`,
    });
  }
  return { por_repeticao, resumo };
}

function contrasteDeRazoes({ ref_de, alt_de, ref_para, alt_para }) {
  const grupos = [ref_de, alt_de, ref_para, alt_para];
  if (grupos.some((grupo) => grupo.length < 2 || grupo.some((valor) => !(valor > 0)))) return null;
  const logs = grupos.map((grupo) => grupo.map(Math.log));
  const mediaLog = (grupo) => grupo.reduce((soma, valor) => soma + valor, 0) / grupo.length;
  const contraste = contrasteWelch(logs, [1, -1, -1, 1]);
  const exp = (valor) => (valor === null ? null : Math.exp(valor));
  return {
    razao_de: Math.exp(mediaLog(logs[1]) - mediaLog(logs[0])),
    razao_para: Math.exp(mediaLog(logs[3]) - mediaLog(logs[2])),
    razao_para_sobre_de: exp(contraste.estimativa),
    ic95_lo: exp(contraste.ic95_lo),
    ic95_hi: exp(contraste.ic95_hi),
    t: contraste.t,
    df: contraste.df,
    p: contraste.p,
  };
}

function calcularInteracoes(observacoes, payloads) {
  const valoresDe = (cenario, payload, vus, metrica, runtime) => (observacoes[[cenario, payload, vus, metrica].join('|')]?.[runtime] ?? []).map((o) => o.v);
  const niveis = [...new Set(Object.keys(observacoes).map((chave) => Number(chave.split('|')[2])))].sort((a, b) => a - b);
  const linhas = [];
  const adicionar = (base, contraste) => {
    if (!contraste) return;
    linhas.push({ ...base, ...contraste });
  };

  const pares_de_cenario = [
    { comparacao: 'bun_vs_node', ref: 'node', alt_A: 'bun', alt_B: 'bun' },
    { comparacao: 'bunpg_vs_node', ref: 'node', alt_A: 'bun', alt_B: 'bunpg' },
  ];
  for (const { comparacao, ref, alt_A, alt_B } of pares_de_cenario) {
    for (const payload of payloads) {
      for (const vus of niveis) {
        for (const metrica of metricas_interacao) {
          adicionar(
            { tipo: 'cenario', comparacao, metrica, payload, cenario: '', vus, de: 'cenarioA', para: 'cenarioB', ref, alt: alt_B },
            contrasteDeRazoes({
              ref_de: valoresDe('cenarioA', payload, vus, metrica, ref),
              alt_de: valoresDe('cenarioA', payload, vus, metrica, alt_A),
              ref_para: valoresDe('cenarioB', payload, vus, metrica, ref),
              alt_para: valoresDe('cenarioB', payload, vus, metrica, alt_B),
            }),
          );
        }
      }
    }
  }

  // Payload menor → payload seguinte, dentro de cada cenário e nível de concorrência.
  for (const { referencia, alternativa, nome, cenarios } of comparacoes) {
    for (const cenario of cenarios) {
      for (let i = 0; i + 1 < payloads.length; i++) {
        const [de, para] = [payloads[i], payloads[i + 1]];
        for (const vus of niveis) {
          for (const metrica of metricas_interacao) {
            adicionar(
              { tipo: 'payload', comparacao: nome, metrica, payload: '', cenario, vus, de, para, ref: referencia, alt: alternativa },
              contrasteDeRazoes({
                ref_de: valoresDe(cenario, de, vus, metrica, referencia),
                alt_de: valoresDe(cenario, de, vus, metrica, alternativa),
                ref_para: valoresDe(cenario, para, vus, metrica, referencia),
                alt_para: valoresDe(cenario, para, vus, metrica, alternativa),
              }),
            );
          }
        }
      }
    }
  }

  ajustarPorFamilia(linhas, (linha) => `${linha.tipo}|${linha.comparacao}|${linha.metrica}`);
  for (const linha of linhas) {
    if (!linha.significativo_holm_5pct) linha.efeito = 'sem_diferenca_detectavel';
    else {
      const razao_aumentou = linha.razao_para_sobre_de > 1;
      linha.efeito = razao_aumentou === maiorEMelhor(linha.metrica) ? 'alt_relativamente_melhor' : 'alt_relativamente_pior';
    }
  }
  return linhas;
}


function calcularDecomposicao(observacoes, payloads) {
  const valoresDe = (cenario, payload, vus, metrica, runtime) => (observacoes[[cenario, payload, vus, metrica].join('|')]?.[runtime] ?? []).map((o) => o.v);
  const niveis = [...new Set(Object.keys(observacoes).map((chave) => Number(chave.split('|')[2])))].sort((a, b) => a - b);
  const deltas = [];
  const diferencas = [];

  for (const payload of payloads) {
    for (const vus of niveis) {
      for (const metrica of metricas_decomposicao) {
        for (const runtime of runtimes) {
          const base_A = base_no_cenario_A[runtime];
          const valores_A = valoresDe('cenarioA', payload, vus, metrica, base_A);
          const valores_B = valoresDe('cenarioB', payload, vus, metrica, runtime);
          if (valores_A.length < 2 || valores_B.length < 2) continue;
          const teste = welchTTest(valores_A, valores_B);
          const media_A = resumoAmostra(valores_A).media;
          deltas.push({
            payload, vus, metrica, runtime, base_A,
            media_A, media_B: resumoAmostra(valores_B).media,
            delta: teste.dif, delta_ic95_lo: teste.dif_ic95_lo, delta_ic95_hi: teste.dif_ic95_hi,
            delta_rel_pct: media_A ? arredondar((teste.dif / media_A) * 100, 2) : null,
            p: teste.p,
          });
        }

        for (const { referencia, alternativa, nome } of comparacoes) {
          // Bun.sql × pg compartilham a mesma base no Cenário A; a comparação deles já está em teste_hipotese.csv.
          if (base_no_cenario_A[referencia] === base_no_cenario_A[alternativa]) continue;
          const grupos = [
            valoresDe('cenarioA', payload, vus, metrica, base_no_cenario_A[referencia]),
            valoresDe('cenarioB', payload, vus, metrica, referencia),
            valoresDe('cenarioA', payload, vus, metrica, base_no_cenario_A[alternativa]),
            valoresDe('cenarioB', payload, vus, metrica, alternativa),
          ];
          if (grupos.some((grupo) => grupo.length < 2)) continue;
          // (alt_B − alt_A) − (ref_B − ref_A): positivo quando o delta do alt é maior.
          const contraste = contrasteWelch(grupos, [1, -1, -1, 1]);
          if (contraste.p === null) continue;
          diferencas.push({
            payload, vus, metrica, comparacao: nome, ref: referencia, alt: alternativa,
            delta_alt_menos_delta_ref: arredondar(contraste.estimativa),
            ic95_lo: arredondar(contraste.ic95_lo),
            ic95_hi: arredondar(contraste.ic95_hi),
            t: arredondar(contraste.t, 3),
            df: arredondar(contraste.df, 2),
            p: arredondar(contraste.p),
          });
        }
      }
    }
  }

  ajustarPorFamilia(diferencas, (linha) => `${linha.comparacao}|${linha.metrica}`);
  for (const linha of diferencas) {
    linha.efeito = !linha.significativo_holm_5pct
      ? 'sem_diferenca_detectavel'
      : linha.delta_alt_menos_delta_ref > 0 ? 'delta_maior_no_alt' : 'delta_menor_no_alt';
  }
  return { deltas, diferencas };
}

function main() {
  const posicao_argumento = process.argv.indexOf('--out-base');
  if (posicao_argumento < 0 || !process.argv[posicao_argumento + 1]) {
    console.error('Erro: --out-base é obrigatório (ex.: node scripts/agregar.js --out-base resultados/final)');
    process.exit(2);
  }
  pasta_base = path.resolve(__dirname, '..', process.argv[posicao_argumento + 1]);

  const repeticoes = listarRepeticoes();
  console.log(`Repetições: ${repeticoes.join(', ')}`);
  const payloads = descobrirPayloads(repeticoes);
  console.log(`Payloads: ${payloads.join(', ')}`);

  const { observacoes, niveis_por_condicao } = coletarObservacoes(repeticoes, payloads);
  fs.writeFileSync(path.join(pasta_base, 'oom.csv'), gerarLinhasDeMortes(repeticoes).join('\n'));

  const { agregado, linhas_agregado, linhas_brutos, testes } = compararRuntimes(observacoes);
  ajustarComHolm(testes);

  fs.writeFileSync(path.join(pasta_base, 'agregado.json'), JSON.stringify(agregado, null, 2));
  fs.writeFileSync(path.join(pasta_base, 'agregado.csv'), linhas_agregado.join('\n'));
  fs.writeFileSync(path.join(pasta_base, 'teste_hipotese.csv'), gerarLinhasDeTestes(testes).join('\n'));
  fs.writeFileSync(path.join(pasta_base, 'testes.json'), JSON.stringify(testes, null, 2));
  fs.writeFileSync(path.join(pasta_base, 'brutos.csv'), linhas_brutos.join('\n'));
  console.log(`Gravado em ${pasta_base}: agregado.json/csv, teste_hipotese.csv, testes.json, brutos.csv (${agregado.length} condições, ${testes.length} testes)`);

  const perdem_significancia = testes.filter((teste) => teste.significativo_5pct && teste.significativo_holm_5pct === false).length;
  console.log(`Testes significativos a 5% sem correção que deixam de ser com Holm: ${perdem_significancia}`);

  const saturacao = calcularSaturacao(observacoes, niveis_por_condicao);
  fs.writeFileSync(path.join(pasta_base, 'saturacao.csv'), csv(['cenario', 'payload', 'runtime', 'rep', 'vus_saturacao', 'motivo', 'vus_erro_1pct'], saturacao.por_repeticao));
  fs.writeFileSync(path.join(pasta_base, 'saturacao_resumo.csv'), csv(
    ['cenario', 'payload', 'runtime', 'n_reps', 'n_nao_saturou', 'vus_min', 'vus_mediana', 'vus_max', 'motivos', 'vus_curva_media', 'motivo_curva_media',
      'vus_erro_1pct_min', 'vus_erro_1pct_mediana', 'vus_erro_1pct_max', 'vus_erro_1pct_curva_media'],
    saturacao.resumo,
  ));
  console.log(`Saturação: saturacao.csv (${saturacao.por_repeticao.length} execuções) e saturacao_resumo.csv (${saturacao.resumo.length} condições)`);

  const interacoes = calcularInteracoes(observacoes, payloads).map((linha) => ({
    ...linha,
    razao_de: arredondar(linha.razao_de), razao_para: arredondar(linha.razao_para),
    razao_para_sobre_de: arredondar(linha.razao_para_sobre_de), ic95_lo: arredondar(linha.ic95_lo), ic95_hi: arredondar(linha.ic95_hi),
    t: arredondar(linha.t, 3), df: arredondar(linha.df, 2), p: arredondar(linha.p),
  }));
  fs.writeFileSync(path.join(pasta_base, 'interacao.csv'), csv(
    ['tipo', 'comparacao', 'metrica', 'cenario', 'payload', 'vus', 'de', 'para', 'ref', 'alt', 'razao_de', 'razao_para',
      'razao_para_sobre_de', 'ic95_lo', 'ic95_hi', 't', 'df', 'p', 'p_holm', 'significativo_holm_5pct', 'efeito'],
    interacoes,
  ));
  console.log(`Interações: interacao.csv (${interacoes.length} contrastes; cenário A→B e entre payloads)`);

  const decomposicao = calcularDecomposicao(observacoes, payloads);
  fs.writeFileSync(path.join(pasta_base, 'decomposicao.csv'), csv(
    ['payload', 'vus', 'metrica', 'runtime', 'base_A', 'media_A', 'media_B', 'delta', 'delta_ic95_lo', 'delta_ic95_hi', 'delta_rel_pct', 'p'],
    decomposicao.deltas,
  ));
  fs.writeFileSync(path.join(pasta_base, 'decomposicao_comparacao.csv'), csv(
    ['payload', 'vus', 'metrica', 'comparacao', 'ref', 'alt', 'delta_alt_menos_delta_ref', 'ic95_lo', 'ic95_hi', 't', 'df', 'p', 'p_holm',
      'significativo_holm_5pct', 'efeito'],
    decomposicao.diferencas,
  ));
  console.log(`Decomposição B − A: decomposicao.csv (${decomposicao.deltas.length}) e decomposicao_comparacao.csv (${decomposicao.diferencas.length})`);
}

function carregarObservacoes(base) {
  pasta_base = path.resolve(base);
  const repeticoes = listarRepeticoes();
  const payloads = descobrirPayloads(repeticoes);
  return { repeticoes, payloads, ...coletarObservacoes(repeticoes, payloads) };
}

if (require.main === module) main();

module.exports = { carregarObservacoes, metricas_descritivas, pontoDeSaturacao, primeiroNivelComErro, contrasteDeRazoes, calcularSaturacao, calcularInteracoes, calcularDecomposicao, criterio_saturacao };
