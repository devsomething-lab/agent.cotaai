import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../db/client.js'
import { downloadMedia } from '../services/whatsapp.js'
import { parsePrazoLocal, normalizarItensCatalogoEmLote } from './interpretar.js'
import 'dotenv/config'

const client = new Anthropic()

// ── Feature 5: Busca histórico de quantidades do comerciante ──────────
// Consulta pedidos anteriores e retorna padrão de compra por produto

async function buscarHistoricoQuantidades(comercianteId, produtos) {
  if (!comercianteId || !produtos?.length) return {}

  try {
    // Busca últimos 90 dias de pedido_itens deste comerciante
    const { data: itensPedidos } = await supabase
      .from('pedido_itens')
      .select('produto, quantidade, pedidos!inner(comerciante_id, criado_em)')
      .eq('pedidos.comerciante_id', comercianteId)
      .gte('pedidos.criado_em', new Date(Date.now() - 90 * 24 * 3600000).toISOString())
      .order('pedidos.criado_em', { ascending: false })

    if (!itensPedidos?.length) return {}

    // Agrupa por produto e calcula mediana de quantidade
    const porProduto = {}
    for (const item of itensPedidos) {
      const key = (item.produto ?? '').toLowerCase().trim()
      if (!porProduto[key]) porProduto[key] = []
      if (item.quantidade) porProduto[key].push(item.quantidade)
    }

    // Retorna mediana por produto (mais robusta que média para quantidades)
    const historico = {}
    for (const [produto, quantidades] of Object.entries(porProduto)) {
      const sorted = [...quantidades].sort((a, b) => a - b)
      const mediana = sorted[Math.floor(sorted.length / 2)]
      historico[produto] = {
        quantidade_sugerida: mediana,
        frequencia:          quantidades.length,
        ultima_compra:       quantidades[0], // lista está ordenada desc por data
      }
    }

    return historico
  } catch (err) {
    console.warn('[buscarHistoricoQuantidades] erro, continuando sem histórico:', err.message)
    return {}
  }
}

// ── Extração de lista de produtos (multimodal) ────────────────────────

export async function extrairListaProdutos(mensagem, opcoes = {}) {
  /**
   * mensagem = {
   *   tipo: 'texto' | 'foto' | 'audio' | 'pdf' | 'planilha',
   *   texto: string | null,
   *   mediaId: string | null,
   *   mimeType: string | null,
   * }
   * opcoes = {
   *   comercianteId: string | null  // Feature 5: para buscar histórico de quantidades
   * }
   * Retorna: { itens: [{produto, marca, unidade, quantidade, obs}], raw_interpretado }
   */

  // Feature 5: busca histórico de quantidades antes de processar a lista
  let historicoQuantidades = {}
  let temHistorico = false
  if (opcoes.comercianteId) {
    // Extrai nomes de produtos da mensagem de forma simples para pré-busca
    historicoQuantidades = await buscarHistoricoQuantidades(opcoes.comercianteId, [])
    temHistorico = Object.keys(historicoQuantidades).length > 0
  }

  // Feature 5: instrução condicional de histórico no prompt
  const instrucaoHistorico = temHistorico ? `
HISTÓRICO DE COMPRAS DO COMERCIANTE (últimos 90 dias):
${Object.entries(historicoQuantidades)
  .map(([prod, h]) => `- ${prod}: comprou ${h.quantidade_sugerida} unid. (${h.frequencia}x nos últimos 90 dias)`)
  .join('\n')}

Regra especial: Se um produto da lista NÃO tiver quantidade informada E aparecer no histórico acima,
use a quantidade do histórico como sugestão e adicione obs: "quantidade sugerida pelo histórico".
Se não estiver no histórico e não tiver quantidade, use 1.` : ''

  const systemPrompt = `Você é um assistente especializado em extrair listas de produtos de mensagens de comerciantes brasileiros.

Sua tarefa é identificar TODOS os produtos mencionados e estruturá-los em JSON.

Regras:
- Interprete abreviações comuns do varejo: "cx" = caixa, "fd" = fardo, "pct" = pacote, "un" = unidade, "kg" = quilograma, "lt" = lata, "gf" = garrafa
- Se a marca não for mencionada, deixe null
- Se a unidade/embalagem não for mencionada, deixe null
- Se a quantidade não for mencionada, use 1
- Normalize nomes de produtos: "coca" → "Coca-Cola", "leite ninho" → "Leite Ninho"
- Para áudios transcritos, extraia apenas os produtos citados
- Retorne APENAS o JSON, sem texto adicional
${instrucaoHistorico}

Formato de saída:
{
  "itens": [
    {
      "produto": "Nome do produto normalizado",
      "marca": "Marca ou null",
      "unidade": "caixa/fardo/pacote/unidade/kg/lata/garrafa ou null",
      "quantidade": número,
      "obs": "observação adicional ou null"
    }
  ],
  "raw_interpretado": "resumo do que foi interpretado",
  "tem_quantidades_sugeridas": true | false
}`

  const userContent = []

  if (mensagem.texto) {
    userContent.push({ type: 'text', text: `Lista do comerciante:\n${mensagem.texto}` })
  }

  if (mensagem.mediaId && mensagem.tipo !== 'audio') {
    try {
      const { buffer, mimeType: resolvedMime } = await downloadMedia(mensagem.mediaId)
      mensagem.mimeType = resolvedMime ?? mensagem.mimeType
      const base64 = buffer.toString('base64')

      if (mensagem.tipo === 'foto') {
        userContent.push({
          type: 'image',
          source: { type: 'base64', media_type: mensagem.mimeType || 'image/jpeg', data: base64 },
        })
        userContent.push({ type: 'text', text: 'Extraia todos os produtos visíveis nesta imagem.' })
      } else if (mensagem.tipo === 'pdf') {
        userContent.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        })
        userContent.push({ type: 'text', text: 'Extraia todos os produtos listados neste documento.' })
      }
    } catch (err) {
      console.error('[extrairListaProdutos] erro ao baixar mídia:', err.message)
    }
  }

  if (userContent.length === 0) {
    throw new Error('Nenhum conteúdo para processar')
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  })

  const raw = response.content[0].text.trim()
  const json = raw.replace(/```json|```/g, '').trim()

  try {
    const resultado = JSON.parse(json)

    // Feature 5: segunda passagem — para itens sem quantidade que batem com histórico
    // (fallback caso a IA não tenha usado o histórico corretamente)
    if (temHistorico && resultado.itens) {
      resultado.itens = resultado.itens.map(item => {
        if (item.quantidade !== 1 || item.obs?.includes('histórico')) return item

        // Tenta encontrar este produto no histórico
        const keyItem = (item.produto ?? '').toLowerCase().trim()
        const match = Object.entries(historicoQuantidades).find(([hProd]) =>
          keyItem.includes(hProd) || hProd.includes(keyItem) ||
          keyItem.split(' ').some(w => w.length > 3 && hProd.includes(w))
        )

        if (match) {
          const [, hist] = match
          return {
            ...item,
            quantidade: hist.quantidade_sugerida,
            obs: item.obs
              ? `${item.obs}; quantidade sugerida pelo histórico`
              : `quantidade sugerida pelo histórico (${hist.frequencia}x nos últimos 90 dias)`,
          }
        }
        return item
      })
    }

    return resultado
  } catch {
    throw new Error(`IA retornou JSON inválido: ${raw.slice(0, 200)}`)
  }
}

// ── Estruturação da resposta do representante ─────────────────────────

export async function estruturarRespostaRep(texto, itensEsperados) {
  const itensStr = itensEsperados
    .map((it, i) => `${i + 1}. ${it.produto}${it.marca ? ` (${it.marca})` : ''} – qtd ${it.quantidade}`)
    .join('\n')

  const system = `Você é um assistente que extrai dados de propostas comerciais de representantes de vendas brasileiros.

Itens que foram cotados:
${itensStr}

Sua tarefa: interpretar a resposta do representante e extrair, para cada item, os dados comerciais.

Regras:
- "pgto 30d" ou "30 dias" = prazo_pagamento_dias: 30
- "entrega 2d", "2 dias úteis" = prazo_entrega_dias: 2
- "à vista" = prazo_pagamento_dias: 0
- Se não informado, use null
- Preço: extraia apenas o valor numérico (sem R$)
- Tente associar cada item da resposta com os itens esperados pelo nome
- Retorne APENAS JSON, sem texto adicional

Formato:
{
  "itens": [
    {
      "produto": "nome conforme lista original",
      "preco_unitario": número ou null,
      "prazo_pagamento_dias": número ou null,
      "prazo_entrega_dias": número ou null,
      "obs": "string ou null"
    }
  ],
  "prazo_pagamento_geral": número ou null,
  "prazo_entrega_geral": número ou null
}`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: `Resposta do representante:\n${texto}` }],
  })

  const raw = response.content[0].text.trim()
  const json = raw.replace(/```json|```/g, '').trim()

  try {
    const parsed = JSON.parse(json)

    // Aplica condições gerais de prazo nos itens que não têm valor específico
    if (parsed.prazo_pagamento_geral != null || parsed.prazo_entrega_geral != null) {
      parsed.itens = parsed.itens.map(it => ({
        ...it,
        prazo_pagamento_dias: it.prazo_pagamento_dias ?? parsed.prazo_pagamento_geral,
        prazo_entrega_dias:   it.prazo_entrega_dias   ?? parsed.prazo_entrega_geral,
      }))
    }

    // Normaliza prazos e unidades ambíguos via IA (safety net)
    parsed.itens = await normalizarItensCatalogoEmLote(parsed.itens)

    return parsed
  } catch {
    throw new Error(`IA retornou JSON inválido na estruturação de resposta: ${raw.slice(0, 200)}`)
  }
}

// ── Transcrição de áudio ─────────────────────────────────────────────

export async function transcreverAudio(audioUrl, mimeType = 'audio/ogg') {
  return {
    transcricao: null,
    fallback: true,
    mensagem: '🎙️ Recebi seu áudio! No momento ainda estou aprendendo a processar áudios. Pode me enviar a lista por texto ou foto? Assim processo mais rápido! 😊',
  }
}
