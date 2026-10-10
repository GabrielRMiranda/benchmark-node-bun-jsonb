function validarProduto(payload) {
  const erros = [];

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return ['payload deve ser um objeto JSON'];
  }

  if (typeof payload.sku !== 'string' || payload.sku.trim() === '') {
    erros.push('sku deve ser uma string não vazia');
  }

  if (typeof payload.nome !== 'string' || payload.nome.trim() === '') {
    erros.push('nome deve ser uma string não vazia');
  }

  if (typeof payload.preco !== 'number' || Number.isNaN(payload.preco)) {
    erros.push('preco deve ser um número');
  }

  if (typeof payload.em_estoque !== 'boolean') {
    erros.push('em_estoque deve ser um booleano');
  }

  if (!Array.isArray(payload.categorias)) {
    erros.push('categorias deve ser um array');
  }

  if (typeof payload.dimensoes !== 'object' || payload.dimensoes === null || Array.isArray(payload.dimensoes)) {
    erros.push('dimensoes deve ser um objeto');
  } else {
    const { altura_cm, largura_cm, peso_kg } = payload.dimensoes;
    if (typeof altura_cm !== 'number' || Number.isNaN(altura_cm)) {
      erros.push('dimensoes.altura_cm deve ser um número');
    }
    if (typeof largura_cm !== 'number' || Number.isNaN(largura_cm)) {
      erros.push('dimensoes.largura_cm deve ser um número');
    }
    if (typeof peso_kg !== 'number' || Number.isNaN(peso_kg)) {
      erros.push('dimensoes.peso_kg deve ser um número');
    }
  }

  return erros;
}

module.exports = { validarProduto };
