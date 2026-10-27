const fs = require('fs');
const os = require('os');
const path = require('path');
const { falhar } = require('./util');

const raiz = path.resolve(__dirname, '..', '..');
const opcoes_sem_valor = ['force', 'dry-run', 'smoke', 'help', 'shuffle'];
const cenarios_validos = ['A', 'B'];
const runtimes_validos = ['node', 'bun', 'bunpg'];
const todas_apis = ['api-node-a', 'api-bun-a', 'api-node-b', 'api-bun-b', 'api-bun-pg-b'];

const ajuda = `
Uso: node scripts/rodar_matriz.js [opções]

Seleção (padrão: matriz completa, 15 rodadas)
  --scenarios A,B                 cenários a executar
  --payloads pequeno,medio,grande payloads a executar
  --runtimes node,bun,bunpg       runtimes a executar. bunpg é o Bun com o driver pg (controle do cenário B,
                                  separa o efeito do driver do efeito do runtime) e só roda no cenário B
  --shuffle                       sorteia a ordem dos runtimes dentro de cada bloco cenário × payload

Gerador de carga (k6)
  --gomemlimit <valor>            limita a memória do k6 (ex.: 5000MiB)
  --vus <lista>                   substitui os níveis de VU padrão (10,20,40,80,160,320,640,1280)

APIs
  --node-heap-mb <MiB>            limite de heap do V8 nas APIs Node (--max-old-space-size). Sem a opção,
                                  vale o padrão do Node, calculado a partir da memória do contêiner

Execução
  --out <diretório>               destino dos resultados (padrão: resultados/run-<host>-<data>).
                                  Reutilize o mesmo --out para retomar uma execução interrompida
  --cooldown <segundos>           descanso entre rodadas (padrão: 30)
  --force                         refaz rodadas cujos arquivos já existem em --out
  --dry-run                       só mostra o plano
  --smoke                         só verifica se as APIs sobem e respondem 201 (sem k6 e sem monitor)
  --help                          esta ajuda
`;

function lerArgumentos(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const argumento = argv[i];
    if (!argumento.startsWith('--')) throw new Error(`argumento inesperado: ${argumento}`);
    const nome = argumento.slice(2);
    if (opcoes_sem_valor.includes(nome)) {
      args[nome] = true;
      continue;
    }
    if (i + 1 >= argv.length) throw new Error(`falta valor para --${nome}`);
    args[nome] = argv[++i];
  }
  return args;
}

function lerDotEnv() {
  const arquivo = path.join(raiz, '.env');
  const variaveis = {};
  if (!fs.existsSync(arquivo)) return variaveis;
  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const par = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(linha);
    if (par && !linha.trim().startsWith('#')) variaveis[par[1]] = par[2].replace(/^['"]|['"]$/g, '');
  }
  return variaveis;
}

function carimboDeTempo() {
  const agora = new Date();
  const dois_digitos = (numero) => String(numero).padStart(2, '0');
  const data = `${agora.getFullYear()}${dois_digitos(agora.getMonth() + 1)}${dois_digitos(agora.getDate())}`;
  return `${data}-${dois_digitos(agora.getHours())}${dois_digitos(agora.getMinutes())}`;
}

const separarLista = (texto, padrao) => (texto ? texto.split(',').map((item) => item.trim()).filter(Boolean) : padrao);

function montarConfiguracao(args) {
  const dotenv = lerDotEnv();
  const lerVariavel = (chave, padrao) => process.env[chave] || dotenv[chave] || padrao;
  const pasta_payloads = path.join(raiz, 'payloads');

  const cenarios = separarLista(args.scenarios, ['A', 'B']).map((cenario) => cenario.toUpperCase());
  const payloads = separarLista(args.payloads, ['pequeno', 'medio', 'grande']);
  const runtimes = separarLista(args.runtimes, ['node', 'bun', 'bunpg']);
  for (const cenario of cenarios) if (!cenarios_validos.includes(cenario)) falhar(`cenário inválido: ${cenario}`);
  for (const payload of payloads) {
    if (!fs.existsSync(path.join(pasta_payloads, `payload_${payload}.json`))) falhar(`payload inexistente: ${payload}`);
  }
  for (const runtime of runtimes) if (!runtimes_validos.includes(runtime)) falhar(`runtime inválido: ${runtime}`);

  const pasta_saida = path.resolve(raiz, args.out || path.join('resultados', `run-${os.hostname().toLowerCase()}-${carimboDeTempo()}`));
  const node_heap_mb = args['node-heap-mb'] !== undefined ? Number(args['node-heap-mb']) : null;
  if (node_heap_mb !== null && !(Number.isInteger(node_heap_mb) && node_heap_mb > 0)) falhar('--node-heap-mb deve ser um inteiro positivo (MiB)');
  const env_compose = { ...process.env, RESULTS_DIR: pasta_saida, NODE_OPTIONS_API: node_heap_mb ? `--max-old-space-size=${node_heap_mb}` : '' };
  if (typeof process.getuid === 'function') {
    env_compose.K6_UID = String(process.getuid());
    env_compose.K6_GID = String(process.getgid());
  }

  const servico = (nome, porta_interna, variavel_porta) => ({
    nome,
    porta_interna,
    porta_host: Number(lerVariavel(variavel_porta, String(porta_interna))),
  });

  return {
    raiz,
    arquivo_compose: path.join(raiz, 'docker-compose.yml'),
    pasta_payloads,
    pasta_saida,
    coletor: path.join(raiz, 'monitor', 'coletor_status.js'),
    sql_inicial: path.join(raiz, 'init.sql'),
    cenarios,
    payloads,
    runtimes,
    shuffle: Boolean(args.shuffle),
    forcar: Boolean(args.force),
    gomemlimit: args.gomemlimit || null,
    vus: args.vus || null,
    node_heap_mb,
    cooldown_s: args.cooldown !== undefined ? Number(args.cooldown) : 30,
    banco: lerVariavel('POSTGRES_DB', 'benchmark'),
    versoes: {
      node: lerVariavel('NODE_VERSION', '24.21.0'),
      bun: lerVariavel('BUN_VERSION', '1.4.2'),
      postgres: lerVariavel('POSTGRES_VERSION', '16.13'),
      k6: lerVariavel('K6_VERSION', '2.3.0'),
    },
    servicos: {
      A: {
        node: servico('api-node-a', 3011, 'API_NODE_A_HOST_PORT'),
        bun: servico('api-bun-a', 3012, 'API_BUN_A_HOST_PORT'),
      },
      B: {
        node: servico('api-node-b', 3001, 'API_NODE_B_HOST_PORT'),
        bun: servico('api-bun-b', 3002, 'API_BUN_B_HOST_PORT'),
        bunpg: servico('api-bun-pg-b', 3003, 'API_BUN_PG_B_HOST_PORT'),
      },
    },
    todas_apis,
    env_compose,
  };
}

module.exports = { ajuda, lerArgumentos, montarConfiguracao };
