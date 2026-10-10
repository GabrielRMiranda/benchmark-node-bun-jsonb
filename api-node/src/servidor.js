const http = require('http');

const numeroDoAmbiente = (nome) => (process.env[nome] !== undefined && process.env[nome] !== '' ? Number(process.env[nome]) : null);

function instrumentar(server) {
  const contadores = {
    conexoes_abertas: 0,
    conexoes_total: 0,
    client_error: {},
    socket_error: {},
    requisicoes: 0,
    abortadas: 0,
    abortadas_por_progresso: { zero: 0, ate_25: 0, ate_75: 0, mais_75: 0 },
    leitura_corpo_ms: { ate_100: 0, ate_1000: 0, ate_5000: 0, mais_5000: 0 },
    status: {},
  };

  server.on('connection', (socket) => {
    contadores.conexoes_abertas += 1;
    contadores.conexoes_total += 1;
    socket.on('close', () => { contadores.conexoes_abertas -= 1; });
    socket.on('error', (e) => { contadores.socket_error[e.code] = (contadores.socket_error[e.code] || 0) + 1; });
  });

  server.on('clientError', (e, socket) => {
    contadores.client_error[e.code] = (contadores.client_error[e.code] || 0) + 1;
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  server.on('request', (req, res) => {
    contadores.requisicoes += 1;
    const inicio = Date.now();
    const esperado = Number(req.headers['content-length'] || 0);
    let recebido = 0;
    req.on('data', (chunk) => { recebido += chunk.length; });
    req.on('end', () => {
      const ms = Date.now() - inicio;
      const faixa = ms <= 100 ? 'ate_100' : ms <= 1000 ? 'ate_1000' : ms <= 5000 ? 'ate_5000' : 'mais_5000';
      contadores.leitura_corpo_ms[faixa] += 1;
    });
    req.on('aborted', () => {
      contadores.abortadas += 1;
      const fracao = esperado ? recebido / esperado : 0;
      const faixa = recebido === 0 ? 'zero' : fracao <= 0.25 ? 'ate_25' : fracao <= 0.75 ? 'ate_75' : 'mais_75';
      contadores.abortadas_por_progresso[faixa] += 1;
    });
    res.on('finish', () => { contadores.status[res.statusCode] = (contadores.status[res.statusCode] || 0) + 1; });
  });

  setInterval(() => {
    console.log(JSON.stringify({ t: new Date().toISOString(), ...contadores }));
  }, 5000).unref();
}

function criarServidor(handler) {
  const server = http.createServer(handler);
  const keepAlive = numeroDoAmbiente('SERVER_KEEPALIVE_MS');
  const headers = numeroDoAmbiente('SERVER_HEADERS_MS');
  const requisicao = numeroDoAmbiente('SERVER_REQUEST_MS');
  if (keepAlive !== null) server.keepAliveTimeout = keepAlive;
  if (headers !== null) server.headersTimeout = headers;
  if (requisicao !== null) server.requestTimeout = requisicao;
  if (process.env.DIAGNOSTICO === '1') instrumentar(server);
  return server;
}

function lerCorpo(req, aoTerminar) {
  if (process.env.SERVER_BODY_MODE === 'buffer') {
    const pedacos = [];
    req.on('data', (chunk) => { pedacos.push(chunk); });
    req.on('end', () => { aoTerminar(Buffer.concat(pedacos).toString('utf8')); });
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => { aoTerminar(body); });
}

module.exports = { criarServidor, lerCorpo };
