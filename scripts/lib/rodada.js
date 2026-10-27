const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { dormir, registrar } = require('./util');
const { compose, docker, subirApi, truncarTabelas } = require('./docker');

const container_k6 = 'k6-bench';
const container_postgres = 'pg-teste';
const script_k6 = 'teste_rampa.js';

let sentinela_ativa = null;

function montarRodada(cfg, cenario, payload, runtime) {
  const nome = `cenario${cenario}_${runtime}_${payload}`;
  const pasta = path.join(cfg.pasta_saida, runtime);
  return {
    cenario,
    payload,
    runtime,
    nome,
    servico: cfg.servicos[cenario][runtime],
    resultado: path.join(pasta, `resultado_${nome}.json`),
    stats: path.join(pasta, `stats_${nome}.json`),
    stats_k6: path.join(pasta, `stats_k6_${nome}.json`),
    stats_postgres: path.join(pasta, `stats_pg_${nome}.json`),
  };
}

function jaFoiExecutada(rodada) {
  return fs.existsSync(rodada.resultado) && fs.existsSync(rodada.stats);
}

function encerrarMonitores() {
  if (!sentinela_ativa) return;
  fs.writeFileSync(sentinela_ativa, '');
  sentinela_ativa = null;
}

function iniciarMonitores(cfg, rodada, sentinela, arquivo_log) {
  const alvos = [
    [rodada.servico.nome, rodada.stats],
    [container_k6, rodada.stats_k6],
  ];
  if (rodada.cenario === 'B') alvos.push([container_postgres, rodada.stats_postgres]);
  const processos = alvos.map(([container, saida]) => spawn(
    process.execPath,
    [cfg.coletor, container, saida, sentinela],
    { stdio: ['ignore', arquivo_log, arquivo_log] },
  ));
  return Promise.all(processos.map((processo) => new Promise((resolver) => processo.on('exit', resolver))));
}

function montarComandoK6(cfg, rodada) {
  const variaveis = [
    `TARGET=http://${rodada.servico.nome}:${rodada.servico.porta_interna}/produtos`,
    `PAYLOAD=/payloads/payload_${rodada.payload}.json`,
    `OUT_FILE=/resultados/${rodada.runtime}/resultado_${rodada.nome}.json`,
  ];
  if (cfg.gomemlimit) variaveis.push(`GOMEMLIMIT=${cfg.gomemlimit}`);
  if (cfg.vus) variaveis.push(`VUS=${cfg.vus}`);
  return [
    'compose', '-f', cfg.arquivo_compose, '--project-directory', cfg.raiz,
    'run', '--rm', '--no-deps', '-T', '--name', container_k6,
    ...variaveis.flatMap((variavel) => ['-e', variavel]),
    'k6', 'run', `/k6/${script_k6}`,
  ];
}

function limiteDeHeapNode(container) {
  if (!container.startsWith('api-node')) return null;
  const resposta = docker(['exec', container, 'node', '-e', "console.log(require('v8').getHeapStatistics().heap_size_limit)"]);
  const bytes = Number((resposta.stdout || '').trim());
  return resposta.status === 0 && bytes > 0 ? Math.round(bytes / 2 ** 20) : null;
}

async function executarRodada(cfg, rodada) {
  const pasta_logs = path.join(cfg.pasta_saida, 'logs');
  fs.mkdirSync(path.join(cfg.pasta_saida, rodada.runtime), { recursive: true });
  fs.mkdirSync(pasta_logs, { recursive: true });
  const inicio = new Date();
  const detalhe_gomemlimit = cfg.gomemlimit ? `, GOMEMLIMIT=${cfg.gomemlimit}` : '';
  const detalhe_vus = cfg.vus ? `, VUS=${cfg.vus}` : '';
  registrar(`--- RODADA ${rodada.nome} (${rodada.servico.nome}, script=${script_k6}${detalhe_gomemlimit}${detalhe_vus})`);

  await subirApi(cfg, rodada.cenario, rodada.servico);
  const heap_limite_mb = limiteDeHeapNode(rodada.servico.nome);
  if (heap_limite_mb !== null) registrar(`limite de heap do V8 na API: ${heap_limite_mb} MiB`);

  const sentinela = path.join(pasta_logs, `stop_${rodada.nome}`);
  fs.rmSync(sentinela, { force: true });
  sentinela_ativa = sentinela;
  const log_monitor = fs.openSync(path.join(pasta_logs, `monitor_${rodada.nome}.log`), 'w');
  const monitores_encerrados = iniciarMonitores(cfg, rodada, sentinela, log_monitor);
  await dormir(2000);

  registrar('k6 iniciado');
  const log_k6 = fs.openSync(path.join(pasta_logs, `k6_${rodada.nome}.log`), 'w');
  const processo_k6 = spawn('docker', montarComandoK6(cfg, rodada), { stdio: ['ignore', log_k6, log_k6], env: cfg.env_compose });
  const k6_exit = await new Promise((resolver) => processo_k6.on('exit', resolver));
  registrar(`k6 terminou (exit=${k6_exit})`);

  encerrarMonitores();
  await monitores_encerrados;
  fs.rmSync(sentinela, { force: true });

  const estado_api = docker([
    'inspect', '-f',
    'OOMKilled={{.State.OOMKilled}} Status={{.State.Status}} ExitCode={{.State.ExitCode}} Restarts={{.RestartCount}}',
    rodada.servico.nome,
  ]).stdout.trim();
  registrar(`estado da API: ${estado_api}`);
  const logs_api = docker(['logs', '--tail', '300', rodada.servico.nome]);
  fs.writeFileSync(path.join(pasta_logs, `api_${rodada.nome}.log`), `${logs_api.stdout || ''}\n${logs_api.stderr || ''}`);

  const tem_resultado = fs.existsSync(rodada.resultado);
  const tem_stats = fs.existsSync(rodada.stats) && fs.existsSync(rodada.stats_k6) && (rodada.cenario !== 'B' || fs.existsSync(rodada.stats_postgres));
  if (!tem_resultado) registrar(`AVISO: ${path.basename(rodada.resultado)} NÃO gerado`);
  if (!tem_stats) registrar(`AVISO: stats (API/k6/Postgres) de ${rodada.nome} incompletos`);
  if (tem_resultado && tem_stats) registrar('resultado e stats gravados');

  if (rodada.cenario === 'B') truncarTabelas(cfg);
  compose(cfg, ['stop', rodada.servico.nome]);

  return {
    rodada: rodada.nome,
    script: script_k6,
    gomemlimit: cfg.gomemlimit,
    k6Exit: k6_exit,
    resultado: tem_resultado,
    stats: tem_stats,
    apiEstado: estado_api,
    heapLimiteMb: heap_limite_mb,
    ok: k6_exit === 0 && tem_resultado && tem_stats,
    inicio: inicio.toISOString(),
    fim: new Date().toISOString(),
  };
}

module.exports = { script_k6, montarRodada, jaFoiExecutada, executarRodada, encerrarMonitores };
