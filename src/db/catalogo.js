import { supabase } from './client.js'
import Anthropic from '@anthropic-ai/sdk'
import 'dotenv/config'

const client = new Anthropic()

// ── Feature 1: Normalização de produto com IA ─────────────────────────
// Transforma nomes abreviados/coloquiais em nomes canônicos + variações
// Ex: "det ypê 500" → { nome: "Detergente Ypê 500ml", variacoes: [...] }

export async function normalizarProdutoComIA(nomeProduto) {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: `Você normaliza nomes de produtos de varejo/atacado brasileiro para busca em catálogo.
Dado um nome de produto (possivelmente abreviado, com erros ou coloquial), retorne:
- nome: versão normalizada e expandida (capitalize corretamente, expanda abreviações, inclua marca se óbvia)
- variacoes: lista de sinônimos e variações comuns que esse produto pode ter no catálogo

Exemplos de entrada → saída:
"coca 2l" → {"nome": "Coca-Cola 2L", "variacoes": ["refrigerante cola 2l", "coca cola 2 litros", "refrigerante coca"]}
"det ype 500" → {"nome": "Detergente Ypê 500ml", "variacoes": ["detergente ypê", "detergente 500ml", "det ypê"]}
"leite ninho 400" → {"nome": "Leite Ninho 400g", "variacoes": ["leite em pó ninho", "leite ninho nestlé 400g", "ninho 400"]}
"agua min galao" → {"nome": "Água Mineral Galão 20L", "variacoes": ["água mineral 20l", "galão água", "water galão"]}
"azeite extra vg 500" → {"nome": "Azeite de Oliva Extra Virgem 500ml", "variacoes": ["azeite extra virgem", "azeite 500ml"]}

RETORNE APENAS JSON válido, sem texto adicional:
{"nome": "string", "variacoes": ["string", "string"]}`,
      messages: [{ role: 'user', content: nomeProduto }],
    })
    const raw = response.content[0].text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(raw)
    return {
      nome: parsed.nome ?? nomeProduto,
      variacoes: Array.isArray(parsed.variacoes) ? parsed.variacoes : [],
    }
  } catch (err) {
    console.warn('[normalizarProdutoComIA] fallback para original:', err.message)
    return { nome: nomeProduto, variacoes: [] }
  }
}

// ── Busca itens do catálogo para cotação automática ───────────────────
// Feature 1: normaliza com IA antes de buscar para ampliar recall do matching

export async function buscarCatalogoPorProduto(representanteId, nomeProduto) {
  // 1. Normaliza com IA — transforma "det ypê" em "Detergente Ypê" + variações
  const { nome: nomeNormalizado, variacoes } = await normalizarProdutoComIA(nomeProduto)

  // 2. Monta pool de termos de busca (original + normalizado + variações)
  const todosOsNomes = [
    normalizarNome(nomeProduto),
    normalizarNome(nomeNormalizado),
    ...variacoes.map(v => normalizarNome(v)),
  ]

  // 3. Extrai palavras únicas com mais de 2 chars para filtro amplo
  const palavras = [...new Set(
    todosOsNomes.flatMap(n => n.split(' ').filter(p => p.length > 2))
  )]

  console.log(`[catalogo] buscando "${nomeProduto}" → normalizado: "${nomeNormalizado}" | palavras: ${palavras.join(', ')}`)

  // 4. Busca tudo do representante (filtro local é mais eficiente que múltiplas queries)
  const { data, error } = await supabase
    .from('vw_catalogo_preco_efetivo')
    .select('*')
    .eq('representante_id', representanteId)
    .order('preco_efetivo', { ascending: true })

  if (error) throw error
  if (!data?.length) return []

  // 5. Filtra por qualquer palavra ou nome completo
  return data.filter(item => {
    const prodCat  = normalizarNome(item.produto)
    const marcaCat = normalizarNome(item.marca ?? '')

    return palavras.some(p =>
      prodCat.includes(p) || marcaCat.includes(p) || p.includes(marcaCat)
    ) || todosOsNomes.some(n => prodCat.includes(n) || n.includes(prodCat))
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
// Feature 4: detecta variação > 10% e retorna alerta junto com os dados

export async function upsertCatalogoItem(representanteId, item, origem = 'manual') {
  // Feature 4: captura preço anterior ANTES do upsert para calcular variação
  let precoAnterior = null
  try {
    const { data: existente } = await supabase
      .from('catalogo_representante')
      .select('preco_unitario')
      .eq('representante_id', representanteId)
      .ilike('produto', item.produto)
      .eq('unidade', item.unidade ?? '')
      .maybeSingle()
    precoAnterior = existente?.preco_unitario ?? null
  } catch { /* não impede o upsert */ }

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

  // Feature 4: calcula variação e anexa alerta se >= 10%
  let _alerta = null
  if (
    precoAnterior != null &&
    item.preco_unitario != null &&
    precoAnterior !== 0
  ) {
    const variacaoPct = ((item.preco_unitario - precoAnterior) / precoAnterior) * 100
    if (Math.abs(variacaoPct) >= 10) {
      _alerta = {
        produto:        item.produto,
        marca:          item.marca ?? null,
        unidade:        item.unidade ?? null,
        preco_anterior: precoAnterior,
        preco_novo:     item.preco_unitario,
        variacao_pct:   Math.round(variacaoPct * 10) / 10, // 1 casa decimal
        subiu:          variacaoPct > 0,
      }
      console.log(`[catalogo] alerta variação: ${item.produto} ${_alerta.variacao_pct > 0 ? '+' : ''}${_alerta.variacao_pct}%`)
    }
  }

  return { ...data, _alerta }
}

// ── Upsert em lote (upload de planilha/PDF) ───────────────────────────
// Feature 4: coleta e retorna todos os alertas de variação

export async function upsertCatalogoEmLote(representanteId, itens, origem = 'excel') {
  const resultados = { inseridos: 0, atualizados: 0, erros: [], alertas: [] }

  for (const item of itens) {
    try {
      // Busca se já existe para contar insert vs update
      const { data: existente } = await supabase
        .from('catalogo_representante')
        .select('id, preco_unitario')
        .eq('representante_id', representanteId)
        .ilike('produto', item.produto)
        .eq('unidade', item.unidade ?? '')
        .maybeSingle()

      const resultado = await upsertCatalogoItem(representanteId, item, origem)

      // Feature 4: coleta alerta se presente
      if (resultado._alerta) {
        resultados.alertas.push(resultado._alerta)
      }

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
