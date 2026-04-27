import Anthropic from '@anthropic-ai/sdk'
import { downloadMedia } from '../services/whatsapp.js'
import 'dotenv/config'

const client = new Anthropic()

// ── Extração de lista de produtos (multimodal) ────────────────────────

export async function extrairListaProdutos(mensagem) {
  /**
   * mensagem = {
   *   tipo: 'texto' | 'foto' | 'audio' | 'pdf' | 'planilha',
   *   texto: string | null,
   *   mediaId: string | null, // Meta usa media_id
   *   mimeType: string | null,
   * }
   * Retorna: { itens: [{produto, marca, unidade, quantidade, obs}], raw_interpretado }
   */

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
  "raw_interpretado": "resumo do que foi interpretado"
}`

  const userContent = []

  // Adiciona texto se houver
  if (mensagem.texto) {
    userContent.push({ type: 'text', text: `Lista do comerciante:\n${mensagem.texto}` })
  }

  // Adiciona mídia se houver
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

  // Planilha já vem como texto parseado (ver handler)
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
    return JSON.parse(json)
  } catch {
    throw new Error(`IA retornou JSON inválido: ${raw.slice(0, 200)}`)
  }
}

// ── Estruturação da resposta do representante ─────────────────────────

export async function estruturarRespostaRep(texto, itensEsperados) {
  /**
   * Interpreta a resposta livre do representante e mapeia para os itens esperados.
   * Retorna: [{ produto, preco_unitario, prazo_pagamento_dias, prazo_entrega_dias, obs }]
   */

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
    return JSON.parse(json)
  } catch {
    throw new Error(`IA retornou JSON inválido na estruturação de resposta: ${raw.slice(0, 200)}`)
  }
}

// ── Transcrição de áudio ─────────────────────────────────────────────

export async function transcreverAudio(audioUrl, mimeType = 'audio/ogg') {
  /**
   * Baixa o áudio e pede ao Claude para transcrever e já extrair os produtos.
   * NOTA: Claude não processa áudio diretamente — usamos uma abordagem de
   * fallback: retorna mensagem orientando o comerciante a reenviar como texto.
   * Para produção, integrar Whisper (OpenAI) ou AssemblyAI para transcrição real.
   */
  return {
    transcricao: null,
    fallback: true,
    mensagem: '🎙️ Recebi seu áudio! No momento ainda estou aprendendo a processar áudios. Pode me enviar a lista por texto ou foto? Assim processo mais rápido! 😊',
  }
}
