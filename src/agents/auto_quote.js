import { supabase } from '../db/client.js'
import { buscarCatalogoPorProduto, normalizarNome } from '../db/catalogo.js'
import { getAllRepresentantesAtivos } from '../db/client.js'

// ── Tenta resolver cotação automaticamente via catálogo ───────────────

export async function resolverCotacaoAutomatica(cotacaoId, itens) {
  /**
   * Para cada representante ativo, verifica se tem TODOS os itens no catálogo.
   * - Se tem todos: gera proposta automática sem perguntar ao representante
   * - Se tem alguns: gera proposta parcial e marca itens faltantes para perguntar
   * - Se não tem nenhum: marca como manual
   *
   * Retorna: {
   *   repsAutomaticos: [{ rep, propostas }],
   *   repsManuais: [rep],
   *   itensSemCobertura: [item]   -- itens que NENHUM rep tem no catálogo
   * }
   */

  const reps = await getAllRepresentantesAtivos()
  const repsAutomaticos = []
  const repsManuais = []
  const coberturaPorItem = {} // item.id → quantos reps têm

  for (const rep of reps) {
    const propostas = []
    let totalEncontrados = 0

    for (const item of itens) {
      const matches = await buscarCatalogoPorProduto(rep.id, item.produto)
      const melhorMatch = escolherMelhorMatch(matches, item)

      if (melhorMatch) {
        totalEncontrados++
        coberturaPorItem[item.id] = (coberturaPorItem[item.id] ?? 0) + 1

        // Hierarquia de prazo:
        // 1º catálogo do produto → 2º cadastro do representante → 3º fallback 3 dias
        const prazoPagamento = melhorMatch.prazo_pagamento_dias
          ?? rep.prazo_pagamento_padrao_dias
          ?? 30

        const prazoEntrega = melhorMatch.prazo_entrega_dias
          ?? rep.prazo_entrega_padrao_dias
          ?? 3

        propostas.push({
          cotacao_item_id:      item.id,
          catalogo_item_id:     melhorMatch.id,
          produto:              item.produto,
          preco_unitario:       melhorMatch.preco_efetivo,
          preco_total:          melhorMatch.preco_efetivo * (item.quantidade ?? 1),
          prazo_pagamento_dias: prazoPagamento,
          prazo_entrega_dias:   prazoEntrega,
          origem:               melhorMatch.tem_promocao ? 'promocao' : 'catalogo',
          obs: melhorMatch.tem_promocao
            ? `Promoção válida até ${melhorMatch.promo_valida_ate}`
            : null,
        })
      }
    }

    if (totalEncontrados > 0) {
      repsAutomaticos.push({
        rep,
        propostas,
        cobertura_pct: Math.round((totalEncontrados / itens.length) * 100),
        total_itens:   itens.length,
        itens_cobertos: totalEncontrados,
      })
    } else {
      repsManuais.push(rep)
    }
  }

  // Itens sem cobertura em nenhum rep
  const itensSemCobertura = itens.filter(it => !coberturaPorItem[it.id])

  // Determina o modo da cotação
  let modo = 'manual'
  if (repsAutomaticos.length === reps.length && itensSemCobertura.length === 0) {
    modo = 'automatico'
  } else if (repsAutomaticos.length > 0) {
    modo = 'misto'
  }

  // Atualiza o modo na cotação
  await supabase.from('cotacoes').update({ modo }).eq('id', cotacaoId)

  return { repsAutomaticos, repsManuais, itensSemCobertura, modo }
}

// ── Salva propostas automáticas no banco ──────────────────────────────

export async function salvarPropostasAutomaticas(cotacaoId, representanteId, propostas) {
  // Cria o envio marcado como automático
  const { data: envio, error: errEnvio } = await supabase
    .from('cotacao_envios')
    .insert({
      cotacao_id:       cotacaoId,
      representante_id: representanteId,
      modo_resposta:    'automatico',
      status:           'respondido',
      respondido_em:    new Date().toISOString(),
    })
    .select()
    .single()

  if (errEnvio) throw errEnvio

  // Salva as propostas
  const propostasParaInserir = propostas.map(p => ({
    cotacao_envio_id:     envio.id,
    cotacao_id:           cotacaoId,
    representante_id:     representanteId,
    cotacao_item_id:      p.cotacao_item_id,
    catalogo_item_id:     p.catalogo_item_id,
    produto:              p.produto,
    preco_unitario:       p.preco_unitario,
    preco_total:          p.preco_total,
    prazo_pagamento_dias: p.prazo_pagamento_dias,
    prazo_entrega_dias:   p.prazo_entrega_dias,
    origem:               p.origem,
    obs:                  p.obs,
  }))

  const { error: errProps } = await supabase.from('propostas').insert(propostasParaInserir)
  if (errProps) throw errProps

  return envio
}

// ── Escolhe o melhor match de catálogo para um item ───────────────────

function escolherMelhorMatch(matches, item) {
  if (!matches.length) return null

  // Pontuação: nome exato > contém a palavra principal > qualquer match
  const scored = matches.map(m => {
    const nomeCat = normalizarNome(m.produto)
    const nomeItem = normalizarNome(item.produto)
    const palavraPrincipal = nomeItem.split(' ')[0]

    let score = 0
    if (nomeCat === nomeItem) score = 100
    else if (nomeCat.includes(nomeItem) || nomeItem.includes(nomeCat)) score = 80
    else if (nomeCat.includes(palavraPrincipal)) score = 60
    else score = 40

    // Bônus se unidade bate
    if (item.unidade && m.unidade) {
      const uCat = normalizarNome(m.unidade)
      const uItem = normalizarNome(item.unidade)
      if (uCat === uItem || uCat.includes(uItem) || uItem.includes(uCat)) score += 20
    }

    return { ...m, _score: score }
  })

  // Retorna o de maior score, ou null se score muito baixo
  const melhor = scored.sort((a, b) => b._score - a._score)[0]
  return melhor._score >= 40 ? melhor : null
}
