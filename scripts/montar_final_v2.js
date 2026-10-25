#!/usr/bin/env node
// Monta resultados/final_v2: Cenário A da coleta de 10-11/10 (resultados/final)
// + Cenário B da coleta de 24-25/10 (resultados/final_b, Bun.sql corrigido).
// Depois: node scripts/agregar.js --out-base resultados/final_v2
'use strict';
const fs = require('fs');
const path = require('path');

const raiz = path.resolve(__dirname, '..');
const pasta_a = path.join(raiz, 'resultados', 'final');
const pasta_b = path.join(raiz, 'resultados', 'final_b');
const destino = path.join(raiz, 'resultados', 'final_v2');

if (fs.existsSync(destino)) {
  console.error(`Erro: ${destino} já existe. Apague a pasta antes de montar de novo.`);
  process.exit(1);
}

const repeticoes = fs.readdirSync(pasta_b).filter((nome) => /^rep\d+$/.test(nome)).sort();
let copiados_a = 0;

for (const rep of repeticoes) {
  if (!fs.existsSync(path.join(pasta_b, rep, '.completo'))) {
    console.error(`Erro: ${rep} de final_b não está completa.`);
    process.exit(1);
  }
  // Tudo do Cenário B (resultados, stats, logs, execucao.json, ambiente.json)
  fs.cpSync(path.join(pasta_b, rep), path.join(destino, rep), { recursive: true });
  // Só os arquivos do Cenário A da coleta original
  for (const runtime of ['node', 'bun']) {
    const origem = path.join(pasta_a, rep, runtime);
    const alvo = path.join(destino, rep, runtime);
    fs.mkdirSync(alvo, { recursive: true });
    for (const arquivo of fs.readdirSync(origem).filter((nome) => nome.includes('cenarioA'))) {
      fs.copyFileSync(path.join(origem, arquivo), path.join(alvo, arquivo));
      copiados_a++;
    }
  }
}

const leia_me = [
  'Pasta montada por scripts/montar_final_v2.js.',
  'Cenário A: resultados/final (coleta de 10-11/10/2026, commit 8d38e6c).',
  'Cenário B: resultados/final_b (coleta de 24-25/10/2026, commit d50cfc4, Bun.sql corrigido).',
  'O Cenário B de resultados/final é inválido para o Bun.sql (documento gravado como string JSON).',
  '',
].join('\n');
fs.writeFileSync(path.join(destino, 'ORIGEM.txt'), leia_me);
console.log(`final_v2 montada: ${repeticoes.length} repetições, ${copiados_a} arquivos do Cenário A copiados.`);
console.log('Agora rode: node scripts/agregar.js --out-base resultados/final_v2');
