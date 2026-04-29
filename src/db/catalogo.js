import { supabase } from './client.js'

// ── Busca itens do catálogo para cotação automática ───────────────────
// Usa a view vw_catalogo_preco_efetivo que já aplica promoções ativas

export async function buscarCatalogoPorProduto(representanteId, nomeProduto) {
  /**
   * Busca pelo nome do produto OU marca no catálogo do representante.
   * Retorna os melhores candidatos para o algoritmo de matching decidir.
   */
  const nome = normalizarNome(nomeProduto)

  // Extrai palavras com mais de 2 chars para busca ampla
  const palavras = nome.split(' ').filter(p => p.length > 2)

  // Busca ampla — retorna tudo do representante para o algoritmo filtrar
  const { data, error } = await supabase
    .from('vw_catalogo_preco_efetivo')
    .select('*')
    .eq('representante_id', representanteId)
    .order('preco_efetivo', { ascending: true })

  if (error) throw error
  if (!data?.length) return []

  // Filtra localmente os que têm alguma palavra em comum ou marca bate
  return data.filter(item => {
    const prodCat = normalizarNome(item.produto)
    const marcaCat = normalizarNome(item.marca ?? '')

    // Checa se alguma palavra do pedido aparece no produto ou marca do catálogo
    return palavras.some(p =>
      prodCat.includes(p) || marcaCat.includes(p) || p.includes(marcaCat)
    ) || prodCat.includes(nome) || nome.includes(prodCat)
  })
}

export async function buscarCatalogoCompleto(representanteId) {
  const { data, error } = await supabase
    .from('vw_catalogo_preco_efetivo')
    .select('*')
    .eq('representante_id', representanteId)
    .order('produto')

  if (error) throw error
  return data ?? []
}

// ── Upsert de item no catálogo ────────────────────────────────────────
// Insere ou atualiza — o trigger do banco grava o histórico automaticamente

export async function upsertCatalogoItem(representanteId, item, origem = 'manual') {
  /**
   * item = { produto, marca?, unidade?, sku?, preco_unitario,
   *          prazo_pagamento_dias?, prazo_entrega_dias?, valido_ate? }
   */
  const { data, error } = await supabase
    .from('catalogo_representante')
    .upsert({
      representante_id:     representanteId,
      produto:              item.produto,
      marca:                item.marca ?? null,
      unidade:              item.unidade ?? null,
      sku:                  item.sku ?? null,
      preco_unitario:       item.preco_unitario,
      prazo_pagamento_dias: item.prazo_pagamento_dias ?? null,
      prazo_entrega_dias:   item.prazo_entrega_dias ?? null,
      valido_ate:           item.valido_ate ?? null,
      ativo:                true,
      origem,
    }, {
      onConflict: 'representante_id,produto,unidade',
      ignoreDuplicates: false,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

// ── Upsert em lote (upload de planilha/PDF) ───────────────────────────

export async function upsertCatalogoEmLote(representanteId, itens, origem = 'excel') {
  const resultados = { inseridos: 0, atualizados: 0, erros: [] }

  for (const item of itens) {
    try {
      // Busca se já existe para saber se é insert ou update
      const { data: existente } = await supabase
        .from('catalogo_representante')
        .select('id, preco_unitario')
        .eq('representante_id', representanteId)
        .ilike('produto', item.produto)
        .eq('unidade', item.unidade ?? '')
        .maybeSingle()

      await upsertCatalogoItem(representanteId, item, origem)

      if (existente) {
        resultados.atualizados++
      } else {
        resultados.inseridos++
      }
    } catch (err) {
      resultados.erros.push({ produto: item.produto, erro: err.message })
    }
  }

  return resultados
}

// ── Promoções ─────────────────────────────────────────────────────────

export async function salvarPromocao(representanteId, promo) {
  /**
   * promo = { produto, marca?, unidade?, preco_normal?, preco_promo,
   *           valida_de?, valida_ate, obs? }
   */
  const desconto = promo.preco_normal
    ? Math.round(((promo.preco_normal - promo.preco_promo) / promo.preco_normal) * 100)
    : null

  const { data, error } = await supabase
    .from('catalogo_promocoes')
    .insert({
      representante_id: representanteId,
      produto:          promo.produto,
      marca:            promo.marca ?? null,
      unidade:          promo.unidade ?? null,
      preco_normal:     promo.preco_normal ?? null,
      preco_promo:      promo.preco_promo,
      desconto_pct:     desconto,
      valida_de:        promo.valida_de ?? new Date().toISOString().split('T')[0],
      valida_ate:       promo.valida_ate,
      obs:              promo.obs ?? null,
      ativo:            true,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

// ── Histórico de preços ───────────────────────────────────────────────

export async function getHistoricoPrecos(representanteId, produto = null, limite = 50) {
  let query = supabase
    .from('catalogo_historico')
    .select('*, representantes(nome, empresa)')
    .eq('representante_id', representanteId)
    .order('alterado_em', { ascending: false })
    .limit(limite)

  if (produto) query = query.ilike('produto', `%${produto}%`)

  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

// Histórico de preços de um produto entre TODOS os representantes
export async function getHistoricoPrecosPorProduto(produto, limite = 100) {
  const { data, error } = await supabase
    .from('catalogo_historico')
    .select('*, representantes(nome, empresa)')
    .ilike('produto', `%${produto}%`)
    .order('alterado_em', { ascending: false })
    .limit(limite)

  if (error) throw error
  return data ?? []
}

// ── Utilitários ───────────────────────────────────────────────────────

export function normalizarNome(nome) {
  return (nome ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
}
