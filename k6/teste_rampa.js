import http from 'k6/http';
import exec from 'k6/execution';
import { Trend, Rate, Counter } from 'k6/metrics';

const niveis_vus = __ENV.VUS
  ? __ENV.VUS.split(',').map((valor) => Number(valor.trim())).filter((valor) => Number.isFinite(valor) && valor > 0)
  : [10, 20, 40, 80, 160, 320, 640, 1280];
const segundos_rampa = 10;
const segundos_sustentacao = 30;
const classes_resposta = ['ok', 'timeout', 'conexao', 'http_4xx', 'http_5xx'];

const estagios = niveis_vus.flatMap((alvo) => [
  { segundos: segundos_rampa, alvo, nome: `ramp_${alvo}` },
  { segundos: segundos_sustentacao, alvo, nome: `sustain_${alvo}` },
]);

let acumulado_ms = 0;
const fim_de_cada_estagio_ms = estagios.map((estagio) => (acumulado_ms += estagio.segundos * 1000));

const metricas_por_estagio = {};

for (const estagio of estagios) {
  const contadores = {};

  for (const classe of classes_resposta) contadores[classe] = new Counter(`resp_${classe}_${estagio.nome}`);
  metricas_por_estagio[estagio.nome] = {
    latencia: new Trend(`latencia_${estagio.nome}`, true),
    latencia_ok: new Trend(`latencia_ok_${estagio.nome}`, true),
    tempo_total: new Trend(`tempo_total_${estagio.nome}`, true),
    erros: new Rate(`erros_${estagio.nome}`),
    contadores,
  };
}

export const options = {
  stages: estagios.map(({ segundos, alvo }) => ({ duration: `${segundos}s`, target: alvo })),
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

const alvo_http = __ENV.TARGET || 'http://api-node-a:3011/produtos';
const arquivo_saida = __ENV.OUT_FILE || '/resultados/resumo.json';
const corpo = open(__ENV.PAYLOAD || '/payloads/payload_pequeno.json', 'b');

function nomeDoEstagioAtual() {
  const decorrido_ms = exec.instance.currentTestRunDuration;
  const posicao = fim_de_cada_estagio_ms.findIndex((fim) => decorrido_ms < fim);
  return estagios[posicao === -1 ? estagios.length - 1 : posicao].nome;
}

function classificarResposta(resposta) {
  if (resposta.status === 201) return 'ok';
  if (resposta.status === 0) return resposta.error_code === 1050 ? 'timeout' : 'conexao';
  return resposta.status >= 500 ? 'http_5xx' : 'http_4xx';
}

export default function () {
  const estagio = nomeDoEstagioAtual();
  const resposta = http.post(alvo_http, corpo, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '10s',
    tags: { stage: estagio },
  });
  const metricas = metricas_por_estagio[estagio];
  const classe = classificarResposta(resposta);
  const tempos = resposta.timings;
  metricas.latencia.add(tempos.duration);
  metricas.tempo_total.add(tempos.blocked + tempos.connecting + tempos.tls_handshaking + tempos.duration);
  if (classe === 'ok') metricas.latencia_ok.add(tempos.duration);
  metricas.erros.add(classe !== 'ok');
  metricas.contadores[classe].add(1);
}

export function handleSummary(dados) {
  const resultado = {
    ...dados.metrics,
    _meta: {
      inicio_epoch_ms: Date.now() - dados.state.testRunDurationMs,
      duracao_ms: dados.state.testRunDurationMs,
      vu_levels: niveis_vus,
      ramp_s: segundos_rampa,
      sustain_s: segundos_sustentacao,
    },
  };
  return { [arquivo_saida]: JSON.stringify(resultado, null, 2) };
}
