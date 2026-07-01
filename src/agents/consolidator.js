import Anthropic from '@anthropic-ai/sdk'
import 'dotenv/config'

const client = new Anthropic()

const PESO_PRECO     = parseFloat(process.env.SCORE_PESO_PRECO             ?? '0.6')
const PESO_PAGAMENTO = parseFloat(process.env.SCORE_PESO_PRAZO_PAGAMENTO   ?? '0.2')
const PESO_ENTREGA   = parseFloat(process.env.SCORE_PESO_PRAZO_ENTREGA     ?? '0.2')

/**
 * Consolida propostas de múltiplos representantes e retorna:
 * - itensMelhorPreco: melhor preço por item
 * - melhorFornecedor: rep com melhor score geral
 * - rankingFornecedores: todos os reps ordenados por score
 * - propostas: array original enriquecido com scores
 */
export function consolidarPropostas(itensEsperados, propostas) {
  if (!propostas.length) return null

  const porRep = {}
  for (const p of propostas) {
    const repId = p.representante_id
    if (!porRep[repId]) {
      porRep[repId] = {
        id:       repId,
        nome:     p.representantes?.nome ?? repId,
        empresa:  p.representantes?.empresa ?? '',
        telefone: p.representantes?.telefone,
        itens:    [],
      }
    }
    porRep[repId].itens.push(p)
  }

  const reps = Object.values(porRep)

  // Ranges de preço por produto para normalização
  const precosPorProduto = {}
  for (const p of propostas) {
    const key = normalizarNome(p.produto)
    if (!precosPorProduto[key]) precosPorProduto[key] = []
    if (p.preco_unitario != null) precosPorProduto[key].push(p.preco_unitario)
  }

  const prazosPagemento = propostas.map(p => p.prazo_pagamento_dias).filter(Boolean)
  const maxPrazoPag = prazosPagemento.length ? Math.max(...prazosPagemento) : 1
  const minPrazoPag = prazosPagemento.length ? Math.min(...prazosPagemento) : 0

  const prazosEntrega = propostas.map(p => p.prazo_entrega_dias).filter(Boolean)
  const maxPrazoEnt = prazosEntrega.length ? Math.max(...prazosEntrega) : 1
  const minPrazoEnt = prazosEntrega.length ? Math.min(...prazosEntrega) : 0

  for (const rep of reps) {
    let scorePrecoTotal = 0
    let scorePrecoCount = 0

    for (const item of rep.itens) {
      const key = normalizarNome(item.produto)
      const precos = precosPorProduto[key] ?? []
      if (precos.length && item.preco_unitario != null) {
        const minPreco = Math.min(...precos)
        const maxPreco = Math.max(...precos)
        const range = maxPreco - minPreco
        const scoreItem = range === 0 ? 1 : (maxPreco - item.preco_unitario) / range
        item.score_preco = scoreItem
        scorePrecoTotal += scoreItem
        scorePrecoCount++
      }
    }

    const scorePrecoMedio = scorePrecoCount > 0 ? scorePrecoTotal / scorePrecoCount : 0.5

    const pg = rep.itens[0]?.prazo_pagamento_dias
    const scorePagamento = (pg != null && maxPrazoPag !== minPrazoPag)
      ? (pg - minPrazoPag) / (maxPrazoPag - minPrazoPag)
      : 0.5

    const en = rep.itens[0]?.prazo_entrega_dias
    const scoreEntrega = (en != null && maxPrazoEnt !== minPrazoEnt)
      ? (maxPrazoEnt - en) / (maxPrazoEnt - minPrazoEnt)
      : 0.5

    rep.score = (
      scorePrecoMedio * PESO_PRECO +
      scorePagamento  * PESO_PAGAMENTO +
      scoreEntrega    * PESO_ENTREGA
    )
    rep.score_detalhado = { preco: scorePrecoMedio, pagamento: scorePagamento, entrega: scoreEntrega }
    rep.valor_total = rep.itens.reduce(
      (s, it) => s + (it.preco_total ?? (it.preco_unitario ?? 0) * (it.quantidade ?? 1)), 0
    )
  }

  const itensMelhorPreco = itensEsperados.map(item => {
    const key = normalizarNome(item.produto)
    const candidatos = propostas.filter(p =>
      normalizarNome(p.produto) === key && p.preco_unitario != null
    )
    if (!candidatos.length) return { produto: item.produto, preco_unitario: null, representante: 'N/A' }
    const melhor = candidatos.reduce((a, b) => a.preco_unitario <= b.preco_unitario ? a : b)
    return {
      produto:         item.produto,
      preco_unitario:  melhor.preco_unitario,
      representante:   melhor.representantes?.nome ?? melhor.representante_id,
    }
  })

  const ranking = [...reps].sort((a, b) => b.score - a.score)

  return {
    itensMelhorPreco,
    melhorFornecedor:    ranking[0],
    rankingFornecedores: ranking,
    propostas,
  }
}

// ── Feature 3: Resumo de negociação em linguagem natural ──────────────
// Gera parágrafo explicando trade-offs entre os fornecedores
// Ex: "Pedro tem o menor preço total (R$ 340), mas Maria entrega em 1 dia..."

export async function gerarResumoNegociacao(consolidado) {
  if (!consolidado?.rankingFornecedores?.length) return null

  const { rankingFornecedores, itensMelhorPreco } = consolidado

  // Monta contexto estruturado para a IA
  const contextFornecedores = rankingFornecedores.map((rep, i) => ({
    posicao:              i + 1,
    nome:                 rep.nome,
    empresa:              rep.empresa,
    valor_total:          rep.valor_total?.toFixed(2),
    prazo_pagamento_dias: rep.itens[0]?.prazo_pagamento_dias ?? null,
    prazo_entrega_dias:   rep.itens[0]?.prazo_entrega_dias ?? null,
    score:                (rep.score * 100).toFixed(0),
    score_preco:          (rep.score_detalhado?.preco * 100).toFixed(0),
    qtd_itens_cobertos:   rep.itens.filter(it => it.preco_unitario != null).length,
  }))

  const contextMelhorPreco = itensMelhorPreco
    .filter(it => it.preco_unitario != null)
    .map(it => `${it.produto}: melhor preço com ${it.representante}`)

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system: `Você escreve um insight de 1-2 frases CURTAS sobre o comparativo de fornecedores para um comerciante brasileiro no WhatsApp.

Regras:
- Máximo 2 frases, cada uma com no máximo 20 palavras
- Mencione valor total (R$), itens cobertos e prazos de pagamento/entrega quando disponíveis
- Se prazos estiverem ausentes, mencione isso em uma frase
- Sem narrativa — só fatos concretos
- NÃO use emojis, bullets ou formatação — só texto corrido
- NÃO comece com "Olá" ou o nome do fornecedor`,
      messages: [{
        role: 'user',
        content: `Fornecedores:\n${JSON.stringify(contextFornecedores, null, 2)}\n\nMelhor preço por item:\n${contextMelhorPreco.join('\n')}\n\nEscreva o resumo do comparativo:`,
      }],
    })

    return response.content[0].text.trim()
  } catch (err) {
    console.warn('[gerarResumoNegociacao] erro, pulando resumo:', err.message)
    return null
  }
}

function normalizarNome(nome) {
  return (nome ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
}

// ── Entregável: escolha de fechamento pelo comerciante ────────────────
// As funções abaixo são puras (sem IA, sem banco) e alimentam o fluxo de
// fechamento em webhook.js. Cada cotacao_item recebe as ofertas dos reps
// ordenadas por preço; o índice 0 (mais barato) é marcado como melhor (⭐).

/**
 * Para cada item esperado, lista as ofertas dos representantes ordenadas
 * por preço unitário crescente. Marca a primeira (mais barata) como melhor.
 *
 * Retorna: [{ item, ofertas: [{ representante_id, nome, empresa, telefone,
 *   marca, preco_unitario, preco_total, prazo_pagamento_dias,
 *   prazo_entrega_dias, melhor }] }]
 */
export function compararPorItem(itensEsperados, propostas) {
  return itensEsperados.map(item => {
    const key = normalizarNome(item.produto)
    const qtd = item.quantidade ?? 1
    const ofertas = propostas
      .filter(p => normalizarNome(p.produto) === key && p.preco_unitario != null)
      .map(p => ({
        representante_id:     p.representante_id,
        nome:                 p.representantes?.nome ?? p.representante_id,
        empresa:              p.representantes?.empresa ?? '',
        telefone:             p.representantes?.telefone,
        marca:                p.marca ?? null,
        preco_unitario:       p.preco_unitario,
        preco_total:          p.preco_total ?? p.preco_unitario * qtd,
        prazo_pagamento_dias: p.prazo_pagamento_dias,
        prazo_entrega_dias:   p.prazo_entrega_dias,
      }))
      .sort((a, b) => a.preco_unitario - b.preco_unitario)
    ofertas.forEach((o, i) => { o.melhor = i === 0 })
    return { item, ofertas }
  })
}

// Agrupa seleções (uma oferta por item) por representante, montando os
// grupos que viram pedidos. Itens sem oferta vão para itensSemProposta.
function agruparSelecoes(selecoes) {
  const porRep = {}
  const itensSemProposta = []
  for (const { item, oferta } of selecoes) {
    if (!oferta) { itensSemProposta.push(item.produto); continue }
    if (!porRep[oferta.representante_id]) {
      porRep[oferta.representante_id] = {
        rep: {
          id:                   oferta.representante_id,
          nome:                 oferta.nome,
          empresa:              oferta.empresa,
          telefone:             oferta.telefone,
          prazo_pagamento_dias: oferta.prazo_pagamento_dias,
          prazo_entrega_dias:   oferta.prazo_entrega_dias,
        },
        itens:    [],
        subtotal: 0,
      }
    }
    const grupo = porRep[oferta.representante_id]
    const qtd        = item.quantidade ?? 1
    const precoTotal = oferta.preco_total ?? oferta.preco_unitario * qtd
    grupo.itens.push({
      cotacao_item_id: item.id,
      produto:         item.produto,
      marca:           item.marca ?? oferta.marca ?? null,
      quantidade:      qtd,
      preco_unitario:  oferta.preco_unitario,
      preco_total:     precoTotal,
    })
    grupo.subtotal += precoTotal
  }
  const grupos = Object.values(porRep)
  return {
    grupos,
    valorTotal:       grupos.reduce((s, g) => s + g.subtotal, 0),
    itensSemProposta,
  }
}

/**
 * Split automático: para cada item, escolhe o fornecedor mais barato.
 * Pode resultar em vários pedidos (um por representante).
 */
export function montarPedidoOtimizado(itensEsperados, propostas) {
  const selecoes = compararPorItem(itensEsperados, propostas)
    .map(({ item, ofertas }) => ({ item, oferta: ofertas[0] ?? null }))
  return agruparSelecoes(selecoes)
}

/**
 * Fornecedor único: fecha todos os itens que o representante indicado cobre.
 * Itens não cobertos por ele entram em itensSemProposta.
 */
export function montarPedidoFornecedorUnico(itensEsperados, propostas, representanteId) {
  const selecoes = compararPorItem(itensEsperados, propostas)
    .map(({ item, ofertas }) => ({
      item,
      oferta: ofertas.find(o => o.representante_id === representanteId) ?? null,
    }))
  return agruparSelecoes(selecoes)
}

/**
 * Manual item a item: usa o mapa { cotacao_item_id: representante_id } com
 * as escolhas do comerciante. Itens sem escolha (ou escolha inválida) caem
 * para itensSemProposta.
 */
export function montarPedidoManual(itensEsperados, propostas, escolhasPorItemId = {}) {
  const selecoes = compararPorItem(itensEsperados, propostas)
    .map(({ item, ofertas }) => {
      const repId = escolhasPorItemId[item.id]
      return { item, oferta: ofertas.find(o => o.representante_id === repId) ?? null }
    })
  return agruparSelecoes(selecoes)
}
