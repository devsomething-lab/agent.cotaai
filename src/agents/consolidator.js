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
      max_tokens: 300,
      system: `Você escreve resumos concisos de comparativos de fornecedores para comerciantes brasileiros via WhatsApp.

Regras:
- Máximo 3 frases curtas, tom informal e direto
- Use o primeiro nome do representante (sem sobrenome ou empresa)
- Destaque o trade-off principal (preço vs entrega vs prazo pagamento)
- Se um fornecedor for claramente melhor em tudo, diga isso
- Use valores reais (R$, dias) para ser específico
- NÃO use emojis, bullet points ou formatação — apenas texto corrido
- NÃO comece com "Olá" ou saudações`,
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
