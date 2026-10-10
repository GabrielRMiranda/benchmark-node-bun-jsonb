const fs = require('fs');
const path = require('path');
const { dormir, registrar } = require('./lib/util');
const { ajuda, lerArgumentos, montarConfiguracao } = require('./lib/configuracao');
const { compose, composeOk, pararApis, verificarDocker, subirApi, registrarAmbiente } = require('./lib/docker');
const { script_k6, montarRodada, jaFoiExecutada, executarRodada, encerrarMonitores } = require('./lib/rodada');

let args;
try {
  args = lerArgumentos(process.argv.slice(2));
} catch (erro) {
  console.error(`Erro: ${erro.message}\n${ajuda}`);
  process.exit(2);
}
if (args.help) {
  console.log(ajuda);
  process.exit(0);
}
const cfg = montarConfiguracao(args);
const arquivo_manifesto = path.join(cfg.pasta_saida, 'execucao.json');

const embaralhar = (itens) => itens.map((item) => [Math.random(), item]).sort((a, b) => a[0] - b[0]).map(([, item]) => item);

function montarPlano() {
  const rodadas = [];
  for (const cenario of cfg.cenarios) {
    for (const payload of cfg.payloads) {
      const runtimes = cfg.runtimes.filter((runtime) => cfg.servicos[cenario][runtime]);
      for (const runtime of cfg.shuffle ? embaralhar(runtimes) : runtimes) {
        rodadas.push(montarRodada(cfg, cenario, payload, runtime));
      }
    }
  }
  return rodadas;
}

function mostrarPlano(rodadas) {
  console.log(`Saída: ${cfg.pasta_saida}\ncooldown: ${cfg.cooldown_s}s\n`);
  const detalhe_gomemlimit = cfg.gomemlimit ? `  GOMEMLIMIT=${cfg.gomemlimit}` : '';
  for (const rodada of rodadas) console.log(`${rodada.nome.padEnd(28)} ${script_k6}${detalhe_gomemlimit}`);
}

async function verificarApis() {
  registrar('Smoke test: build e verificação de cada API (sem k6)');
  composeOk(cfg, ['build']);
  let falhas = 0;
  for (const cenario of cfg.cenarios) {
    for (const runtime of cfg.runtimes.filter((nome) => cfg.servicos[cenario][nome])) {
      const servico = cfg.servicos[cenario][runtime];
      try {
        await subirApi(cfg, cenario, servico);
        registrar(`OK   ${servico.nome}: POST /produtos -> 201`);
      } catch (erro) {
        falhas++;
        registrar(`FALHA ${servico.nome}: ${erro.message}`);
      }
    }
  }
  compose(cfg, ['down']);
  return falhas;
}

function lerManifesto() {
  return fs.existsSync(arquivo_manifesto) ? JSON.parse(fs.readFileSync(arquivo_manifesto, 'utf8')) : [];
}

function registrarNoManifesto(entrada) {
  const entradas = lerManifesto();
  const posicao = entradas.findIndex((existente) => existente.rodada === entrada.rodada);
  if (posicao >= 0) entradas[posicao] = entrada;
  else entradas.push(entrada);
  fs.writeFileSync(arquivo_manifesto, JSON.stringify(entradas, null, 2));
}

async function executarComTratamentoDeErro(rodada) {
  try {
    return await executarRodada(cfg, rodada);
  } catch (erro) {
    registrar(`ERRO em ${rodada.nome}: ${erro.message}`);
    encerrarMonitores();
    pararApis(cfg);
    return { rodada: rodada.nome, ok: false, erro: erro.message };
  }
}

function mostrarResumo(entradas) {
  console.log('\n=== RESUMO ===');
  for (const entrada of entradas) {
    const marca = entrada.ok ? 'OK   ' : 'FALHA';
    const pulada = entrada.pulada ? ' (pulada)' : '';
    const saida_k6 = entrada.k6Exit ? ` (k6 exit=${entrada.k6Exit})` : '';
    const erro = entrada.erro ? ` - ${entrada.erro}` : '';
    console.log(`${marca} ${entrada.rodada}${pulada}${saida_k6}${erro}`);
  }
  const falhas = entradas.filter((entrada) => !entrada.ok).length;
  console.log(`\n${entradas.length - falhas}/${entradas.length} rodadas OK. Resultados em ${cfg.pasta_saida}`);
  if (falhas) console.log('Para refazer só as que falharam, rode o mesmo comando com o mesmo --out.');
  return falhas;
}

async function limpezaEmergencia() {
  try {
    encerrarMonitores();
    pararApis(cfg);
  } catch (_) { }
}

async function main() {
  const rodadas = montarPlano();
  if (args['dry-run']) return mostrarPlano(rodadas);

  const info_docker = verificarDocker(cfg);
  if (args.smoke) process.exit((await verificarApis()) ? 1 : 0);

  fs.mkdirSync(cfg.pasta_saida, { recursive: true });
  registrar(`Resultados em: ${cfg.pasta_saida}`);
  registrar('Build das imagens...');
  composeOk(cfg, ['build']);
  registrarAmbiente(cfg, info_docker);

  const desta_execucao = [];
  for (let i = 0; i < rodadas.length; i++) {
    const rodada = rodadas[i];
    if (!cfg.forcar && jaFoiExecutada(rodada)) {
      registrar(`--- ${rodada.nome}: já existe em --out, pulando (use --force para refazer)`);
      const entrada = { rodada: rodada.nome, pulada: true, ok: true };
      desta_execucao.push(entrada);
      if (!lerManifesto().some((existente) => existente.rodada === rodada.nome)) registrarNoManifesto(entrada);
      continue;
    }
    const entrada = await executarComTratamentoDeErro(rodada);
    desta_execucao.push(entrada);
    registrarNoManifesto(entrada);
    if (cfg.cooldown_s > 0) {
      registrar(`descanso de ${cfg.cooldown_s}s`);
      await dormir(cfg.cooldown_s * 1000);
    }
  }

  compose(cfg, ['down']);
  process.exit(mostrarResumo(desta_execucao) ? 1 : 0);
}

process.on('SIGINT', async () => {
  registrar('Interrompido. Parando APIs...');
  await limpezaEmergencia();
  process.exit(130);
});

main().catch(async (erro) => {
  console.error(`Erro fatal: ${erro.message}`);
  await limpezaEmergencia();
  process.exit(1);
});
