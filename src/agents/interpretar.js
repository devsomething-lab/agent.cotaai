/**
 * interpretar.js — Utilitário de interpretação inteligente de dados
 *
 * Filosofia: parse local primeiro → IA só entra quando o parse local falha.
 * Chamadas à IA são feitas em lote para minimizar latência e custo.
 *
 * Usado por: catalogo_agent.js, extractor.js, auto_quote.js
 */

import Anthropic from '@anthropic-ai/sdk'
import 'dotenv/config'

const client = new Anthropic()

// ── Parse local de prazo (dias) ───────────────────────────────────────
// Cobre os casos mais comuns sem precisar de IA

export function parsePrazoLocal(val) {
  if (val == null) return null
  if (typeof val === 'number') return Math.round(val) || 0

  const s = String(val).toLowerCase().trim()
  if (!s || s === 'null') return null

  // À vista
  if (/\bvista\b|à vista|avista|0d|0 dia/.test(s)) return 0

  // Número direto: "30", "30d", "30dd", "30 dias", "30dias"
  const simples = s.match(/^(\d+)\s*d(ias?)?/)
  if (simples) return parseInt(simples[1])

  // "30/60" → pega o menor (mais conservador)
  const barra = s.match(/(\d+)\s*\/\s*(\d+)/)
  if (barra) return Math.min(parseInt(barra[1]), parseInt(barra[2]))

  // Apenas número
  const num = parseInt(s)
  if (!isNaN(num)) return num

  return null // sinaliza para IA
}

// ── Parse local de unidade ────────────────────────────────────────────

const UNIDADES_MAPA = {
  cx: 'caixa', cxa: 'caixa', caixa: 'caixa', box: 'caixa',
  fd: 'fardo', fdo: 'fardo', fardo: 'fardo',
  pct: 'pacote', pacote: 'pacote', pac: 'pacote',
  un: 'unidade', und: 'unidade', unid: 'unidade', unidade: 'unidade', pc: 'unidade',
  lt: 'lata', lata: 'lata', lts: 'lata',
  gf: 'garrafa', garrafa: 'garrafa', grf: 'garrafa',
  gl: 'galão', galao: 'galão', galão: 'galão',
  kg: 'kg', quilo: 'kg', quilos: 'kg',
  g: 'g', gr: 'g', gramas: 'g',
  l: 'l', lt: 'l', litro: 'l', litros: 'l',
  ml: 'ml',
  sc: 'saco', saco: 'saco', sac: 'saco',
  bd: 'bandeja', bandeja: 'bandeja', band: 'bandeja',
}

export function parseUnidadeLocal(val) {
  if (val == null) return null
  const s = String(val).toLowerCase().trim().replace(/[.\s]/g, '')
  if (!s || s === 'null') return null

  // Match direto
  if (UNIDADES_MAPA[s]) return UNIDADES_MAPA[s]

  // Pega primeira palavra (ex: "caixa c/12" → "caixa")
  const primeira = s.split(/[\s/,c(]/)[0]
  if (UNIDADES_MAPA[primeira]) return UNIDADES_MAPA[primeira]

  return null // sinaliza para IA
}

// ── Interpretação em lote por IA ──────────────────────────────────────
// Recebe array de { campo, valor } e retorna array de valores normalizados
// Só chamado quando parse local retorna null para algum item

export async function interpretarCamposComIA(itens) {
  /**
   * itens = [{ campo: 'prazo_pagamento_dias' | 'prazo_entrega_dias' | 'unidade' | 'valido_ate', valor: any }]
   * Retorna: array de valores normalizados na mesma ordem
   */
  if (!itens.length) return []

  const prompt = itens.map((it, i) =>
    `${i + 1}. campo="${it.campo}" valor="${it.valor}"`
  ).join('\n')

  const system = `Você normaliza dados de catálogos de produtos brasileiros para inserção em banco de dados.

Para cada item, normalize o valor conforme o campo:

- prazo_pagamento_dias → número inteiro de dias (0 = à vista, null se impossível de determinar)
  Ex: "30 dias" → 30, "à vista" → 0, "quinzenal" → 15, "mensal" → 30, "2x 30 dias" → 30

- prazo_entrega_dias → número inteiro de dias (0 = imediato, null se impossível)
  Ex: "2 dias úteis" → 2, "imediato" → 0, "1 semana" → 7, "D+2" → 2

- unidade → string normalizada: unidade | caixa | fardo | pacote | kg | g | l | ml | lata | garrafa | galão | saco | bandeja
  Ex: "cx c/12" → "caixa", "FD" → "fardo", "KG" → "kg", "250ml" → "ml"

- valido_ate → data no formato YYYY-MM-DD (null se inválido ou impossível)
  Ex: "07/05/2026" → "2026-05-07", "maio 2026" → "2026-05-31", "31.12.25" → "2025-12-31"

RETORNE APENAS um array JSON com os valores normalizados na mesma ordem, sem texto adicional.
Use null para campos impossíveis de determinar.
Exemplo: [30, 2, "caixa", "2026-05-07"]`

  try {
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system,
      messages:   [{ role: 'user', content: prompt }],
    })
    const raw    = resp.content[0].text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length === itens.length) {
      console.log('[interpretar] IA normalizou:', itens.map((it, i) => `${it.campo}:"${it.valor}"→${parsed[i]}`).join(', '))
      return parsed
    }
  } catch (err) {
    console.warn('[interpretar] erro na interpretação por IA:', err.message)
  }

  // Fallback: retorna null para todos (melhor do que dado errado)
  return itens.map(() => null)
}

// ── Função principal: normaliza um item do catálogo completo ──────────
// Tenta parse local; só chama IA para os campos que falharam

export async function normalizarItemCatalogo(item) {
  /**
   * item = { produto, marca, unidade, preco_unitario,
   *          prazo_pagamento_dias, prazo_entrega_dias, valido_ate, ... }
   * Retorna o item com campos normalizados.
   */

  // Parse local de cada campo
  const prazosPag    = parsePrazoLocal(item.prazo_pagamento_dias)
  const prazosEnt    = parsePrazoLocal(item.prazo_entrega_dias)
  const unidade      = parseUnidadeLocal(item.unidade) ?? item.unidade // mantém original se não mapeado

  // Coleta campos que precisam de IA (parse local retornou null mas havia valor)
  const paraIA = []
  if (prazosPag === null && item.prazo_pagamento_dias != null)
    paraIA.push({ campo: 'prazo_pagamento_dias', valor: item.prazo_pagamento_dias, idx: paraIA.length })
  if (prazosEnt === null && item.prazo_entrega_dias != null)
    paraIA.push({ campo: 'prazo_entrega_dias', valor: item.prazo_entrega_dias, idx: paraIA.length })
  if (unidade === item.unidade && item.unidade != null && parseUnidadeLocal(item.unidade) === null)
    paraIA.push({ campo: 'unidade', valor: item.unidade, idx: paraIA.length })

  let prazo_pagamento_final = prazosPag
  let prazo_entrega_final   = prazosEnt
  let unidade_final         = unidade

  if (paraIA.length > 0) {
    const resultados = await interpretarCamposComIA(paraIA)
    for (let i = 0; i < paraIA.length; i++) {
      const { campo } = paraIA[i]
      if (campo === 'prazo_pagamento_dias') prazo_pagamento_final = resultados[i]
      if (campo === 'prazo_entrega_dias')   prazo_entrega_final   = resultados[i]
      if (campo === 'unidade')              unidade_final         = resultados[i] ?? item.unidade
    }
  }

  return {
    ...item,
    unidade:              unidade_final,
    prazo_pagamento_dias: prazo_pagamento_final,
    prazo_entrega_dias:   prazo_entrega_final,
  }
}

// ── Normaliza lista de itens em lote ──────────────────────────────────
// Agrupa todos os campos que precisam de IA numa única chamada

export async function normalizarItensCatalogoEmLote(itens) {
  if (!itens.length) return itens

  // Parse local para todos
  const resultados = itens.map(item => ({
    ...item,
    _prazo_pag: parsePrazoLocal(item.prazo_pagamento_dias),
    _prazo_ent: parsePrazoLocal(item.prazo_entrega_dias),
    _unidade:   parseUnidadeLocal(item.unidade),
  }))

  // Coleta todos que precisam de IA
  const paraIA = []
  resultados.forEach((item, itemIdx) => {
    if (item._prazo_pag === null && item.prazo_pagamento_dias != null)
      paraIA.push({ campo: 'prazo_pagamento_dias', valor: item.prazo_pagamento_dias, itemIdx })
    if (item._prazo_ent === null && item.prazo_entrega_dias != null)
      paraIA.push({ campo: 'prazo_entrega_dias', valor: item.prazo_entrega_dias, itemIdx })
    if (item._unidade === null && item.unidade != null)
      paraIA.push({ campo: 'unidade', valor: item.unidade, itemIdx })
  })

  // Única chamada à IA para todos os campos de todos os itens
  if (paraIA.length > 0) {
    const interpretados = await interpretarCamposComIA(paraIA)
    paraIA.forEach(({ campo, itemIdx }, i) => {
      if (campo === 'prazo_pagamento_dias') resultados[itemIdx]._prazo_pag = interpretados[i]
      if (campo === 'prazo_entrega_dias')   resultados[itemIdx]._prazo_ent = interpretados[i]
      if (campo === 'unidade')              resultados[itemIdx]._unidade   = interpretados[i]
    })
  }

  // Aplica resultados e limpa campos internos
  return resultados.map(({ _prazo_pag, _prazo_ent, _unidade, ...item }) => ({
    ...item,
    prazo_pagamento_dias: _prazo_pag,
    prazo_entrega_dias:   _prazo_ent,
    unidade:              _unidade ?? item.unidade,
  }))
}
