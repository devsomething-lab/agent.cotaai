import 'dotenv/config'

const PESO_PRECO = parseFloat(process.env.SCORE_PESO_PRECO ?? '0.6')
const PESO_PAGAMENTO = parseFloat(process.env.SCORE_PESO_PRAZO_PAGAMENTO ?? '0.2')
const PESO_ENTREGA = parseFloat(process.env.SCORE_PESO_PRAZO_ENTREGA ?? '0.2')

/**
 * Consolida propostas de múltiplos representantes e retorna:
 * - itensMelhorPreco: melhor preço por item
 * - melhorFornecedor: rep com melhor score geral
 * - rankingFornecedores: todos os reps ordenados por score
 * - propostas: array original enriquecido com scores
 */
export function consolidarPropostas(itensEsperados, propostas) {
  if (!propostas.length) return null

  // Agrupa propostas por representante
  const porRep = {}
  for (const p of propostas) {
    const repId = p.representante_id
    if (!porRep[repId]) {
      porRep[repId] = {
        id: repId,
        nome: p.representantes?.nome ?? repId,
        empresa: p.representantes?.empresa ?? '',
        telefone: p.representantes?.telefone,
        itens: [],
      }
    }
    porRep[repId].itens.push(p)
  }

  const reps = Object.values(porRep)

  // ── Normalização para scoring ────────────────────────────────────

  // Para cada item, pega o range de preços entre reps
  const precosPorProduto = {}
  for (const p of propostas) {
    const key = normalizarNome(p.produto)
    if (!precosPorProduto[key]) precosPorProduto[key] = []
    if (p.preco_unitario != null) precosPorProduto[key].push(p.preco_unitario)
  }

  // Prazo de pagamento: maior prazo = melhor para o comprador
  const prazosPagemento = propostas.map(p => p.prazo_pagamento_dias).filter(Boolean)
  const maxPrazoPag = prazosPagemento.length ? Math.max(...prazosPagemento) : 1
  const minPrazoPag = prazosPagemento.length ? Math.min(...prazosPagemento) : 0

  // Prazo de entrega: menor prazo = melhor
  const prazosEntrega = propostas.map(p => p.prazo_entrega_dias).filter(Boolean)
  const maxPrazoEnt = prazosEntrega.length ? Math.max(...prazosEntrega) : 1
  const minPrazoEnt = prazosEntrega.length ? Math.min(...prazosEntrega) : 0

  // ── Score por representante ──────────────────────────────────────
  for (const rep of reps) {
    let scorePrecoTotal = 0
    let scorePrecoCount = 0
    let scorePagamento = 0
    let scoreEntrega = 0

    for (const item of rep.itens) {
      const key = normalizarNome(item.produto)
      const precos = precosPorProduto[key] ?? []
      if (precos.length && item.preco_unitario != null) {
        const minPreco = Math.min(...precos)
        const maxPreco = Math.max(...precos)
        const range = maxPreco - minPreco
        // score de preço: 1 = melhor preço, 0 = pior preço
        const scoreItem = range === 0 ? 1 : (maxPreco - item.preco_unitario) / range
        item.score_preco = scoreItem
        scorePrecoTotal += scoreItem
        scorePrecoCount++
      }
    }

    const scorePrecoMedio = scorePrecoCount > 0 ? scorePrecoTotal / scorePrecoCount : 0.5

    // Prazo pagamento (normalizado 0-1, maior = melhor)
    const pg = rep.itens[0]?.prazo_pagamento_dias
    if (pg != null && maxPrazoPag !== minPrazoPag) {
      scorePagamento = (pg - minPrazoPag) / (maxPrazoPag - minPrazoPag)
    } else {
      scorePagamento = 0.5
    }

    // Prazo entrega (normalizado 0-1, menor = melhor)
    const en = rep.itens[0]?.prazo_entrega_dias
    if (en != null && maxPrazoEnt !== minPrazoEnt) {
      scoreEntrega = (maxPrazoEnt - en) / (maxPrazoEnt - minPrazoEnt)
    } else {
      scoreEntrega = 0.5
    }

    rep.score = (
      scorePrecoMedio * PESO_PRECO +
      scorePagamento * PESO_PAGAMENTO +
      scoreEntrega * PESO_ENTREGA
    )
    rep.score_detalhado = {
      preco: scorePrecoMedio,
      pagamento: scorePagamento,
      entrega: scoreEntrega,
    }

    // Total do carrinho
    rep.valor_total = rep.itens.reduce((s, it) => s + (it.preco_total ?? (it.preco_unitario ?? 0) * (it.quantidade ?? 1)), 0)
  }

  // ── Melhor preço por item ────────────────────────────────────────
  const itensMelhorPreco = itensEsperados.map(item => {
    const key = normalizarNome(item.produto)
    const candidatos = propostas.filter(p =>
      normalizarNome(p.produto) === key && p.preco_unitario != null
    )
    if (!candidatos.length) return { produto: item.produto, preco_unitario: null, representante: 'N/A' }
    const melhor = candidatos.reduce((a, b) => a.preco_unitario <= b.preco_unitario ? a : b)
    return {
      produto: item.produto,
      preco_unitario: melhor.preco_unitario,
      representante: melhor.representantes?.nome ?? melhor.representante_id,
    }
  })

  // ── Ranking ──────────────────────────────────────────────────────
  const ranking = [...reps].sort((a, b) => b.score - a.score)

  return {
    itensMelhorPreco,
    melhorFornecedor: ranking[0],
    rankingFornecedores: ranking,
    propostas,
  }
}

function normalizarNome(nome) {
  return (nome ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
}
