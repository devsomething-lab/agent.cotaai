import Anthropic from '@anthropic-ai/sdk'
import { downloadMedia } from '../services/whatsapp.js'
import * as XLSX from 'xlsx'
import 'dotenv/config'

const client = new Anthropic()

// ── Extrai catálogo de preços de qualquer formato ─────────────────────

export async function extrairCatalogo(mensagem) {
  /**
   * mensagem = { tipo: 'texto'|'foto'|'pdf'|'planilha', texto?, mediaId?, mimeType? }
   * Retorna: { itens: [{produto, marca, unidade, preco_unitario,
   *                     prazo_pagamento_dias, prazo_entrega_dias, valido_ate, sku}],
   *            tipo_documento, confianca }
   */

  // Planilha: parse local com xlsx antes de mandar para IA
  if (mensagem.tipo === 'planilha' && mensagem.mediaId) {
    return extrairCatalogoDeExcel(mensagem.mediaId)
  }

  const system = `Você é um especialista em extrair tabelas de preços de representantes comerciais brasileiros.

Sua tarefa: identificar TODOS os produtos com preços e condições comerciais.

Regras de extração:
- Produto: normalize o nome (ex: "coca 2l" → "Coca-Cola 2L")
- Unidade: identifique embalagem (caixa, fardo, pacote, kg, unidade, lata, garrafa)
- Preço: extraia apenas o valor numérico (sem R$)
- Prazo pagamento: converta para dias (ex: "30 dias", "30/60" → 30, "à vista" → 0)
- Prazo entrega: converta para dias (ex: "2 dias úteis" → 2)
- SKU: código do produto se mencionado, senão null
- valido_ate: se mencionar validade (ex: "preços válidos até 31/03"), use formato YYYY-MM-DD, senão null

Se o representante mencionar condições gerais (ex: "todos os produtos: pagamento em 30 dias"), aplique a todos os itens.

RETORNE APENAS JSON, sem texto adicional:
{
  "itens": [
    {
      "produto": "string",
      "marca": "string ou null",
      "unidade": "string ou null",
      "sku": "string ou null",
      "preco_unitario": número,
      "prazo_pagamento_dias": número ou null,
      "prazo_entrega_dias": número ou null,
      "valido_ate": "YYYY-MM-DD ou null"
    }
  ],
  "tipo_documento": "tabela_precos | lista_produtos | promocao | indefinido",
  "confianca": "alta | media | baixa",
  "prazo_pagamento_geral": número ou null,
  "prazo_entrega_geral": número ou null,
  "validade_geral": "YYYY-MM-DD ou null"
}`

  const content = []

  if (mensagem.texto) {
    content.push({ type: 'text', text: `Tabela de preços do representante:\n${mensagem.texto}` })
  }

  if (mensagem.mediaId && mensagem.tipo === 'foto') {
    try {
      const { buffer, mimeType } = await downloadMedia(mensagem.mediaId)
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: buffer.toString('base64') },
      })
      content.push({ type: 'text', text: 'Extraia todos os produtos com preços visíveis nesta imagem.' })
    } catch (err) {
      console.error('[extrairCatalogo] erro mídia:', err.message)
    }
  }

  if (mensagem.mediaId && mensagem.tipo === 'pdf') {
    try {
      const { buffer } = await downloadMedia(mensagem.mediaId)
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
      })
      content.push({ type: 'text', text: 'Extraia todos os produtos com preços deste documento.' })
    } catch (err) {
      console.error('[extrairCatalogo] erro pdf:', err.message)
    }
  }

  if (!content.length) throw new Error('Nenhum conteúdo para processar')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content }],
  })

  const raw = response.content[0].text.trim().replace(/```json|```/g, '').trim()

  try {
    const parsed = JSON.parse(raw)
    // Aplica condições gerais nos itens que não têm
    if (parsed.prazo_pagamento_geral || parsed.prazo_entrega_geral || parsed.validade_geral) {
      parsed.itens = parsed.itens.map(it => ({
        ...it,
        prazo_pagamento_dias: it.prazo_pagamento_dias ?? parsed.prazo_pagamento_geral,
        prazo_entrega_dias:   it.prazo_entrega_dias   ?? parsed.prazo_entrega_geral,
        valido_ate:           it.valido_ate            ?? parsed.validade_geral,
      }))
    }
    return parsed
  } catch {
    throw new Error(`IA retornou JSON inválido: ${raw.slice(0, 200)}`)
  }
}

// ── Extração específica de Excel ──────────────────────────────────────

async function extrairCatalogoDeExcel(mediaId) {
  const { buffer } = await downloadMedia(mediaId)
  const wb = XLSX.read(buffer)
  const ws = wb.Sheets[wb.SheetNames[0]]
  const linhas = XLSX.utils.sheet_to_json(ws, { defval: null })

  if (!linhas.length) throw new Error('Planilha vazia ou formato não reconhecido')

  // Tenta mapear colunas automaticamente com IA
  const amostra = linhas.slice(0, 5)
  const colunas = Object.keys(linhas[0] ?? {})

  const system = `Você é um especialista em tabelas de preços de distribuidoras brasileiras.

Dado um array JSON com as primeiras linhas de uma planilha Excel, mapeie as colunas para os campos:
produto, marca, unidade, sku, preco_unitario, prazo_pagamento_dias, prazo_entrega_dias, valido_ate

Colunas disponíveis: ${JSON.stringify(colunas)}
Amostra das primeiras linhas: ${JSON.stringify(amostra)}

RETORNE APENAS JSON:
{
  "mapeamento": {
    "produto": "nome_da_coluna_ou_null",
    "marca": "nome_da_coluna_ou_null",
    "unidade": "nome_da_coluna_ou_null",
    "sku": "nome_da_coluna_ou_null",
    "preco_unitario": "nome_da_coluna_ou_null",
    "prazo_pagamento_dias": "nome_da_coluna_ou_null",
    "prazo_entrega_dias": "nome_da_coluna_ou_null",
    "valido_ate": "nome_da_coluna_ou_null"
  }
}`

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    system,
    messages: [{ role: 'user', content: 'Mapeie as colunas desta planilha.' }],
  })

  const mapa = JSON.parse(resp.content[0].text.replace(/```json|```/g, '').trim()).mapeamento

  // Converte todas as linhas usando o mapeamento
  const itens = linhas
    .filter(l => l[mapa.produto] != null)
    .map(l => ({
      produto:              String(l[mapa.produto] ?? '').trim(),
      marca:                mapa.marca             ? String(l[mapa.marca] ?? '').trim() || null : null,
      unidade:              mapa.unidade            ? String(l[mapa.unidade] ?? '').trim() || null : null,
      sku:                  mapa.sku               ? String(l[mapa.sku] ?? '').trim() || null : null,
      preco_unitario:       mapa.preco_unitario     ? parsePreco(l[mapa.preco_unitario]) : null,
      prazo_pagamento_dias: mapa.prazo_pagamento_dias ? parseInt(l[mapa.prazo_pagamento_dias]) || null : null,
      prazo_entrega_dias:   mapa.prazo_entrega_dias   ? parseInt(l[mapa.prazo_entrega_dias]) || null : null,
      valido_ate:           mapa.valido_ate          ? parseData(l[mapa.valido_ate]) : null,
    }))
    .filter(it => it.produto && it.preco_unitario != null)

  return { itens, tipo_documento: 'tabela_precos', confianca: 'alta' }
}

// ── Detecta se mensagem do rep é tabela de preços ou resposta de cotação

export async function classificarMensagemRep(texto) {
  /**
   * Retorna: 'catalogo' | 'cotacao' | 'promocao' | 'outro'
   * - catalogo:  rep está enviando/atualizando tabela de preços
   * - cotacao:   rep está respondendo uma cotação específica
   * - promocao:  rep está comunicando uma promoção temporária
   * - outro:     mensagem genérica
   */
  const system = `Classifique a mensagem de um representante comercial em uma categoria:

- catalogo:  enviando tabela de preços geral, lista de produtos com valores, ou arquivo de preços
- cotacao:   respondendo a uma solicitação específica de cotação (menciona itens solicitados)
- promocao:  comunicando promoção com prazo de validade ("válido até", "essa semana", "por tempo limitado")
- outro:     saudação, pergunta, outro assunto

RETORNE APENAS UMA PALAVRA: catalogo | cotacao | promocao | outro`

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 10,
    system,
    messages: [{ role: 'user', content: texto }],
  })

  const classificacao = resp.content[0].text.trim().toLowerCase()
  return ['catalogo', 'cotacao', 'promocao', 'outro'].includes(classificacao) ? classificacao : 'outro'
}

// ── Helpers ───────────────────────────────────────────────────────────

function parsePreco(val) {
  if (val == null) return null
  const str = String(val).replace(/[R$\s]/g, '').replace(',', '.')
  const num = parseFloat(str)
  return isNaN(num) ? null : num
}

function parseData(val) {
  if (!val) return null
  try {
    const d = new Date(val)
    if (isNaN(d.getTime())) return null
    return d.toISOString().split('T')[0]
  } catch {
    return null
  }
}
