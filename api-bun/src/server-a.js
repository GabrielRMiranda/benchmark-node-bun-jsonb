import { validarProduto } from "../../shared/validacao.js";

const PORT = process.env.PORT || 3012;

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

    return new Response(JSON.stringify({ sucesso: true, sku: payload.sku }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

console.log(`[Cenário A / Bun] escutando na porta ${PORT}`);
