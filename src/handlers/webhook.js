import { supabase, findOrCreateComercianteByTelefone, findRepresentanteByTelefone,
         getCotacaoComItens, getPropostasDaCotacao, getCotacaoPendentePorTelefone,
         getAllRepresentantesAtivos } from '../db/client.js'
import { extrairListaProdutos, estruturarRespostaRep, transcreverAudio } from '../agents/extractor.js'
import { extrairCatalogo, classificarMensagemRep } from '../agents/catalogo_agent.js'
import { consolidarPropostas } from '../agents/consolidator.js'
import { resolverCotacaoAutomatica, salvarPropostasAutomaticas } from '../agents/auto_quote.js'
import { upsertCatalogoEmLote, salvarPromocao } from '../db/catalogo.js'
import { sendText, downloadMedia, normalizeMetaPayload,
         templateCotacaoParaRep, templateComparativo, templatePedidoConfirmado } from '../services/whatsapp.js'
import * as XLSX from 'xlsx'
import 'dotenv/config'

const TIMEOUT_HORAS = parseInt(process.env.COTACAO_TIMEOUT_HORAS ?? '24')

// ── Entry point ───────────────────────────────────────────────────────

export async function handleWebhook(payload) {
  const normalized = normalizeMetaPayload(payload)
  if (!normalized) return { ok: true, skipped: true }

  const { phone, message, type, mediaId, mimeType } = normalized
  if (!phone || (!message && !mediaId)) return { ok: true, skipped: true }

  console.log(`[webhook] ${phone} | tipo: ${type} | "${(message ?? '').slice(0, 60)}"`)

  const rep = await findRepresentanteByTelefone(phone)
  if (rep) {
    return handleMensagemRepresentante({ rep, message, type, mediaId, mimeType })
  } else {
    return handleMensagemComerciantge({ phone, message, type, mediaId, mimeType })
  }
}

// ── FLUXO DO COMERCIANTE ─────────────────────────────────────────────

async function handleMensagemComerciantge({ phone, message, type, mediaId, mimeType }) {
  const comerciante = await findOrCreateComercianteByTelefone(phone)

  // Cotação aguardando escolha de fornecedor?
  const { data: cotacaoAberta } = await supabase
    .from('cotacoes')
    .select('*')
    .eq('comerciante_id', comerciante.id)
    .eq('status', 'aguardando_escolha')
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  if (cotacaoAberta && message) {
    return handleEscolhaFornecedor({ comerciante, cotacao: cotacaoAberta, resposta: message })
  }

  await sendText(phone, '🔄 Recebi sua lista! Processando... aguarde um instante.')

  // Parse de planilha antes da IA
  let mensagemParaIA = { tipo: type, texto: message ?? null, mediaId: mediaId ?? null, mimeType }

  if (type === 'planilha' && mediaId) {
    try {
      const { buffer } = await downloadMedia(mediaId)
      const wb = XLSX.read(buffer)
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]])
      mensagemParaIA = { tipo: 'texto', texto: `Planilha:\n${csv}`, mediaId: null, mimeType: null }
    } catch (err) {
      console.error('[planilha] erro:', err.message)
    }
  }

  if (type === 'audio') {
    const { fallback, mensagem } = await transcreverAudio(mediaId, mimeType)
    if (fallback) { await sendText(phone, mensagem); return { ok: true } }
  }

  // Extrai lista com IA
  let extraido
  try {
    extraido = await extrairListaProdutos(mensagemParaIA)
  } catch (err) {
    await sendText(phone, '⚠️ Não consegui interpretar sua lista. Tente em texto: "2 cx Coca-Cola 2L, 1 fardo Leite Ninho"')
    return { ok: false }
  }

  if (!extraido.itens?.length) {
    await sendText(phone, '🤔 Não encontrei nenhum produto. Pode tentar novamente?')
    return { ok: true }
  }

  // Salva cotação
  const { data: cotacao } = await supabase
    .from('cotacoes')
    .insert({
      comerciante_id: comerciante.id,
      status:         'aguardando_respostas',
      input_raw:      message ?? `[${type}]`,
      input_tipo:     type,
      input_midia_url: mediaId,
      timeout_em:     new Date(Date.now() + TIMEOUT_HORAS * 3600000).toISOString(),
    })
    .select().single()

  const itensInseridos = await supabase
    .from('cotacao_itens')
    .insert(extraido.itens.map((it, i) => ({
      cotacao_id: cotacao.id, produto: it.produto, marca: it.marca,
      unidade: it.unidade, quantidade: it.quantidade, obs: it.obs, ordem: i,
    })))
    .select()

  const itens = itensInseridos.data

  // Confirma lista ao comerciante
  const resumo = extraido.itens.map((it, i) => {
    const marca = it.marca ? ` (${it.marca})` : ''
    const un = it.unidade ? ` – ${it.unidade}` : ''
    return `${i + 1}. ${it.produto}${marca}${un} × ${it.quantidade ?? 1}`
  }).join('\n')

  await sendText(phone, [`✅ *Entendi sua lista:*`, '', resumo, '', '🔍 Verificando catálogos dos representantes...'].join('\n'))

  // ── Tenta cotação automática ──────────────────────────────────────
  const { repsAutomaticos, repsManuais, itensSemCobertura, modo } =
    await resolverCotacaoAutomatica(cotacao.id, itens)

  // Salva propostas automáticas
  for (const { rep, propostas } of repsAutomaticos) {
    await salvarPropostasAutomaticas(cotacao.id, rep.id, propostas)
  }

  if (modo === 'automatico') {
    // Todos os reps têm catálogo — consolida já
    await sendText(phone, '⚡ Todos os fornecedores têm catálogo atualizado. Comparativo pronto em segundos!')
    await consolidarEEnviar(cotacao.id)
  } else {
    // Misto ou manual — avisa o que está acontecendo
    const msgs = ['📤 Consultando fornecedores:']
    if (repsAutomaticos.length) {
      msgs.push(`✅ ${repsAutomaticos.length} fornecedor(es) com catálogo responderam automaticamente`)
    }
    if (repsManuais.length) {
      msgs.push(`⏳ ${repsManuais.length} fornecedor(es) sem catálogo serão consultados via WhatsApp`)
      // Dispara para os reps sem catálogo
      await dispararParaRepsManuais(cotacao, itens, repsManuais)
    }
    if (itensSemCobertura.length) {
      msgs.push(`⚠️ ${itensSemCobertura.length} item(ns) sem cobertura em nenhum catálogo`)
    }
    msgs.push(``, `⏰ Consolidarei as respostas em até ${TIMEOUT_HORAS}h.`)
    await sendText(phone, msgs.join('\n'))
  }

  return { ok: true, cotacaoId: cotacao.id, modo }
}

async function dispararParaRepsManuais(cotacao, itens, reps) {
  const template = templateCotacaoParaRep(itens, cotacao.id)
  for (const rep of reps) {
    try {
      await sendText(rep.telefone, template)
      await supabase.from('cotacao_envios').insert({
        cotacao_id: cotacao.id, representante_id: rep.id,
        modo_resposta: 'aguardando', status: 'aguardando',
      })
      await sleep(500)
    } catch (err) {
      console.error(`[disparo] erro ${rep.nome}:`, err.message)
    }
  }
}

// ── FLUXO DO REPRESENTANTE ───────────────────────────────────────────

async function handleMensagemRepresentante({ rep, message, type, mediaId, mimeType }) {
  // Sem texto e sem mídia → pede formato correto
  if (!message && !mediaId) {
    await sendText(rep.telefone, '📝 Envie sua tabela de preços (Excel, PDF, foto) ou responda a cotação em texto.')
    return { ok: true }
  }

  // Classifica o que o rep está enviando (só para texto)
  let classificacao = 'cotacao'
  if (message && type === 'texto') {
    classificacao = await classificarMensagemRep(message)
  } else if (['planilha', 'pdf', 'foto'].includes(type)) {
    classificacao = 'catalogo'
  }

  console.log(`[rep ${rep.nome}] classificacao: ${classificacao}`)

  // Despacha para o handler correto
  if (classificacao === 'catalogo') {
    return handleAtualizacaoCatalogo({ rep, message, type, mediaId, mimeType })
  } else if (classificacao === 'promocao') {
    return handlePromocao({ rep, message })
  } else {
    return handleRespostaCotacao({ rep, message, type, mediaId, mimeType })
  }
}

// ── Rep atualiza catálogo ─────────────────────────────────────────────

async function handleAtualizacaoCatalogo({ rep, message, type, mediaId, mimeType }) {
  await sendText(rep.telefone, '📥 Recebi sua tabela! Processando os preços...')

  try {
    const extraido = await extrairCatalogo({ tipo: type, texto: message, mediaId, mimeType })

    if (!extraido.itens?.length) {
      await sendText(rep.telefone, '⚠️ Não encontrei produtos com preços. Envie uma planilha Excel ou lista no formato:\nProduto – R$ X,XX – pgto Xd – entrega Xd')
      return { ok: false }
    }

    const resultado = await upsertCatalogoEmLote(rep.id, extraido.itens, type === 'texto' ? 'whatsapp' : type)

    const msgs = [
      `✅ *Catálogo atualizado!*`,
      ``,
      `📦 ${resultado.inseridos} produto(s) novo(s) adicionados`,
      `🔄 ${resultado.atualizados} produto(s) com preço atualizado`,
    ]

    if (resultado.erros.length) {
      msgs.push(`⚠️ ${resultado.erros.length} item(ns) com erro — não foram salvos`)
    }

    msgs.push(``, `Seus preços serão usados automaticamente nas próximas cotações. 🚀`)

    await sendText(rep.telefone, msgs.join('\n'))
    return { ok: true, inseridos: resultado.inseridos, atualizados: resultado.atualizados }

  } catch (err) {
    console.error('[catalogo] erro:', err.message)
    await sendText(rep.telefone, '⚠️ Erro ao processar sua tabela. Tente enviar um arquivo Excel (.xlsx) ou liste os produtos em texto.')
    return { ok: false }
  }
}

// ── Rep envia promoção ────────────────────────────────────────────────

async function handlePromocao({ rep, message }) {
  await sendText(rep.telefone, '🏷️ Recebi sua promoção! Processando...')

  try {
    const extraido = await extrairCatalogo({ tipo: 'texto', texto: message })

    for (const item of extraido.itens) {
      if (!item.valido_ate) {
        // Promoção sem data: define 7 dias por padrão
        const fim = new Date()
        fim.setDate(fim.getDate() + 7)
        item.valido_ate = fim.toISOString().split('T')[0]
      }

      await salvarPromocao(rep.id, {
        produto:     item.produto,
        marca:       item.marca,
        unidade:     item.unidade,
        preco_promo: item.preco_unitario,
        valida_ate:  item.valido_ate,
        obs:         'Enviado via WhatsApp',
      })
    }

    await sendText(rep.telefone, [
      `🎉 *Promoção salva!*`,
      `${extraido.itens.length} produto(s) com preço promocional ativo.`,
      `Será usado automaticamente nas próximas cotações!`,
    ].join('\n'))

    return { ok: true }
  } catch (err) {
    console.error('[promocao] erro:', err.message)
    await sendText(rep.telefone, '⚠️ Erro ao salvar promoção. Tente no formato:\nProduto – R$ XX – válido até DD/MM')
    return { ok: false }
  }
}

// ── Rep responde cotação manualmente ─────────────────────────────────

async function handleRespostaCotacao({ rep, message }) {
  if (!message) {
    await sendText(rep.telefone, '📝 Para responder a cotação, envie os preços em texto.')
    return { ok: true }
  }

  const envio = await getCotacaoPendentePorTelefone(rep.telefone)
  if (!envio) {
    await sendText(rep.telefone, [
      'Não encontrei nenhuma cotação aguardando sua resposta.',
      '',
      'Se quiser atualizar sua tabela de preços, envie um arquivo Excel ou liste seus produtos com preços.',
    ].join('\n'))
    return { ok: true }
  }

  const cotacaoId = envio.cotacao_id ?? envio.cotacoes?.id
  const { itens } = await getCotacaoComItens(cotacaoId)

  let estruturado
  try {
    estruturado = await estruturarRespostaRep(message, itens)
  } catch (err) {
    await sendText(rep.telefone, '⚠️ Não entendi sua proposta. Formato esperado:\n1. Produto – R$ 0,00 – pgto Xd – entrega Xd')
    return { ok: false }
  }

  const prazoPg = estruturado.prazo_pagamento_geral
  const prazoEn = estruturado.prazo_entrega_geral

  const propostasParaInserir = estruturado.itens.map(it => {
    const orig = itens.find(i => i.produto.toLowerCase().includes(it.produto.toLowerCase().split(' ')[0]))
    return {
      cotacao_envio_id:     envio.id,
      cotacao_id:           cotacaoId,
      representante_id:     rep.id,
      cotacao_item_id:      orig?.id ?? null,
      produto:              it.produto,
      preco_unitario:       it.preco_unitario,
      preco_total:          it.preco_unitario != null && orig?.quantidade ? it.preco_unitario * orig.quantidade : null,
      prazo_pagamento_dias: it.prazo_pagamento_dias ?? prazoPg,
      prazo_entrega_dias:   it.prazo_entrega_dias ?? prazoEn,
      resposta_raw:         message,
      origem:               'manual',
    }
  })

  await supabase.from('propostas').insert(propostasParaInserir)
  await supabase.from('cotacao_envios')
    .update({ status: 'respondido', modo_resposta: 'manual', respondido_em: new Date().toISOString() })
    .eq('id', envio.id)

  await sendText(rep.telefone, '✅ Proposta recebida! Obrigado. Se você for escolhido, o pedido chegará em seguida.')

  await verificarEConsolidar(cotacaoId)
  return { ok: true }
}

// ── Consolidação ─────────────────────────────────────────────────────

async function verificarEConsolidar(cotacaoId) {
  const { data: envios } = await supabase.from('cotacao_envios').select('status').eq('cotacao_id', cotacaoId)
  const { data: cotacao } = await supabase.from('cotacoes').select('*').eq('id', cotacaoId).single()

  const manuaisPendentes = envios.filter(e => e.status === 'aguardando').length
  const timeoutPassou = cotacao.timeout_em && new Date(cotacao.timeout_em) < new Date()

  if (manuaisPendentes > 0 && !timeoutPassou) return
  await consolidarEEnviar(cotacaoId)
}

export async function consolidarEEnviar(cotacaoId) {
  const { cotacao, itens } = await getCotacaoComItens(cotacaoId)
  const propostas = await getPropostasDaCotacao(cotacaoId)

  if (!propostas.length) {
    await sendText(cotacao.comerciantes.telefone, '⚠️ Nenhum fornecedor respondeu. Tente novamente mais tarde.')
    return
  }

  const consolidado = consolidarPropostas(itens, propostas)

  for (const rep of consolidado.rankingFornecedores) {
    await supabase.from('propostas').update({ score: rep.score })
      .eq('cotacao_id', cotacaoId).eq('representante_id', rep.id)
  }

  await supabase.from('cotacoes').update({ status: 'aguardando_escolha' }).eq('id', cotacaoId)
  await sendText(cotacao.comerciantes.telefone, templateComparativo(consolidado, cotacaoId))
}

// ── Escolha do fornecedor → Pedido ────────────────────────────────────

async function handleEscolhaFornecedor({ comerciante, cotacao, resposta }) {
  const { itens } = await getCotacaoComItens(cotacao.id)
  const propostas = await getPropostasDaCotacao(cotacao.id)
  const consolidado = consolidarPropostas(itens, propostas)
  const reps = consolidado.rankingFornecedores

  let repEscolhido = null
  const num = parseInt(resposta.trim())
  if (!isNaN(num) && num >= 1 && num <= reps.length) {
    repEscolhido = reps[num - 1]
  } else {
    repEscolhido = reps.find(r =>
      resposta.toLowerCase().includes(r.nome.toLowerCase()) ||
      resposta.toLowerCase().includes(r.empresa?.toLowerCase() ?? '___')
    )
  }

  if (!repEscolhido) {
    const opcoes = reps.map((r, i) => `${i + 1}. ${r.nome} (${r.empresa ?? ''})`).join('\n')
    await sendText(comerciante.telefone, `Não entendi. Responda com o número:\n\n${opcoes}`)
    return
  }

  const itensRep = propostas.filter(p => p.representante_id === repEscolhido.id)
  const valorTotal = itensRep.reduce((s, p) => s + (p.preco_total ?? 0), 0)

  const { data: pedido } = await supabase.from('pedidos').insert({
    cotacao_id:           cotacao.id,
    comerciante_id:       comerciante.id,
    representante_id:     repEscolhido.id,
    valor_total:          valorTotal,
    prazo_pagamento_dias: repEscolhido.itens[0]?.prazo_pagamento_dias,
    prazo_entrega_dias:   repEscolhido.itens[0]?.prazo_entrega_dias,
  }).select().single()

  const pedidoItens = itensRep.map(p => ({
    pedido_id: pedido.id, produto: p.produto,
    quantidade: itens.find(i => i.produto === p.produto)?.quantidade,
    preco_unitario: p.preco_unitario, preco_total: p.preco_total,
  }))
  await supabase.from('pedido_itens').insert(pedidoItens)
  await supabase.from('cotacoes').update({ status: 'pedido_gerado', fechado_em: new Date().toISOString() }).eq('id', cotacao.id)

  await sendText(comerciante.telefone, templatePedidoConfirmado(pedido, pedidoItens, repEscolhido))

  const resumo = pedidoItens.map(it => `• ${it.produto} ×${it.quantidade} — R$ ${it.preco_total?.toFixed(2)}`).join('\n')
  await sendText(repEscolhido.telefone, [
    `🎉 *Pedido #${pedido.id.slice(-6).toUpperCase()} recebido!*`, '',
    `Cliente: ${comerciante.nome} (${comerciante.telefone})`, '',
    resumo, '',
    `*Total: R$ ${valorTotal.toFixed(2)}*`,
    `Pagamento: ${pedido.prazo_pagamento_dias}d | Entrega: ${pedido.prazo_entrega_dias}d`,
  ].join('\n'))

  return { ok: true, pedidoId: pedido.id }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
