const { Pool } = require('pg');
const { validarProduto } = require('../../shared/validacao');
const { criarServidor, lerCorpo } = require('./servidor');

const PORT = process.env.PORT || 3001;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const server = criarServidor((req, res) => {
  if (req.method !== 'POST' || req.url !== '/produtos') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ erro: 'rota não encontrada' }));
    return;
  }

  lerCorpo(req, async (body) => {
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

    try {
      const resultado = await pool.query(
        'INSERT INTO produtos_node (dados) VALUES ($1) RETURNING id',
        [JSON.stringify(payload)]
      );
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: resultado.rows[0].id }));
    } catch (erro) {
      console.error(erro);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ erro: 'Erro interno no servidor' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Cenário B / Node] escutando na porta ${PORT}`);
});
