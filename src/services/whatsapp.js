import axios from 'axios'
import 'dotenv/config'

// ── Meta Cloud API client ─────────────────────────────────────────────
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api

const META_VERSION = process.env.META_API_VERSION ?? 'v23.0'
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN

const meta = axios.create({
  baseURL: `https://graph.facebook.com/${META_VERSION}`,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
})

// ── Envio de texto simples ────────────────────────────────────────────

export async function sendText(telefone, texto) {
  // telefone deve estar no formato internacional sem +: 5511999990001
  const { data } = await meta.post(`/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: telefone,
    type: 'text',
    text: { body: texto, preview_url: false },
  })
  return data
}

// ── Envio com botões de resposta rápida (até 3 botões) ────────────────

export async function sendButtons(telefone, texto, botoes) {
  // botoes = [{ id: 'confirmar', label: 'Confirmar' }, ...]
  // Meta suporta até 3 botões de resposta rápida
  const { data } = await meta.post(`/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: telefone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: texto },
      action: {
        buttons: botoes.slice(0, 3).map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.label.slice(0, 20) }, // title máximo 20 chars
        })),
      },
    },
  })
  return data
}

// ── Download de mídia via Media ID da Meta ───────────────────────────
// A Meta NÃO retorna URLs diretas no webhook — retorna um media_id.
// É necessário primeiro buscar a URL e depois baixar com o token.

export async function downloadMedia(mediaId) {
  // 1. Busca a URL temporária do arquivo
  const { data: mediaData } = await meta.get(`/${mediaId}`)
  // 2. Baixa o arquivo usando o token de autenticação
  const resp = await axios.get(mediaData.url, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  })
  return {
    buffer: Buffer.from(resp.data),
    mimeType: mediaData.mime_type,
  }
}

// ── Templates formatados ─────────────────────────────────────────────

export function templateCotacaoParaRep(itens, cotacaoId) {
  const linhas = itens.map((it, i) => {
    const marca = it.marca ? ` (${it.marca})` : ''
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

  let msg = [
    `*Kota · #${cotacaoId.slice(-6).toUpperCase()}*`,
    '',
  ]

  // Bloco por fornecedor
  reps.forEach((rep, i) => {
    const props = propostas.filter(p => p.representantes?.nome === rep)
    const total = props.reduce((s, p) => s + (p.preco_total ?? 0), 0)
    const pg = props[0]?.prazo_pagamento_dias
    const en = props[0]?.prazo_entrega_dias
    const score = rankingFornecedores?.find(r => r.nome === rep)?.score
    const isMelhor = melhorFornecedor?.nome === rep

    msg.push(`${isMelhor ? '🏆' : ''} *${i + 1}. ${rep}*${isMelhor ? ' — melhor oferta' : ''}`)
    props.forEach(p => {
      msg.push(`  ${p.produto} · R$ ${p.preco_unitario?.toFixed(2)}`)
    })
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
  const components = params.length ? [{
    type: 'body',
    parameters: params.map(p => ({ type: 'text', text: String(p) })),
  }] : []

  try {
    const { data } = await meta.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'pt_BR' },
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
// Tenta texto livre; se falhar por janela fechada, usa o template
export async function sendTextOrTemplate(telefone, texto, nomeRep) {
  try {
    await sendText(telefone, texto)
    return { via: 'text' }
  } catch (err) {
    const code = err.response?.data?.error?.code
    // 131047 = fora da janela 24h | 131026 = número não opt-in
    if (code === 131047 || code === 131026) {
      console.log(`[whatsapp] janela fechada para ${telefone} — usando template`)
      const result = await sendTemplate(telefone, 'cotacao_nova', [nomeRep])
      return { via: 'template', ...result }
    }
    throw err
  }
}

export function normalizeMetaPayload(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value
    if (!value) return null
    const msg = value?.messages?.[0]
    if (!msg) return null
    const phone = msg.from
    const msgType = msg.type
    let type = 'texto', message = null, mediaId = null, mimeType = null
    switch (msgType) {
      case 'text': type='texto'; message=msg.text?.body ?? null; break
      case 'image': type='foto'; mediaId=msg.image?.id; mimeType=msg.image?.mime_type ?? 'image/jpeg'; message=msg.image?.caption ?? null; break
      case 'audio': case 'voice': type='audio'; mediaId=msg.audio?.id ?? msg.voice?.id; mimeType='audio/ogg'; break
      case 'document': {
        const mime=msg.document?.mime_type ?? ''
        type=mime.includes('pdf')?'pdf':mime.includes('sheet')||mime.includes('excel')?'planilha':'documento'
        mediaId=msg.document?.id; mimeType=mime; message=msg.document?.caption ?? null; break
      }
      case 'interactive': type='texto'; message=msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? null; break
      default: type='texto'; message=msg.text?.body ?? null
    }
    return { phone, message, type, mediaId, mimeType, rawMsgId: msg.id }
  } catch(err) { console.error('[normalizeMetaPayload]', err.message); return null }
}
