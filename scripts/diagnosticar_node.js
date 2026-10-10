const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { dormir, registrar, falhar } = require('./lib/util');
const { compose, pararApis, aguardarApi } = require('./lib/docker');

const raiz = path.resolve(__dirname, '..');
const classes_resposta = ['ok', 'timeout', 'conexao', 'http_4xx', 'http_5xx'];
const timeouts_altos = { SERVER_KEEPALIVE_MS: '65000', SERVER_HEADERS_MS: '70000', SERVER_REQUEST_MS: '0' };

const variantes = [
  { nome: 'padrao_sem_diag', servico: 'api-node-a', porta: 3011, env: {} },
  { nome: 'padrao', servico: 'api-node-a', porta: 3011, env: { DIAGNOSTICO: '1' } },
  { nome: 'timeouts_altos', servico: 'api-node-a', porta: 3011, env: { DIAGNOSTICO: '1', ...timeouts_altos } },
  { nome: 'corpo_buffer', servico: 'api-node-a', porta: 3011, env: { DIAGNOSTICO: '1', SERVER_BODY_MODE: 'buffer' } },
  { nome: 'timeouts_altos_corpo_buffer', servico: 'api-node-a', porta: 3011, env: { DIAGNOSTICO: '1', SERVER_BODY_MODE: 'buffer', ...timeouts_altos } },
  { nome: 'bun_referencia', servico: 'api-bun-a', porta: 3012, env: {} },
];

const ajuda = `
Uso: node scripts/diagnosticar_node.js [opções]

  --payload <nome>        pequeno, medio ou grande (padrão: grande)
  --vus <lista>           níveis de VU do k6 (padrão: 160,320)
  --variantes <lista>     subconjunto de variantes separadas por vírgula (padrão: todas)
  --out <diretório>       destino (padrão: resultados/diagnostico-node-<data>)
  --gomemlimit <valor>    GOMEMLIMIT do k6
  --help                  esta ajuda

Variantes: ${variantes.map((variante) => variante.nome).join(', ')}
`;

function lerArgumentos(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const argumento = argv[i];
    if (argumento === '--help') {
      args.help = true;
      continue;
    }
    if (!argumento.startsWith('--')) throw new Error(`argumento inesperado: ${argumento}`);
    if (i + 1 >= argv.length) throw new Error(`falta valor para ${argumento}`);
    args[argumento.slice(2)] = argv[++i];
  }
  return args;
}

function contarClasses(resultado, vus) {
  const contagens = {};
  for (const classe of classes_resposta) contagens[classe] = resultado[`resp_${classe}_sustain_${vus}`]?.values.count ?? 0;
  const total = Object.values(contagens).reduce((soma, valor) => soma + valor, 0);
  return { ...contagens, total, erro_pct: total ? +(((total - contagens.ok) / total) * 100).toFixed(2) : null };
}

function ultimaLinhaDeDiagnostico(texto) {
  const linhas = texto.split('\n').filter((linha) => linha.startsWith('{') && linha.includes('"conexoes_total"'));
  if (!linhas.length) return null;
  try {
    return JSON.parse(linhas[linhas.length - 1]);
  } catch (_) {
    return null;
  }
}

async function executarVariante(cfg, variante, payload, vus, gomemlimit) {
  registrar(`--- variante ${variante.nome} (${variante.servico})`);
  const env_da_variante = { env: { ...cfg.env_compose, ...variante.env } };
  pararApis(cfg);
  const subida = compose(cfg, ['up', '-d', '--force-recreate', '--no-deps', variante.servico], env_da_variante);
  if (subida.status !== 0) throw new Error(`falha ao subir ${variante.servico}: ${subida.stderr}`);
  if (!(await aguardarApi(variante.porta))) throw new Error(`${variante.servico} não respondeu`);

  const pasta = path.join(cfg.pasta_saida, variante.nome);
  fs.mkdirSync(pasta, { recursive: true });
  const variaveis = [
    `TARGET=http://${variante.servico}:${variante.porta}/produtos`,
    `PAYLOAD=/payloads/payload_${payload}.json`,
    `OUT_FILE=/resultados/${variante.nome}/resultado.json`,
    `VUS=${vus}`,
  ];
  if (gomemlimit) variaveis.push(`GOMEMLIMIT=${gomemlimit}`);
  const k6 = compose(cfg, [
    'run', '--rm', '--no-deps', '-T',
    ...variaveis.flatMap((variavel) => ['-e', variavel]),
    'k6', 'run', '/k6/teste_rampa.js',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(pasta, 'k6.log'), `${k6.stdout}\n${k6.stderr}`);

  const logs = spawnSync('docker', ['logs', variante.servico], { encoding: 'utf8' });
  const texto_dos_logs = `${logs.stdout}\n${logs.stderr}`;
  fs.writeFileSync(path.join(pasta, 'servidor.log'), texto_dos_logs);

  const estado = spawnSync('docker', ['inspect', '-f', 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}', variante.servico], { encoding: 'utf8' }).stdout.trim();
  const arquivo_resultado = path.join(pasta, 'resultado.json');
  let por_nivel = null;
  if (fs.existsSync(arquivo_resultado)) {
    const resultado = JSON.parse(fs.readFileSync(arquivo_resultado, 'utf8'));
    por_nivel = {};
    for (const nivel of vus.split(',').map(Number)) por_nivel[nivel] = contarClasses(resultado, nivel);
  }
  compose(cfg, ['stop', variante.servico]);
  return { variante: variante.nome, k6Exit: k6.status, estado, porNivel: por_nivel, servidor: ultimaLinhaDeDiagnostico(texto_dos_logs) };
}

function mostrarResumo(resumo) {
  console.log('\n=== RESUMO (patamar sustentado) ===');
  for (const entrada of resumo) {
    console.log(`\n${entrada.variante}  k6Exit=${entrada.k6Exit ?? '-'}  ${entrada.estado ?? ''}${entrada.erro ? `  ERRO: ${entrada.erro}` : ''}`);
    for (const [nivel, c] of Object.entries(entrada.porNivel || {})) {
      console.log(`  ${String(nivel).padStart(5)} VUs  total=${c.total}  ok=${c.ok}  timeout=${c.timeout}  conexao=${c.conexao}  4xx=${c.http_4xx}  5xx=${c.http_5xx}  erro=${c.erro_pct}%`);
    }
    const s = entrada.servidor;
    if (s) {
      console.log(`  servidor: conexoes_total=${s.conexoes_total} client_error=${JSON.stringify(s.client_error)} socket_error=${JSON.stringify(s.socket_error)} status=${JSON.stringify(s.status)} abortadas=${s.abortadas} progresso_abortadas=${JSON.stringify(s.abortadas_por_progresso)} leitura_corpo_ms=${JSON.stringify(s.leitura_corpo_ms)}`);
    }
  }
}

async function main() {
  let args;
  try {
    args = lerArgumentos(process.argv.slice(2));
  } catch (erro) {
    console.error(`Erro: ${erro.message}\n${ajuda}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(ajuda);
    return;
  }

  const payload = args.payload || 'grande';
  const vus = args.vus || '160,320';
  const carimbo = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const pasta_saida = path.resolve(raiz, args.out || path.join('resultados', `diagnostico-node-${carimbo}`));
  const escolhidas = args.variantes ? args.variantes.split(',').map((nome) => nome.trim()) : variantes.map((variante) => variante.nome);
  const plano = variantes.filter((variante) => escolhidas.includes(variante.nome));
  if (!plano.length) falhar('nenhuma variante válida');
  if (!fs.existsSync(path.join(raiz, 'payloads', `payload_${payload}.json`))) falhar(`payload inexistente: ${payload}`);

  const cfg = {
    raiz,
    pasta_saida,
    arquivo_compose: path.join(raiz, 'docker-compose.yml'),
    env_compose: { ...process.env, RESULTS_DIR: pasta_saida },
    todas_apis: ['api-node-a', 'api-bun-a', 'api-node-b', 'api-bun-b', 'api-bun-pg-b'],
  };
  fs.mkdirSync(pasta_saida, { recursive: true });
  registrar(`Saída: ${pasta_saida} | payload=${payload} | vus=${vus}`);
  const build = compose(cfg, ['build']);
  if (build.status !== 0) {
    console.error(build.stderr);
    process.exit(1);
  }

  const resumo = [];
  for (const variante of plano) {
    try {
      resumo.push(await executarVariante(cfg, variante, payload, vus, args.gomemlimit));
    } catch (erro) {
      registrar(`ERRO em ${variante.nome}: ${erro.message}`);
      resumo.push({ variante: variante.nome, erro: erro.message });
    }
    fs.writeFileSync(path.join(pasta_saida, 'resumo.json'), JSON.stringify(resumo, null, 2));
    await dormir(15000);
  }
  compose(cfg, ['down']);
  mostrarResumo(resumo);
  console.log(`\nResultados em ${pasta_saida}`);
}

main();
