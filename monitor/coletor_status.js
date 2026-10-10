const { execFile } = require('child_process');
const fs = require('fs');

const [, , nome_container, arquivo_saida, arquivo_sentinela, intervalo_arg] = process.argv;

if (!nome_container || !arquivo_saida || !arquivo_sentinela) {
  console.error('Uso: node monitor/coletor_status.js <container> <arquivo_saida.json> <arquivo_sentinela> [intervalo_ms]');
  process.exit(1);
}

const intervalo_ms = Number(intervalo_arg) || 1000;
const inicio = Date.now();
const amostras = [];
let coletando = true;

const lerPercentual = (texto) => parseFloat(String(texto).replace('%', '').trim());

function converterParaMb(valor) {
  const partes = /^([\d.]+)\s*([A-Za-z]+)$/.exec(valor);
  if (!partes) return null;
  const numero = parseFloat(partes[1]);
  const unidade = partes[2].toLowerCase();
  if (unidade.startsWith('g')) return numero * 1024;
  if (unidade.startsWith('k')) return numero / 1024;
  return numero;
}

function lerUsoDeMemoria(texto) {
  const [uso, limite] = String(texto).split('/').map((parte) => parte.trim());
  return { uso_mb: converterParaMb(uso), limite_mb: converterParaMb(limite) };
}

function coletarAmostra() {
  if (!coletando) return;
  execFile('docker', ['stats', '--no-stream', '--format', '{{json .}}', nome_container], (erro, saida) => {
    if (erro) {
      console.error(`[coletor] erro ao consultar ${nome_container}:`, erro.message);
      return;
    }
    try {
      const estatistica = JSON.parse(saida.trim());
      const { uso_mb, limite_mb } = lerUsoDeMemoria(estatistica.MemUsage);
      amostras.push({
        t_epoch_ms: Date.now(),
        tempo_decorrido_s: (Date.now() - inicio) / 1000,
        cpu_percent: lerPercentual(estatistica.CPUPerc),
        mem_uso_mb: uso_mb,
        mem_limite_mb: limite_mb,
        mem_percent: lerPercentual(estatistica.MemPerc),
        net_io: estatistica.NetIO,
        block_io: estatistica.BlockIO,
      });
    } catch (erro_leitura) {
      console.error('[coletor] falha ao ler a saída do docker stats:', erro_leitura.message);
    }
  });
}

function salvarEEncerrar() {
  coletando = false;
  clearInterval(temporizador_coleta);
  clearInterval(temporizador_sentinela);
  const conteudo = { container: nome_container, intervalo_ms, inicio_epoch_ms: inicio, amostras };
  fs.writeFileSync(arquivo_saida, JSON.stringify(conteudo, null, 2));
  console.log(`[coletor] ${amostras.length} amostras salvas em ${arquivo_saida}`);
  process.exit(0);
}

const temporizador_coleta = setInterval(coletarAmostra, intervalo_ms);
const temporizador_sentinela = setInterval(() => {
  if (fs.existsSync(arquivo_sentinela)) salvarEEncerrar();
}, 500);
process.on('SIGINT', salvarEEncerrar);
process.on('SIGTERM', salvarEEncerrar);

coletarAmostra();
console.log(`[coletor] coletando CPU e memória de "${nome_container}" a cada ${intervalo_ms} ms; encerra quando ${arquivo_sentinela} aparecer.`);
