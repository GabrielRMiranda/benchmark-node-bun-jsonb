const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dormir, registrar, falhar } = require('./util');

function compose(cfg, argv, opcoes = {}) {
  return spawnSync('docker', ['compose', '-f', cfg.arquivo_compose, '--project-directory', cfg.raiz, ...argv], {
    encoding: 'utf8',
    env: cfg.env_compose,
    ...opcoes,
  });
}

function composeOk(cfg, argv, opcoes) {
  const resposta = compose(cfg, argv, opcoes);
  if (resposta.status !== 0) {
    const detalhe = (resposta.stderr || resposta.stdout || '').trim();
    throw new Error(`docker compose ${argv.join(' ')} falhou (exit ${resposta.status}): ${detalhe}`);
  }
  return resposta;
}

function docker(argv, opcoes = {}) {
  return spawnSync('docker', argv, { encoding: 'utf8', ...opcoes });
}

function pararApis(cfg) {
  return compose(cfg, ['stop', ...cfg.todas_apis]);
}

function verificarDocker(cfg) {
  const versao_node = Number(process.versions.node.split('.')[0]);
  if (versao_node < 18) falhar(`Node >= 18 é necessário (encontrado ${process.versions.node})`);

  const versao_docker = docker(['version', '--format', '{{.Server.Version}}']);
  if (versao_docker.error || versao_docker.status !== 0) falhar('Docker não encontrado ou daemon parado. Inicie o Docker e tente novamente.');
  const versao_compose = compose(cfg, ['version', '--short']);
  if (versao_compose.status !== 0) falhar('Docker Compose v2 não encontrado (`docker compose version`).');

  let memoria = null;
  let processadores = null;
  try {
    const informacoes = JSON.parse(docker(['info', '--format', '{{json .}}']).stdout);
    memoria = informacoes.MemTotal;
    processadores = informacoes.NCPU;
  } catch (_) { }

  const memoria_gib = memoria ? (memoria / 2 ** 30).toFixed(1) : '?';
  registrar(`Docker ${versao_docker.stdout.trim()} | Compose ${versao_compose.stdout.trim()} | VM do Docker: ${processadores ?? '?'} CPUs, ${memoria_gib} GiB`);
  if (memoria && memoria < 8 * 2 ** 30 && cfg.payloads.includes('grande') && !cfg.gomemlimit) {
    registrar('AVISO: a VM do Docker tem menos de 8 GiB. Com payload grande e 1280 VUs o k6 pode ser morto por falta de memória (exit 137).');
    registrar('       Aumente a memória do Docker/WSL ou use --gomemlimit 3500MiB.');
  }
  return { memoria, processadores, versao_docker: versao_docker.stdout.trim(), versao_compose: versao_compose.stdout.trim() };
}

function consultarBanco(cfg, argv_psql, opcoes) {
  return composeOk(cfg, ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', cfg.banco, ...argv_psql], opcoes);
}

function criarSchema(cfg) {
  consultarBanco(cfg, ['-v', 'ON_ERROR_STOP=1', '-q'], { input: fs.readFileSync(cfg.sql_inicial, 'utf8') });
}

// Confere se o documento foi gravado como objeto JSONB (e não como string JSON).
// Motivo: o Bun.sql grava como string JSON qualquer string passada a um parâmetro jsonb.
function verificarTipoGravado(cfg, servico) {
  const resposta = consultarBanco(cfg, ['-tAc',
    "SELECT coalesce(string_agg(DISTINCT jsonb_typeof(dados), ','), 'vazio') FROM (SELECT dados FROM produtos_node UNION ALL SELECT dados FROM produtos_bun) t;"]);
  const tipos = (resposta.stdout || '').trim();
  if (tipos !== 'object') throw new Error(`${servico.nome}: documento gravado como "${tipos}" (esperado "object")`);
  registrar(`OK   ${servico.nome}: documento gravado como objeto JSONB`);
}

function truncarTabelas(cfg) {
  consultarBanco(cfg, ['-qc', 'TRUNCATE produtos_node, produtos_bun RESTART IDENTITY;']);
}

async function aguardarApi(porta_host, limite_ms = 60000) {
  const fim = Date.now() + limite_ms;
  while (Date.now() < fim) {
    try {
      const resposta = await fetch(`http://localhost:${porta_host}/produtos`);
      if (resposta.status === 404) return true;
    } catch (_) { }
    await dormir(1000);
  }
  return false;
}

async function enviarPostDeTeste(cfg, porta_host) {
  const corpo = fs.readFileSync(path.join(cfg.pasta_payloads, 'payload_pequeno.json'));
  try {
    const resposta = await fetch(`http://localhost:${porta_host}/produtos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: corpo,
    });
    return resposta.status;
  } catch (erro) {
    return `erro: ${erro.message}`;
  }
}

async function subirApi(cfg, cenario, servico) {
  pararApis(cfg);
  if (cenario === 'B') {
    composeOk(cfg, ['up', '-d', '--wait', 'postgres']);
    criarSchema(cfg);
    truncarTabelas(cfg);
  }
  composeOk(cfg, ['up', '-d', '--force-recreate', '--no-deps', servico.nome]);
  if (!(await aguardarApi(servico.porta_host))) throw new Error(`${servico.nome} não respondeu em 60 s`);
  const status = await enviarPostDeTeste(cfg, servico.porta_host);
  if (status !== 201) throw new Error(`POST de teste em ${servico.nome} retornou ${status} (esperado 201)`);
  if (cenario === 'B') {
    verificarTipoGravado(cfg, servico);
    truncarTabelas(cfg);
  }
}

function versaoNaImagem(imagem, entrypoint, argv) {
  const resposta = docker(['run', '--rm', '--entrypoint', entrypoint, imagem, ...argv]);
  return resposta.status === 0 ? resposta.stdout.trim().split('\n')[0] : null;
}

function registrarAmbiente(cfg, info_docker) {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: cfg.raiz, encoding: 'utf8' });
  const versoes = cfg.versoes;
  const ambiente = {
    data: new Date().toISOString(),
    host: {
      nome: os.hostname(),
      so: `${os.type()} ${os.release()}`,
      cpus: os.cpus().length,
      modeloCpu: os.cpus()[0]?.model,
      memoriaGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
    },
    docker: {
      versao: info_docker.versao_docker,
      compose: info_docker.versao_compose,
      vmCpus: info_docker.processadores,
      vmMemoriaGiB: info_docker.memoria ? +(info_docker.memoria / 2 ** 30).toFixed(2) : null,
    },
    nodeDoRunner: process.version,
    versoesConfiguradas: versoes,
    versoesNasImagens: {
      node: versaoNaImagem(`tcc-benchmark/api-node:${versoes.node}`, 'node', ['-v']),
      bun: versaoNaImagem(`tcc-benchmark/api-bun:${versoes.bun}`, 'bun', ['--version']),
      k6: versaoNaImagem(`grafana/k6:${versoes.k6}`, 'k6', ['version']),
      postgres: versaoNaImagem(`postgres:${versoes.postgres}-alpine`, 'postgres', ['--version']),
    },
    gitCommit: commit.status === 0 ? commit.stdout.trim() : null,
    parametros: {
      shuffle: cfg.shuffle,
      vus: cfg.vus,
      scenarios: cfg.cenarios,
      payloads: cfg.payloads,
      runtimes: cfg.runtimes,
      gomemlimit: cfg.gomemlimit,
      cooldownS: cfg.cooldown_s,
      nodeHeapMb: cfg.node_heap_mb,
    },
  };
  fs.writeFileSync(path.join(cfg.pasta_saida, 'ambiente.json'), JSON.stringify(ambiente, null, 2));
}

module.exports = { compose, composeOk, docker, pararApis, verificarDocker, truncarTabelas, aguardarApi, subirApi, registrarAmbiente };
