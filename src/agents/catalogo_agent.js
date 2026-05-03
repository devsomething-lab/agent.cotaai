import Anthropic from '@anthropic-ai/sdk'
import { downloadMedia } from '../services/whatsapp.js'
import * as XLSX from 'xlsx'
import { normalizarItensCatalogoEmLote } from './interpretar.js'
import 'dotenv/config'

const client = new Anthropic()

// ── Prompts por tipo de documento ─────────────────────────────────────
// Feature 2: prompts especializados por mídia para maximizar recall

const SYSTEM_BASE = `Você é um especialista em extrair tabelas de preços de representantes comerciais brasileiros.

Sua tarefa: identificar TODOS os produtos com preços e condições comerciais.

Regras de extração:
- Produto: normalize o nome (ex: "coca 2l" → "Coca-Cola 2L", "det ypê" → "Detergente Ypê")
- Unidade: identifique embalagem (caixa, fardo, pacote, kg, unidade, lata, garrafa, galão)
- Preço: extraia apenas o valor numérico (sem R$). Vírgula = decimal (ex: "12,50" → 12.5)
- Prazo pagamento: converta para dias ("30 dias" → 30, "30/60" → 30, "à vista" → 0, "30dd" → 30)
- Prazo entrega: converta para dias ("2 dias úteis" → 2, "imediato" → 0)
- SKU: código alfanumérico se mencionado, senão null
- valido_ate: se mencionar validade ("válido até 31/03", "até 30/04/2025"), formato YYYY-MM-DD; senão null
- Se houver condições gerais ("todos 30 dias pgto"), aplique a todos os itens sem prazo específico

RETORNE APENAS JSON válido, sem texto, markdown ou explicações:
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

// Feature 2: prompt adicional para FOTOS (manuscritas ou impressas com baixa qualidade)
const INSTRUCOES_FOTO = `
INSTRUÇÕES ESPECÍFICAS PARA IMAGEM:
- A imagem pode ser foto de papel manuscrito, caderno, bloco de notas ou planilha impressa
- Leia com atenção escritas cursivas ou em letra de forma, mesmo que imperfeitas
- Preços podem estar escritos como "12,50", "R$12.50", "12/50", "$12" — trate todos como preço
- Colunas podem estar desalinhadas; use contexto da linha para associar produto ao preço correto
- Se a imagem estiver cortada, inclinada ou com sombra, faça o melhor possível com o visível
- Produtos riscados, sublinhados ou com asterisco provavelmente têm destaque especial (promoção)
- Se um preço parecer impossível (ex: R$ 0,10 para leite) desconfie e marque confiança como "baixa"
- NÃO invente produtos ou preços que não estejam legíveis — omita itens ilegíveis
- Para cada item duvidoso, inclua a leitura mais provável e marque confianca: "baixa"`

// Feature 2: prompt adicional para PDFs (especialmente tabelões mal formatados)
const INSTRUCOES_PDF = `
INSTRUÇÕES ESPECÍFICAS PARA PDF:
- O PDF pode ser uma tabela de preços gerada em sistema legado, exportação de ERP ou PDF escaneado
- Ignore cabeçalhos repetidos, rodapés, numeração de página e marcas d'água
- Preços podem estar em colunas separadas (preço unitário, preço caixa, preço atacado) — use o menor ou o unitário
- Linhas de subtotal, total ou CNPJ/endereço devem ser ignoradas
- Códigos de produto (SKU) geralmente são sequências numéricas ou alfanuméricas antes do nome do produto
- Se o PDF tiver múltiplas seções/categorias, processe todas — não pare na primeira
- Tabelas com colunas "qtd mínima" indicam venda por caixa/fardo; inclua na unidade
- Descontos por volume: use o preço base (sem desconto) como preco_unitario`

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

  // Feature 2: monta system prompt especializado por tipo de mídia
  const systemExtra = mensagem.tipo === 'foto' ? INSTRUCOES_FOTO
                    : mensagem.tipo === 'pdf'  ? INSTRUCOES_PDF
                    : ''
  const system = SYSTEM_BASE + systemExtra

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
      // Feature 2: instrução de tarefa mais explícita para fotos
      content.push({
        type: 'text',
        text: [
          'Extraia TODOS os produtos com preços visíveis nesta imagem.',
          'Se for manuscrito, leia com atenção cada linha.',
          'Não pule itens — mesmo parcialmente legíveis devem ser incluídos com confiança "baixa".',
        ].join(' '),
      })
    } catch (err) {
      console.error('[extrairCatalogo] erro mídia foto:', err.message)
    }
  }

  if (mensagem.mediaId && mensagem.tipo === 'pdf') {
    try {
      const { buffer } = await downloadMedia(mensagem.mediaId)
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
      })
      // Feature 2: instrução mais completa para PDFs
      content.push({
        type: 'text',
        text: [
          'Extraia TODOS os produtos com preços deste documento.',
          'Processe todas as páginas e seções.',
          'Ignore cabeçalhos, rodapés e totais.',
          'Identifique e mapeie todas as colunas da tabela.',
        ].join(' '),
      })
    } catch (err) {
      console.error('[extrairCatalogo] erro pdf:', err.message)
    }
  }

  if (!content.length) throw new Error('Nenhum conteúdo para processar')

  // Feature 2: para fotos/PDFs usa max_tokens maior para não truncar tabelas longas
  const maxTokens = ['foto', 'pdf'].includes(mensagem.tipo) ? 8192 : 4096

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
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

    // Feature 2: para fotos com confiança baixa, filtra itens sem preço
    if (mensagem.tipo === 'foto' && parsed.confianca === 'baixa') {
      const antes = parsed.itens.length
      parsed.itens = parsed.itens.filter(it => it.preco_unitario != null)
      if (antes !== parsed.itens.length) {
        console.log(`[extrairCatalogo] foto baixa confiança: ${antes - parsed.itens.length} item(s) sem preço removidos`)
      }
    }

    // Normaliza prazo e unidade via IA para valores ambíguos
    parsed.itens = await normalizarItensCatalogoEmLote(parsed.itens)

    return parsed
  } catch {
    throw new Error(`IA retornou JSON inválido: ${raw.slice(0, 200)}`)
  }
}

// ── Extração específica de Excel ──────────────────────────────────────

async function extrairCatalogoDeExcel(mediaId) {
  const { buffer } = await downloadMedia(mediaId)
  const wb = XLSX.read(buffer, { cellDates: true }) // força Date objects nativos
  const ws = wb.Sheets[wb.SheetNames[0]]

  // raw: false → SheetJS formata datas como string ISO (YYYY-MM-DD)
  // cellDates: true no read + raw: false no json = datas seguras sem problema de timezone
  const linhas = XLSX.utils.sheet_to_json(ws, {
    defval:  null,
    raw:     false,
    dateNF:  'yyyy-mm-dd',  // garante formato ISO independente do locale
  })

  if (!linhas.length) throw new Error('Planilha vazia ou formato não reconhecido')

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
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system,
    messages: [{ role: 'user', content: 'Mapeie as colunas desta planilha.' }],
  })

  const mapa = JSON.parse(resp.content[0].text.replace(/```json|```/g, '').trim()).mapeamento

  // Coleta valores brutos de valido_ate para normalização por IA em lote
  const valoresData = mapa.valido_ate
    ? linhas.filter(l => l[mapa.produto] != null && l[mapa.valido_ate] != null)
            .map(l => l[mapa.valido_ate])
    : []

  // Normalização por IA: interpreta qualquer formato de data em lote (safety net)
  const datasNormalizadas = await normalizarDatasComIA(valoresData)

  let dataIndex = 0
  const itens = linhas
    .filter(l => l[mapa.produto] != null)
    .map(l => {
      const temData = mapa.valido_ate && l[mapa.valido_ate] != null
      const valido_ate = temData ? datasNormalizadas[dataIndex++] : null
      return {
        produto:              String(l[mapa.produto] ?? '').trim(),
        marca:                mapa.marca             ? limparString(l[mapa.marca])   : null,
        unidade:              mapa.unidade            ? limparString(l[mapa.unidade]) : null,
        sku:                  mapa.sku               ? limparString(l[mapa.sku])     : null,
        preco_unitario:       mapa.preco_unitario     ? parsePreco(l[mapa.preco_unitario]) : null,
        prazo_pagamento_dias: mapa.prazo_pagamento_dias ? parseInt(l[mapa.prazo_pagamento_dias]) || null : null,
        prazo_entrega_dias:   mapa.prazo_entrega_dias   ? parseInt(l[mapa.prazo_entrega_dias]) || null : null,
        valido_ate,
      }
    })
    .filter(it => it.produto && it.preco_unitario != null)

  // Normaliza prazo e unidade via IA para valores que o parse local não reconheceu
  const itensNormalizados = await normalizarItensCatalogoEmLote(itens)

  return { itens: itensNormalizados, tipo_documento: 'tabela_precos', confianca: 'alta' }
}

// ── Normalização de datas por IA ──────────────────────────────────────
// Recebe array de valores brutos (qualquer formato) e retorna YYYY-MM-DD ou null
// Chamada única em lote para minimizar custo e latência

async function normalizarDatasComIA(valores) {
  if (!valores.length) return []

  // Tenta parse local primeiro para evitar chamada desnecessária à IA
  const resultados = valores.map(parseData)
  const precisamIA = resultados.some(r => r === null || r === '1970-01-01')

  if (!precisamIA) return resultados

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `Converta cada valor do array para o formato YYYY-MM-DD.
Aceite qualquer formato: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, timestamps ISO, serial Excel, etc.
Se um valor não for uma data válida ou for claramente inválido (ex: 1970-01-01), retorne null para ele.
RETORNE APENAS um array JSON sem texto adicional. Ex: ["2026-05-07", null, "2025-12-31"]`,
      messages: [{ role: 'user', content: JSON.stringify(valores) }],
    })
    const raw = resp.content[0].text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length === valores.length) {
      console.log('[normalizarDatasComIA] datas corrigidas via IA:', parsed)
      return parsed
    }
  } catch (err) {
    console.warn('[normalizarDatasComIA] fallback para parse local:', err.message)
  }

  // Fallback: retorna parse local (pode ter nulls)
  return resultados.map(r => (r === '1970-01-01' ? null : r))
}

  if (!linhas.length) throw new Error('Planilha vazia ou formato não reconhecido')

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
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system,
    messages: [{ role: 'user', content: 'Mapeie as colunas desta planilha.' }],
  })

  const mapa = JSON.parse(resp.content[0].text.replace(/```json|```/g, '').trim()).mapeamento

  const itens = linhas
    .filter(l => l[mapa.produto] != null)
    .map(l => ({
      produto:              String(l[mapa.produto] ?? '').trim(),
      marca:                mapa.marca             ? limparString(l[mapa.marca])   : null,
      unidade:              mapa.unidade            ? limparString(l[mapa.unidade]) : null,
      sku:                  mapa.sku               ? limparString(l[mapa.sku])     : null,
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
  const system = `Classifique a mensagem de um representante comercial em uma categoria:

- catalogo:  enviando tabela de preços geral, lista de produtos com valores, ou arquivo de preços
- cotacao:   respondendo a uma solicitação específica de cotação (menciona itens solicitados)
- promocao:  comunicando promoção com prazo de validade ("válido até", "essa semana", "por tempo limitado")
- outro:     saudação, pergunta, outro assunto

RETORNE APENAS UMA PALAVRA: catalogo | cotacao | promocao | outro`

  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    system,
    messages: [{ role: 'user', content: texto }],
  })

  const classificacao = resp.content[0].text.trim().toLowerCase()
  return ['catalogo', 'cotacao', 'promocao', 'outro'].includes(classificacao) ? classificacao : 'outro'
}

// ── Helpers ───────────────────────────────────────────────────────────

// Converte qualquer valor em string limpa, retorna null se vazio ou literal "null"
function limparString(val) {
  if (val == null) return null
  const s = String(val).trim()
  if (s === '' || s.toLowerCase() === 'null') return null
  return s
}

function parsePreco(val) {
  if (val == null) return null
  const str = String(val).replace(/[R$\s]/g, '').replace(',', '.')
  const num = parseFloat(str)
  return isNaN(num) ? null : num
}

function parseData(val) {
  if (val == null) return null
  try {
    // SheetJS retorna datas do Excel como número serial (ex: 46148)
    // ou como objeto Date quando raw: false — tratamos os dois casos
    if (typeof val === 'number') {
      // Converte serial Excel → Date (epoch Excel: 1 jan 1900)
      const date = XLSX.SSF.parse_date_code(val)
      if (!date) return null
      const m = String(date.m).padStart(2, '0')
      const d = String(date.d).padStart(2, '0')
      return `${date.y}-${m}-${d}`
    }

    if (val instanceof Date) {
      if (isNaN(val.getTime())) return null
      return val.toISOString().split('T')[0]
    }

    const str = String(val).trim()
    if (!str || str === 'null') return null

    // DD-MM-AAAA ou DD/MM/AAAA (formato do template Kota)
    const brMatch = str.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/)
    if (brMatch) {
      const [, d, m, a] = brMatch
      return `${a}-${m}-${d}`
    }

    // Fallback: AAAA-MM-DD (ISO)
    const iso = new Date(str)
    if (isNaN(iso.getTime())) return null
    return iso.toISOString().split('T')[0]
  } catch {
    return null
  }
}
