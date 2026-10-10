import pg from "pg";
import { validarProduto } from "../../shared/validacao.js";

const PORT = process.env.PORT || 3003;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

Bun.serve({
  port: PORT,
  async fetch(req) {
    const caminho = req.url.slice(req.url.indexOf('/', 8));
    if (req.method !== 'POST' || caminho !== '/produtos') {
      return new Response(JSON.stringify({ erro: 'rota não encontrada' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let payload;
    try {
      payload = await req.json();
    } catch {
      return new Response(JSON.stringify({ erro: 'JSON inválido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const erros = validarProduto(payload);
    if (erros.length > 0) {
      return new Response(JSON.stringify({ erros }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const resultado = await pool.query(
        'INSERT INTO produtos_bun (dados) VALUES ($1) RETURNING id',
        [JSON.stringify(payload)]
      );
      return new Response(JSON.stringify({ id: resultado.rows[0].id }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (erro) {
      console.error(erro);
      return new Response(JSON.stringify({ erro: 'Erro interno no servidor' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
});

console.log(`[Cenário B / Bun + pg] escutando na porta ${PORT}`);
