const dormir = (milissegundos) => new Promise((resolver) => setTimeout(resolver, milissegundos));

const registrar = (mensagem) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${mensagem}`);

function falhar(mensagem) {
  console.error(`Erro: ${mensagem}`);
  process.exit(2);
}

module.exports = { dormir, registrar, falhar };
