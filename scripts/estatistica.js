function logGamma(x) {
  const coeficientes = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];

  let y = x;
  let termo = x + 5.5;

  termo -= (x + 0.5) * Math.log(termo);

  let serie = 1.000000000190015;

  for (const coeficiente of coeficientes) {
    y += 1;
    serie += coeficiente / y;
  }

  return -termo + Math.log((2.5066282746310005 * serie) / x);
}

function fracaoContinuadaBeta(x, a, b) {
  const maximo_iteracoes = 200;
  const tolerancia = 3e-9;
  const minimo = 1e-30;
  const evitarZero = (valor) => (Math.abs(valor) < minimo ? minimo : valor);
  const a_mais_b = a + b;
  const a_mais_um = a + 1;
  const a_menos_um = a - 1;

  let c = 1;
  let d = 1 / evitarZero(1 - (a_mais_b * x) / a_mais_um);
  let h = d;

  for (let m = 1; m <= maximo_iteracoes; m++) {
    const dois_m = 2 * m;

    let termo = (m * (b - m) * x) / ((a_menos_um + dois_m) * (a + dois_m));

    d = 1 / evitarZero(1 + termo * d);
    c = evitarZero(1 + termo / c);
    h *= d * c;

    termo = (-(a + m) * (a_mais_b + m) * x) / ((a + dois_m) * (a_mais_um + dois_m));

    d = 1 / evitarZero(1 + termo * d);
    c = evitarZero(1 + termo / c);

    const variacao = d * c;

    h *= variacao;

    if (Math.abs(variacao - 1) < tolerancia) break;
  }

  return h;
}

function betaIncompleta(a, b, x) {
  if (x <= 0) return 0;

  if (x >= 1) return 1;

  const fator = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));

  if (x < (a + 1) / (a + b + 2)) return (fator * fracaoContinuadaBeta(x, a, b)) / a;

  return 1 - (fator * fracaoContinuadaBeta(1 - x, b, a)) / b;
}

function pValorT(t, graus_liberdade) {
  if (!Number.isFinite(t) || !Number.isFinite(graus_liberdade) || graus_liberdade <= 0) return null;

  return betaIncompleta(graus_liberdade / 2, 0.5, graus_liberdade / (graus_liberdade + t * t));
}

function tCritico(graus_liberdade, alfa = 0.05) {
  if (!Number.isFinite(graus_liberdade) || graus_liberdade <= 0) return null;

  let minimo = 0;
  let maximo = 60;

  for (let i = 0; i < 100; i++) {
    const meio = (minimo + maximo) / 2;

    if (pValorT(meio, graus_liberdade) > alfa) minimo = meio;

    else maximo = meio;
  }

  return (minimo + maximo) / 2;
}

const media = (valores) => valores.reduce((soma, valor) => soma + valor, 0) / valores.length;

function desvioPadrao(valores, media_dos_valores = media(valores)) {
  if (valores.length < 2) return null;

  const soma_dos_quadrados = valores.reduce((soma, valor) => soma + (valor - media_dos_valores) ** 2, 0);

  return Math.sqrt(soma_dos_quadrados / (valores.length - 1));
}

function resumoAmostra(valores) {
  const n = valores.length;

  if (n === 0) return { n: 0, media: null, dp: null, ic95_lo: null, ic95_hi: null };

  const media_dos_valores = media(valores);

  if (n === 1) return { n, media: +media_dos_valores.toFixed(3), dp: null, ic95_lo: null, ic95_hi: null };

  const dp = desvioPadrao(valores, media_dos_valores);
  const t_critico = tCritico(n - 1, 0.05);
  const margem = t_critico !== null ? t_critico * (dp / Math.sqrt(n)) : null;

  return {
    n,
    media: +media_dos_valores.toFixed(3),
    dp: +dp.toFixed(3),
    ic95_lo: margem !== null ? +(media_dos_valores - margem).toFixed(3) : null,
    ic95_hi: margem !== null ? +(media_dos_valores + margem).toFixed(3) : null,
  };
}

function welchTTest(referencia, alternativa) {
  const n_referencia = referencia.length;
  const n_alternativa = alternativa.length;

  if (n_referencia < 2 || n_alternativa < 2) {
    return { t: null, df: null, p: null, significativo_5pct: null, dif: null, dif_ic95_lo: null, dif_ic95_hi: null };
  }

  const media_referencia = media(referencia);
  const media_alternativa = media(alternativa);
  const variancia_referencia = desvioPadrao(referencia, media_referencia) ** 2;
  const variancia_alternativa = desvioPadrao(alternativa, media_alternativa) ** 2;
  const erro_padrao_ao_quadrado = variancia_referencia / n_referencia + variancia_alternativa / n_alternativa;

  const t = (media_referencia - media_alternativa) / Math.sqrt(erro_padrao_ao_quadrado);
  const graus_liberdade = (erro_padrao_ao_quadrado ** 2) / (
    (variancia_referencia / n_referencia) ** 2 / (n_referencia - 1)
    + (variancia_alternativa / n_alternativa) ** 2 / (n_alternativa - 1)
  );

  const p = pValorT(Math.abs(t), graus_liberdade);
  const t_critico = tCritico(graus_liberdade, 0.05);
  const margem = t_critico !== null ? t_critico * Math.sqrt(erro_padrao_ao_quadrado) : null;
  const diferenca = media_alternativa - media_referencia;

  return {
    t: +t.toFixed(3),
    df: +graus_liberdade.toFixed(2),
    p: p !== null ? +p.toFixed(4) : null,
    p_bruto: p,
    significativo_5pct: p !== null ? p < 0.05 : null,
    dif: +diferenca.toFixed(4),
    dif_ic95_lo: margem !== null ? +(diferenca - margem).toFixed(4) : null,
    dif_ic95_hi: margem !== null ? +(diferenca + margem).toFixed(4) : null,
  };
}

function holm(valores_p) {
  const validos = valores_p
    .map((p, posicao) => [p, posicao])
    .filter(([p]) => p !== null && p !== undefined && !Number.isNaN(p))
    .sort((a, b) => a[0] - b[0]);

  const ajustados = valores_p.map(() => null);

  let maior_ate_agora = 0;

  validos.forEach(([p, posicao], ordem) => {
    maior_ate_agora = Math.max(maior_ate_agora, Math.min(1, (validos.length - ordem) * p));
    ajustados[posicao] = maior_ate_agora;
  });

  return ajustados;
}

function contrasteWelch(grupos, coeficientes) {
  const vazio = { estimativa: null, ep: null, t: null, df: null, p: null, ic95_lo: null, ic95_hi: null };
 
  if (grupos.length !== coeficientes.length || grupos.some((grupo) => grupo.length < 2)) return vazio;

  let estimativa = 0;
  let ep_ao_quadrado = 0;
  let denominador_df = 0;
  
  grupos.forEach((grupo, i) => {
    const media_do_grupo = media(grupo);
    const termo = (coeficientes[i] ** 2 * desvioPadrao(grupo, media_do_grupo) ** 2) / grupo.length;

    estimativa += coeficientes[i] * media_do_grupo;
    ep_ao_quadrado += termo;
    denominador_df += termo ** 2 / (grupo.length - 1);
  });

  if (ep_ao_quadrado === 0) return { ...vazio, estimativa };

  const ep = Math.sqrt(ep_ao_quadrado);
  const graus_liberdade = ep_ao_quadrado ** 2 / denominador_df;
  const t = estimativa / ep;
  const t_critico = tCritico(graus_liberdade, 0.05);
  
  return {
    estimativa,
    ep,
    t,
    df: graus_liberdade,
    p: pValorT(Math.abs(t), graus_liberdade),
    ic95_lo: t_critico !== null ? estimativa - t_critico * ep : null,
    ic95_hi: t_critico !== null ? estimativa + t_critico * ep : null,
  };
}

module.exports = { resumoAmostra, welchTTest, holm, contrasteWelch };
