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
  // botoes = [{ id: 'confirmar', label: '✅ Confirmar' }, ...]
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
    const unidade = it.unidade ? ` – ${it.unidade}` : ''
    return `${i + 1}. *${it.produto}*${marca}${unidade} — Qtd: ${it.quantidade ?? '?'}`
  }).join('\n')

  return [
    `📋 *Solicitação de Cotação #${cotacaoId.slice(-6).toUpperCase()}*`,
    '',
    'Prezado representante, solicito cotação dos itens abaixo:',
    '',
    linhas,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    'Por favor, responda com os dados de *cada item*:',
    '• Produto',
    '• Preço unitário (R$)',
    '• Prazo de pagamento (dias)',
    '• Prazo de entrega (dias)',
    '',
    'Exemplo de resposta:',
    '1. Coca-Cola 2L – R$ 5,80 – pgto 30d – entrega 2d',
    '2. Leite Ninho 400g – R$ 12,50 – pgto 28d – entrega 2d',
    '',
    '⏰ Aguardo resposta em até 24h. Obrigado!',
  ].join('\n')
}

export function templateComparativo(consolidado, cotacaoId) {
  const { itensMelhorPreco, melhorFornecedor, propostas } = consolidado
  
  let msg = [
    `📊 *Comparativo de Cotação #${cotacaoId.slice(-6).toUpperCase()}*`,
    '',
    '🏆 *Melhor fornecedor geral:*',
    `   ${melhorFornecedor.nome} (${melhorFornecedor.empresa ?? ''}) — Score: ${(melhorFornecedor.score * 100).toFixed(0)}pts`,
    '',
    '📦 *Melhor preço por item:*',
  ]

  for (const item of itensMelhorPreco) {
    msg.push(`  • ${item.produto}: R$ ${item.preco_unitario?.toFixed(2)} — ${item.representante}`)
  }

  msg.push('', '━━━━━━━━━━━━━━━━━━━━━━')
  msg.push('*Propostas recebidas:*')

  const reps = [...new Set(propostas.map(p => p.representantes?.nome))]
  for (const rep of reps) {
    const props = propostas.filter(p => p.representantes?.nome === rep)
    const total = props.reduce((s, p) => s + (p.preco_total ?? 0), 0)
    const prazo_pg = props[0]?.prazo_pagamento_dias
    const prazo_en = props[0]?.prazo_entrega_dias
    msg.push(`\n🔹 *${rep}*`)
    msg.push(`   Total: R$ ${total.toFixed(2)} | Pgto: ${prazo_pg ?? '?'}d | Entrega: ${prazo_en ?? '?'}d`)
    for (const p of props) {
      msg.push(`   - ${p.produto}: R$ ${p.preco_unitario?.toFixed(2)}`)
    }
  }

  msg.push('')
  msg.push('Qual fornecedor você escolhe? Responda com o *nome* ou *número* da opção.')

  reps.forEach((r, i) => msg.push(`${i + 1}. ${r}`))

  return msg.join('\n')
}

export function templatePedidoConfirmado(pedido, itens, representante) {
  const linhas = itens.map(it =>
    `  • ${it.produto} x${it.quantidade} — R$ ${it.preco_total?.toFixed(2)}`
  ).join('\n')

  return [
    `✅ *Pedido #${pedido.id.slice(-6).toUpperCase()} confirmado!*`,
    '',
    `Fornecedor: *${representante.nome}* (${representante.empresa ?? ''})`,
    `Pagamento: ${pedido.prazo_pagamento_dias}d | Entrega: ${pedido.prazo_entrega_dias}d`,
    '',
    '*Itens:*',
    linhas,
    '',
    `*Total: R$ ${pedido.valor_total?.toFixed(2)}*`,
    '',
    'O representante foi notificado. Aguarde a confirmação de recebimento.',
  ].join('\n')
}

// ── Normaliza payload da Meta Cloud API ──────────────────────────────
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
