const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { registrar, falhar } = require('./lib/util');

const raiz = path.resolve(__dirname, '..');
const script_matriz = path.join(raiz, 'scripts', 'rodar_matriz.js');

const ajuda = `
Uso: node scripts/rodar_repeticoes.js --out-base <pasta> [--n <repeticoes>] [--parar-em-erro] [opções de rodar_matriz.js]

  --out-base <pasta>    pasta base; cada repetição vai para <pasta>/rep01, rep02, ...
  --n <inteiro>         quantidade de repetições da matriz completa (padrão: 10)
  --parar-em-erro       para tudo se uma repetição falhar (padrão: segue para a próxima e registra a falha)
  --help                esta ajuda

Qualquer outra opção é repassada a cada chamada de rodar_matriz.js
(--gomemlimit, --scenarios, --payloads, --runtimes, --cooldown, --vus, --shuffle, --force).

Exemplo:
  node scripts/rodar_repeticoes.js --n 10 --out-base resultados/final --gomemlimit 5000MiB --shuffle
`;

function lerArgumentos(argv) {
  const args = { n: 10, base: null, parar_em_erro: false, repassados: [] };
  for (let i = 0; i < argv.length; i++) {
    const argumento = argv[i];
    if (argumento === '--n') args.n = Number(argv[++i]);
    else if (argumento === '--out-base') args.base = argv[++i];
    else if (argumento === '--parar-em-erro') args.parar_em_erro = true;
    else if (argumento === '--help') {
      console.log(ajuda);
      process.exit(0);
    } else if (argumento === '--out') falhar('use --out-base (não --out): cada repetição recebe a sua própria subpasta.');
    else args.repassados.push(argumento);
  }
  if (!args.base) falhar(`--out-base é obrigatório (ex.: --out-base resultados/final)\n${ajuda}`);
  if (!Number.isInteger(args.n) || args.n < 1) falhar('--n deve ser um inteiro >= 1');
  return args;
}

function executarRepeticao(args, numero) {
  const etiqueta = `rep${String(numero).padStart(2, '0')}`;
  const pasta_relativa = path.join(args.base, etiqueta);
  registrar(`=== Repetição ${numero}/${args.n} (${etiqueta}) → ${pasta_relativa} ===`);
  const inicio = new Date();
  const resposta = spawnSync('node', [script_matriz, '--out', pasta_relativa, ...args.repassados], { stdio: 'inherit', cwd: raiz });
  const fim = new Date();
  const entrada = {
    rep: numero,
    tag: etiqueta,
    outDir: pasta_relativa,
    exitCode: resposta.status,
    ok: resposta.status === 0,
    inicio: inicio.toISOString(),
    fim: fim.toISOString(),
    duracaoMin: +((fim - inicio) / 60000).toFixed(1),
  };
  registrar(`--- ${etiqueta}: ${entrada.ok ? 'OK' : `FALHOU (exit=${resposta.status})`} em ${entrada.duracaoMin} min`);
  return entrada;
}

function main() {
  const args = lerArgumentos(process.argv.slice(2));
  const pasta_base = path.resolve(raiz, args.base);
  fs.mkdirSync(pasta_base, { recursive: true });
  const arquivo_resumo = path.join(pasta_base, 'resumo-repeticoes.json');
  let resumo = fs.existsSync(arquivo_resumo) ? JSON.parse(fs.readFileSync(arquivo_resumo, 'utf8')) : [];

  const inicio_geral = new Date();
  registrar(`Iniciando ${args.n} repetições em ${pasta_base}`);

  for (let numero = 1; numero <= args.n; numero++) {
    const etiqueta = `rep${String(numero).padStart(2, '0')}`;
    const marcador = path.join(pasta_base, etiqueta, '.completo');
    if (fs.existsSync(marcador)) {
      registrar(`=== ${etiqueta}: já concluída (marcador .completo encontrado), pulando ===`);
      continue;
    }

    const entrada = executarRepeticao(args, numero);
    resumo = resumo.filter((existente) => existente.tag !== etiqueta).concat(entrada).sort((a, b) => a.rep - b.rep);
    fs.writeFileSync(arquivo_resumo, JSON.stringify(resumo, null, 2));

    if (entrada.ok) fs.writeFileSync(marcador, entrada.fim);
    else if (args.parar_em_erro) {
      registrar('Parando por causa de --parar-em-erro. Rode o mesmo comando de novo depois de investigar para retomar.');
      process.exit(1);
    } else registrar(`AVISO: ${etiqueta} falhou, mas seguindo para a próxima repetição (sem --parar-em-erro).`);
  }

  const falhas = resumo.filter((entrada) => !entrada.ok).length;
  const horas = ((new Date() - inicio_geral) / 3600000).toFixed(1);
  registrar(`\n=== FIM: ${resumo.length - falhas}/${resumo.length} repetições OK, total ${horas}h nesta execução ===`);
  registrar(`Resumo salvo em ${arquivo_resumo}`);
  process.exit(falhas ? 1 : 0);
}

main();
