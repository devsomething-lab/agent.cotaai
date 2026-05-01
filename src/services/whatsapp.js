import axios from 'axios'
import 'dotenv/config'

// ── Meta Cloud API client ─────────────────────────────────────────────

const META_VERSION    = process.env.META_API_VERSION   ?? 'v23.0'
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID
const ACCESS_TOKEN    = process.env.META_ACCESS_TOKEN

const meta = axios.create({
  baseURL: `https://graph.facebook.com/${META_VERSION}`,
  timeout: 15000,
  headers: {
    Authorization:  `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
})

// ── SIM_MODE: captura mensagens em memória sem chamar a Meta API ──────
// Ativado via SIM_MODE=true no .env ou na variável de ambiente.
// O servidor expõe /sim/messages para o test runner ler as saídas.

export const SIM_MODE = process.env.SIM_MODE === 'true'

const _simCapture = []   // { to, text, sentAt }

export function simGetMessages()  { return [..._simCapture] }
export function simClearMessages() { _simCapture.length = 0 }

// ── Envio de documento via URL pública ───────────────────────────────

export async function sendDocument(telefone, url, filename, caption = null) {
  if (SIM_MODE) {
    const msg = `[DOCUMENTO: ${filename}] ${url}${caption ? ` | caption: ${caption}` : ''}`
    _simCapture.push({ to: telefone, text: msg, sentAt: new Date().toISOString() })
    console.log(`\n📎 [KOTA → ${telefone}] ${msg}\n`)
    return { simulated: true }
  }
  const { data } = await meta.post(`/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                telefone,
    type:              'document',
    document: {
      link:     url,
      filename,
      caption:  caption ?? undefined,
    },
  })
  return data
}

// ── Envio de texto simples ────────────────────────────────────────────

export async function sendText(telefone, texto) {
  if (SIM_MODE) {
    _simCapture.push({ to: telefone, text: texto, sentAt: new Date().toISOString() })
    console.log(`\n📤 [KOTA → ${telefone}]\n${texto}\n`)
    return { simulated: true }
  }
  const { data } = await meta.post(`/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                telefone,
    type:              'text',
    text:              { body: texto, preview_url: false },
  })
  return data
}

// ── Envio com botões de resposta rápida (até 3 botões) ────────────────

export async function sendButtons(telefone, texto, botoes) {
  if (SIM_MODE) {
    const label = botoes.map((b, i) => `[${i + 1}] ${b.label}`).join('  ')
    const full  = `${texto}\n${label}`
    _simCapture.push({ to: telefone, text: full, sentAt: new Date().toISOString() })
    console.log(`\n📤 [KOTA → ${telefone}] (buttons)\n${full}\n`)
    return { simulated: true }
  }
  const { data } = await meta.post(`/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                telefone,
    type:              'interactive',
    interactive: {
      type: 'button',
      body: { text: texto },
      action: {
        buttons: botoes.slice(0, 3).map(b => ({
          type:  'reply',
          reply: { id: b.id, title: b.label.slice(0, 20) },
        })),
      },
    },
  })
  return data
}

// ── Download de mídia via Media ID da Meta ───────────────────────────

export async function downloadMedia(mediaId) {
  if (SIM_MODE) {
    // Retorna buffer vazio em modo simulação (mídia não é testada aqui)
    return { buffer: Buffer.from(''), mimeType: 'image/jpeg' }
  }
  const { data: mediaData } = await meta.get(`/${mediaId}`)
  const resp = await axios.get(mediaData.url, {
    responseType: 'arraybuffer',
    headers:      { Authorization: `Bearer ${ACCESS_TOKEN}` },
  })
  return { buffer: Buffer.from(resp.data), mimeType: mediaData.mime_type }
}

// ── Templates formatados ─────────────────────────────────────────────

export function templateCotacaoParaRep(itens, cotacaoId) {
  const linhas = itens.map((it, i) => {
    const marca   = it.marca   ? ` (${it.marca})`   : ''
    const unidade = it.unidade ? ` · ${it.unidade}` : ''
    return `${i + 1}. ${it.produto}${marca}${unidade} · ${it.quantidade ?? 1}un`
  }).join('\n')

  return [
    `*Kota · Cotação #${cotacaoId.slice(-6).toUpperCase()}*`,
    '',
    linhas,
    '',
    'Responda no formato:',
    '1. R$ 0,00 · Xd pgto · Xd entrega',
  ].join('\n')
}

export function templateComparativo(consolidado, cotacaoId) {
  const { itensMelhorPreco, melhorFornecedor, rankingFornecedores, propostas } = consolidado
  const reps = [...new Set(propostas.map(p => p.representantes?.nome))]

  const msg = [
    `*Kota · #${cotacaoId.slice(-6).toUpperCase()}*`,
    '',
  ]

  reps.forEach((rep, i) => {
    const props    = propostas.filter(p => p.representantes?.nome === rep)
    const total    = props.reduce((s, p) => s + (p.preco_total ?? 0), 0)
    const pg       = props[0]?.prazo_pagamento_dias
    const en       = props[0]?.prazo_entrega_dias
    const isMelhor = melhorFornecedor?.nome === rep

    msg.push(`${isMelhor ? '🏆' : ''} *${i + 1}. ${rep}*${isMelhor ? ' — melhor oferta' : ''}`)
    props.forEach(p => msg.push(`  ${p.produto} · R$ ${p.preco_unitario?.toFixed(2)}`))
    msg.push(`  Total R$ ${total.toFixed(2)} · pgto ${pg ?? '?'}d · entrega ${en ?? '?'}d`)
    msg.push('')
  })

  msg.push('1. Comprar agora')
  msg.push('2. Só consultando')
  msg.push('3. Decidir depois')

  return msg.join('\n')
}

export function templatePedidoConfirmado(pedido, itens, representante) {
  const linhas = itens.map(it =>
    `  ${it.produto} · ${it.quantidade}un · R$ ${it.preco_total?.toFixed(2)}`
  ).join('\n')

  return [
    `*Kota · Pedido #${pedido.id.slice(-6).toUpperCase()}*`,
    '',
    linhas,
    '',
    `Total R$ ${pedido.valor_total?.toFixed(2)}`,
    `${representante.nome} · pgto ${pedido.prazo_pagamento_dias}d · entrega ${pedido.prazo_entrega_dias}d`,
  ].join('\n')
}

// ── Envio de template aprovado pela Meta ─────────────────────────────

export async function sendTemplate(telefone, templateName, params = []) {
  if (SIM_MODE) {
    const text = `[TEMPLATE: ${templateName}] params: ${JSON.stringify(params)}`
    _simCapture.push({ to: telefone, text, sentAt: new Date().toISOString() })
    return { ok: true, simulated: true }
  }
  const components = params.length ? [{
    type:       'body',
    parameters: params.map(p => ({ type: 'text', text: String(p) })),
  }] : []

  try {
    const { data } = await meta.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                telefone,
      type:              'template',
      template: {
        name:       templateName,
        language:   { code: 'pt_BR' },
        components,
      },
    })
    return { ok: true, data }
  } catch (err) {
    console.error(`[sendTemplate] erro para ${telefone}:`, err.response?.data ?? err.message)
    return { ok: false, error: err.response?.data }
  }
}

// ── Envio com fallback automático ─────────────────────────────────────

export async function sendTextOrTemplate(telefone, texto, nomeRep) {
  try {
    await sendText(telefone, texto)
    return { via: 'text' }
  } catch (err) {
    const code = err.response?.data?.error?.code
    if (code === 131047 || code === 131026) {
      console.log(`[whatsapp] janela fechada para ${telefone} — usando template`)
      const result = await sendTemplate(telefone, 'cotacao_nova', [nomeRep])
      return { via: 'template', ...result }
    }
    throw err
  }
}

// ── Normaliza payload da Meta ─────────────────────────────────────────

export function normalizeMetaPayload(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value
    if (!value) return null
    const msg = value?.messages?.[0]
    if (!msg) return null

    const phone   = msg.from
    const msgType = msg.type
    let type = 'texto', message = null, mediaId = null, mimeType = null, messageId = msg.id

    switch (msgType) {
      case 'text':
        type = 'texto'; message = msg.text?.body ?? null; break
      case 'image':
        type = 'foto'; mediaId = msg.image?.id; mimeType = msg.image?.mime_type ?? 'image/jpeg'
        message = msg.image?.caption ?? null; break
      case 'audio': case 'voice':
        type = 'audio'; mediaId = msg.audio?.id ?? msg.voice?.id; mimeType = 'audio/ogg'; break
      case 'document': {
        const mime = msg.document?.mime_type ?? ''
        type    = mime.includes('pdf') ? 'pdf' : mime.includes('sheet') || mime.includes('excel') ? 'planilha' : 'documento'
        mediaId = msg.document?.id; mimeType = mime; message = msg.document?.caption ?? null; break
      }
      case 'interactive':
        type = 'texto'
        message = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? null; break
      default:
        type = 'texto'; message = msg.text?.body ?? null
    }

    return { phone, message, type, mediaId, mimeType, messageId }
  } catch (err) {
    console.error('[normalizeMetaPayload]', err.message)
    return null
  }
}
