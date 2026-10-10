const { validarProduto } = require('../../shared/validacao');
const { criarServidor, lerCorpo } = require('./servidor');

const PORT = process.env.PORT || 3011;

const server = criarServidor((req, res) => {
  if (req.method !== 'POST' || req.url !== '/produtos') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ erro: 'rota não encontrada' }));
    return;
  }

  lerCorpo(req, (body) => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ erro: 'JSON inválido' }));
      return;
    }

    const erros = validarProduto(payload);
    if (erros.length > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ erros }));
      return;
    }

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sucesso: true, sku: payload.sku }));
  });
});

server.listen(PORT, () => {
  console.log(`[Cenário A / Node] escutando na porta ${PORT}`);
});
