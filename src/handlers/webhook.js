import { supabase, findOrCreateComercianteByTelefone, findRepresentanteByTelefone,
         getCotacaoComItens, getPropostasDaCotacao, getCotacaoPendentePorTelefone,
         getAllRepresentantesAtivos } from '../db/client.js'
import { extrairListaProdutos, estruturarRespostaRep, transcreverAudio } from '../agents/extractor.js'
import { extrairCatalogo, classificarMensagemRep } from '../agents/catalogo_agent.js'
import { consolidarPropostas, gerarResumoNegociacao } from '../agents/consolidator.js'
import { resolverCotacaoAutomatica, salvarPropostasAutomaticas } from '../agents/auto_quote.js'
import { upsertCatalogoEmLote, salvarPromocao } from '../db/catalogo.js'
import { sendText, sendTextOrTemplate, downloadMedia, normalizeMetaPayload,
         templateCotacaoParaRep, templateComparativo, templatePedidoConfirmado } from '../services/whatsapp.js'
import * as XLSX from 'xlsx'
import { handleAutocadastro, getSessaoOnboarding, handleOnboardingComerciantge, getSessaoOnboardingComerciantge } from './onboarding.js'
import { criarVinculo, removerVinculo, getRepresentantesVinculados, getComerciantesVinculados,
         findRepByCodigoConvite, gerarCodigoConvite } from '../db/vinculos.js'
import 'dotenv/config'

const TIMEOUT_HORAS = parseInt(process.env.COTACAO_TIMEOUT_HORAS ?? '24')

// ── Estado transiente para fluxos de vínculo ─────────────────────────
// Guarda por 5min o que o usuário está fazendo (adicionar fornecedor/cliente)
const _estadosVinculo = new Map() // phone → { acao, expiresAt }

function setEstadoVinculo(phone, acao) {
  _estadosVinculo.set(phone, { acao, expiresAt: Date.now() + 5 * 60_000 })
}
function getEstadoVinculo(phone) {
  const estado = _estadosVinculo.get(phone)
  if (!estado) return null
  if (Date.now() > estado.expiresAt) { _estadosVinculo.delete(phone); return null }
  return estado
}
function clearEstadoVinculo(phone) { _estadosVinculo.delete(phone) }

// ── Deduplicação de webhooks ──────────────────────────────────────────
// Meta Cloud API pode entregar o mesmo webhook 2x em rápida sucessão.
// Guarda messageIds processados por 60s para descartar duplicatas.

const _mensagensProcessadas = new Map() // messageId → timestamp

function jaProcessada(messageId) {
  if (!messageId) return false
  const agora = Date.now()
  // Limpa entradas com mais de 60s
  for (const [id, ts] of _mensagensProcessadas) {
    if (agora - ts > 60_000) _mensagensProcessadas.delete(id)
  }
  if (_mensagensProcessadas.has(messageId)) return true
  _mensagensProcessadas.set(messageId, agora)
  return false
}

// ── Entry point ───────────────────────────────────────────────────────

export async function handleWebhook(payload) {
  const normalized = normalizeMetaPayload(payload)
  if (!normalized) return { ok: true, skipped: true }

  const { phone, message, type, mediaId, mimeType, messageId } = normalized
  if (!phone || (!message && !mediaId)) return { ok: true, skipped: true }

  // Descarta webhook duplicado (Meta às vezes entrega 2x o mesmo messageId)
  if (jaProcessada(messageId)) {
    console.log(`[webhook] duplicata ignorada: ${messageId}`)
    return { ok: true, skipped: true, reason: 'duplicate' }
  }

  console.log(`[webhook] ${phone} | tipo: ${type} | "${(message ?? '').slice(0, 60)}"`)

  // 1. Verifica se está em processo de auto-cadastro
  const sessaoAtiva = await getSessaoOnboarding(phone)
  if (sessaoAtiva) {
    return handleAutocadastro(phone, message)
  }

  // 2. Verifica se é keyword de cadastro
  const msgLower = (message ?? '').trim().toLowerCase()
  if (msgLower === 'cadastro' || msgLower === 'cadastrar') {
    const rep = await findRepresentanteByTelefone(phone)
    if (!rep) {
      return handleAutocadastro(phone, message)
    }
  }

  // 3. Rota normal: representante ou comerciante
  const rep = await findRepresentanteByTelefone(phone)
  if (rep) {
    return handleMensagemRepresentante({ rep, message, type, mediaId, mimeType })
  }

  // 4. Verifica onboarding do comerciante em andamento
  const sessaoComerciantge = await getSessaoOnboardingComerciantge(phone)
  if (sessaoComerciantge) {
    return handleOnboardingComerciantge(phone, message)
  }

  // 5. Comerciante existente com cadastro completo
  const { data: comercianteExistente } = await supabase
    .from('comerciantes')
    .select('id, nome, empresa')
    .eq('telefone', phone)
    .single()

  if (comercianteExistente?.empresa) {
    return handleMensagemComerciantge({ phone, message, type, mediaId, mimeType })
  }

  // 6. Número desconhecido — inicia seleção de perfil
  if (!comercianteExistente) {
    await supabase.from('comerciantes').insert({ telefone: phone, nome: phone })
  }
  return handleAutocadastro(phone, message)
}

// ── Mensagem de boas-vindas para números desconhecidos ────────────────
// Chamada quando número não é rep nem está em onboarding

export async function handleNumeroDesconhecido(phone, message) {
  // Se parece uma lista de produtos (tem número + produto), trata como comerciante
  const pareceListaProdutos = /\d+.*(?:cx|caixa|fardo|kg|un|pct|lt|gf|pacote|unidade)/i.test(message ?? '')
  if (pareceListaProdutos || (message ?? '').length > 30) {
    return null // deixa o fluxo de comerciante tratar
  }

  // Mensagem curta e genérica — orienta sobre as opções
  await sendText(phone, [
    'Olá! Bem-vindo ao *Kota*.',
    '',
    'Sou um assistente de cotações. Como posso te ajudar?',
    '',
    '*Sou comerciante* — envie sua lista de produtos para cotar',
    '*Sou representante* — envie *CADASTRO* para se registrar',
  ].join('\n'))

  return { ok: true, skipped: true }
}

// ── FLUXO DO COMERCIANTE ─────────────────────────────────────────────

async function handleMensagemComerciantge({ phone, message, type, mediaId, mimeType }) {
  // Se mensagem curta e genérica, orienta sobre cadastro vs cotação
  const msgLower = (message ?? '').trim().toLowerCase()
  const msgCurta = (message ?? '').trim().length < 15
  const palavrasGenericas = ['oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'hi', 'hello', 'teste', 'test']
  const isGenerica = palavrasGenericas.some(p => msgLower === p || msgLower.startsWith(p + ' '))

  if (msgCurta && isGenerica && type === 'texto') {
    await sendText(phone, [
      '*Kota*',
      '',
      'Envie sua lista para cotar produtos.',
      'Representante? Envie *CADASTRO*.',
    ].join('\n'))
    return { ok: true }
  }

  const comerciante = await findOrCreateComercianteByTelefone(phone)

  // ── Estado transiente: aguardando telefone do fornecedor ─────────────
  const estadoAtual = getEstadoVinculo(phone)
  if (estadoAtual?.acao === 'aguardando_telefone_fornecedor' && type === 'texto') {
    clearEstadoVinculo(phone)
    return handleVincularRepPorTelefone(comerciante, phone, message.trim())
  }

  // ── Comandos naturais ──────────────────────────────────────────────
  const cmd = msgLower.trim()

  // Vincular fornecedor por código de convite: "fornecedor ABC123"
  const matchCodigo = cmd.match(/^fornecedor\s+([a-z0-9]{6})$/i)
  if (matchCodigo) {
    return handleVincularRepPorCodigo(comerciante, phone, matchCodigo[1])
  }

  // Vincular fornecedor por telefone: "fornecedor 11999990001"
  const matchTelefone = cmd.match(/^fornecedor\s+([\d\s\-\+]+)$/)
  if (matchTelefone) {
    const tel = matchTelefone[1].replace(/[\s\-\+]/g, '')
    return handleVincularRepPorTelefone(comerciante, phone, tel)
  }

  // Listar fornecedores vinculados
  if (cmd === 'meus fornecedores' || cmd === 'fornecedores') {
    return handleListarFornecedores(comerciante, phone)
  }

  // Iniciar fluxo de adicionar fornecedor
  if (cmd === 'adicionar fornecedor' || cmd === 'novo fornecedor' || cmd === 'add fornecedor') {
    setEstadoVinculo(phone, 'aguardando_telefone_fornecedor')
    await sendText(phone, [
      'Qual o telefone ou código do fornecedor?',
      '',
      '• Telefone: _11999990001_',
      '• Código de convite: _ABC123_',
      '',
      'Envie *cancelar* para desistir.',
    ].join('\n'))
    return { ok: true }
  }

  if (cmd === 'minha cotacao' || cmd === 'minha cotação' || cmd === 'cotacao' || cmd === 'cotação') {
    return handleVerCotacaoAtual(comerciante, phone)
  }

  if (cmd === 'cancelar' || cmd === 'cancelar cotacao' || cmd === 'cancelar cotação') {
    return handleCancelarCotacao(comerciante, phone)
  }

  if (cmd === 'nova cotacao' || cmd === 'nova cotação' || cmd === 'descartar') {
    // Cancela qualquer cotação em aberto e orienta a enviar nova lista
    const { data: cotacaoAberta } = await supabase
      .from('cotacoes')
      .select('*')
      .eq('comerciante_id', comerciante.id)
      .in('status', ['aguardando_respostas', 'aguardando_escolha', 'consulta'])
      .order('criado_em', { ascending: false })
      .limit(1)
      .single()

    if (cotacaoAberta) {
      return handleCancelarParaNovaCotacao(comerciante, cotacaoAberta, phone)
    }
    await sendText(phone, 'Você não tem nenhuma cotação em aberto. Pode enviar sua lista de produtos!')
    return { ok: true }
  }

  if (cmd === 'historico' || cmd === 'histórico') {
    return handleHistorico(comerciante, phone)
  }

  // ── Cotação aguardando escolha (modo compra) ──────────────────────
  const { data: cotacaoAguardandoEscolha } = await supabase
    .from('cotacoes')
    .select('*')
    .eq('comerciante_id', comerciante.id)
    .eq('status', 'aguardando_escolha')
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  if (cotacaoAguardandoEscolha && message) {

    // ── Passo 2: intenção já confirmada → usuário está escolhendo fornecedor ──
    if (cotacaoAguardandoEscolha.obs_interna === 'confirmando:comprar') {
      // "0" ou "voltar" → limpa estado e reenvia o comparativo
      if (cmd === '0' || cmd === 'voltar' || cmd === 'voltar ao comparativo') {
        await supabase.from('cotacoes')
          .update({ obs_interna: null })
          .eq('id', cotacaoAguardandoEscolha.id)
        return handleReenviarComparativo(comerciante, cotacaoAguardandoEscolha, phone)
      }
      // "nova cotação" ou "descartar" → cancela e libera para nova lista
      if (cmd === 'nova cotacao' || cmd === 'nova cotação' || cmd === 'descartar' || cmd === 'cancelar') {
        return handleCancelarParaNovaCotacao(comerciante, cotacaoAguardandoEscolha, phone)
      }
      if (/^\d+$/.test(cmd) || cmd.length > 3) {
        return handleEscolhaFornecedor({ comerciante, cotacao: cotacaoAguardandoEscolha, resposta: message })
      }
      // Resposta não reconhecida: repete a lista de fornecedores
      return handlePedirEscolhaFornecedor(comerciante, cotacaoAguardandoEscolha, phone)
    }

    // ── Passo 1: resposta de intenção (1 / 2 / 3) ────────────────────────────
    if (cmd === '1' || cmd === 'comprar' || cmd === 'comprar agora') {
      // Seta estado para aguardar escolha de fornecedor
      await supabase.from('cotacoes')
        .update({ obs_interna: 'confirmando:comprar' })
        .eq('id', cotacaoAguardandoEscolha.id)
      return handlePedirEscolhaFornecedor(comerciante, cotacaoAguardandoEscolha, phone)
    }
    if (cmd === '2' || cmd === 'so consulta' || cmd === 'só consulta' || cmd === 'consultando') {
      await supabase.from('cotacoes')
        .update({ status: 'consulta', obs_interna: null })
        .eq('id', cotacaoAguardandoEscolha.id)
      await sendText(phone, [
        'Entendido! Seus preços foram salvos para consulta.',
        '',
        'Quando quiser comprar, é só enviar *comprar* que retomo a cotação.',
        'Ou envie uma nova lista quando precisar cotar novamente.',
      ].join('\n'))
      return { ok: true }
    }
    if (cmd === '3' || cmd === 'decidir depois' || cmd === 'depois') {
      await sendText(phone, [
        'Ok! Sua cotação fica salva por 7 dias.',
        '',
        'Quando quiser retomar, envie *comprar* ou *minha cotação*.',
      ].join('\n'))
      return { ok: true }
    }
    if (cmd === '4' || cmd === 'nova cotacao' || cmd === 'nova cotação' || cmd === 'descartar') {
      return handleCancelarParaNovaCotacao(comerciante, cotacaoAguardandoEscolha, phone)
    }
    // Número ou nome direto sem ter respondido intenção — trata como escolha imediata
    if (/^\d+$/.test(cmd) || cmd.length > 3) {
      return handleEscolhaFornecedor({ comerciante, cotacao: cotacaoAguardandoEscolha, resposta: message })
    }
  }

  // ── Cotação em modo consulta — pode reativar ──────────────────────
  if (cmd === 'comprar') {
    const { data: cotacaoConsulta } = await supabase
      .from('cotacoes')
      .select('*')
      .eq('comerciante_id', comerciante.id)
      .eq('status', 'consulta')
      .order('criado_em', { ascending: false })
      .limit(1)
      .single()

    if (cotacaoConsulta) {
      await supabase.from('cotacoes')
        .update({ status: 'aguardando_escolha', obs_interna: null })
        .eq('id', cotacaoConsulta.id)
      return handleReenviarComparativo(comerciante, cotacaoConsulta, phone)
    }
  }

  // ── Nova lista com cotação pendente ──────────────────────────────
  const { data: cotacaoPendente } = await supabase
    .from('cotacoes')
    .select('*')
    .eq('comerciante_id', comerciante.id)
    .in('status', ['aguardando_respostas', 'aguardando_escolha', 'consulta'])
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  if (cotacaoPendente && (message?.length > 10 || mediaId)) {
    const statusLabel = cotacaoPendente.status === 'aguardando_respostas' ? 'aguardando respostas' :
                        cotacaoPendente.status === 'aguardando_escolha' ? 'comparativo pronto' : 'salva para consulta'
    await sendText(phone, [
      `Você tem uma cotação em aberto *#${cotacaoPendente.id.slice(-6).toUpperCase()}* (${statusLabel}).`,
      '',
      'O que deseja fazer?',
      '1. Ver cotação em aberto',
      '2. Iniciar nova cotação',
    ].join('\n'))
    // Salva intenção de nova cotação temporariamente
    await supabase.from('comerciantes').update({ 
      nome: comerciante.nome // trigger para salvar pending_message
    }).eq('id', comerciante.id)
    // Armazena mensagem pendente no banco
    await supabase.from('cotacoes').update({ 
      obs_interna: message ?? `[${type}]`
    }).eq('id', cotacaoPendente.id).is('obs_interna', null)
    return { ok: true }
  }

  await sendText(phone, 'Processando...')

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

  // Extrai lista com IA — Feature 5: passa comercianteId para sugestão de quantidades
  let extraido
  try {
    extraido = await extrairListaProdutos(mensagemParaIA, { comercianteId: comerciante.id })
  } catch (err) {
    console.error('[webhook] erro ao extrair lista:', err.message)
    await sendText(phone, [
      'Não consegui processar sua lista. Tente novamente ou envie em outro formato:',
      '',
      '• Foto da lista escrita ou impressa',
      '• Arquivo PDF',
      '',
      'Se preferir por texto, envie um item por linha:',
      '_2cx Coca-Cola 2L_',
      '_1fd Detergente Ypê 500ml_',
    ].join('\n'))
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

  // Confirma lista ao comerciante — quebra em múltiplas mensagens se necessário
  const LIMITE_CHARS = 3800
  const totalItens = extraido.itens.length
  const temSugestoes = extraido.itens.some(it => it.obs?.includes('histórico'))

  const linhas = extraido.itens.map((it, i) => {
    const marca = it.marca ? ` (${it.marca})` : ''
    const un = it.unidade ? ` – ${it.unidade}` : ''
    const sufixo = it.obs?.includes('histórico') ? ' _(sugestão)_' : ''
    return `${i + 1}. ${it.produto}${marca}${un} × ${it.quantidade ?? 1}${sufixo}`
  })

  // Agrupa linhas em blocos respeitando o limite da Meta
  const blocosMensagem = []
  let blocoAtual = ''
  for (const linha of linhas) {
    if ((blocoAtual + '\n' + linha).length > LIMITE_CHARS) {
      blocosMensagem.push(blocoAtual.trim())
      blocoAtual = linha
    } else {
      blocoAtual += (blocoAtual ? '\n' : '') + linha
    }
  }
  if (blocoAtual) blocosMensagem.push(blocoAtual.trim())

  // Envia primeira mensagem com cabeçalho
  const cabecalho = `*Entendi sua lista — ${totalItens} produto(s):*\n\n`
  await sendText(phone, cabecalho + blocosMensagem[0])

  // Envia blocos intermediários
  for (let i = 1; i < blocosMensagem.length - 1; i++) {
    await sendText(phone, blocosMensagem[i])
  }

  // Envia último bloco com rodapé
  const rodape = [
    temSugestoes ? '_Quantidades com (sugestão) são baseadas no seu histórico._' : '',
    '',
    'Verificando catálogos dos representantes...',
  ].filter(Boolean).join('\n')

  const ultimoBloco = blocosMensagem.length > 1 ? blocosMensagem[blocosMensagem.length - 1] : ''
  if (ultimoBloco) {
    await sendText(phone, ultimoBloco + '\n\n' + rodape)
  } else {
    await sendText(phone, rodape)
  }

  // ── Tenta cotação automática ──────────────────────────────────────
  const { repsAutomaticos, repsManuais, itensSemCobertura, modo } =
    await resolverCotacaoAutomatica(cotacao.id, itens, comerciante.id)

  // Salva propostas automáticas
  for (const { rep, propostas } of repsAutomaticos) {
    await salvarPropostasAutomaticas(cotacao.id, rep.id, propostas)
  }

  if (modo === 'automatico') {
    // Todos os reps têm catálogo — consolida já
    await sendText(phone, 'Todos os fornecedores têm catálogo atualizado. Comparativo pronto em segundos!')
    await consolidarEEnviar(cotacao.id)
  } else {
    // Misto ou manual — avisa o que está acontecendo
    const msgs = ['Consultando fornecedores:']
    if (repsAutomaticos.length) {
      msgs.push(`${repsAutomaticos.length} fornecedor(es) com catálogo responderam automaticamente`)
    }
    if (repsManuais.length) {
      msgs.push(`${repsManuais.length} fornecedor(es) sem catálogo serão consultados via WhatsApp`)
      // Dispara para os reps sem catálogo
      await dispararParaRepsManuais(cotacao, itens, repsManuais)
    }
    if (itensSemCobertura.length) {
      msgs.push(`${itensSemCobertura.length} item(ns) sem cobertura em nenhum catálogo`)
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
      await sendTextOrTemplate(rep.telefone, template, rep.nome)
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
    await sendText(rep.telefone, 'Envie sua tabela de preços (Excel, PDF, foto) ou responda a cotação em texto.')
    return { ok: true }
  }

  const cmd = (message ?? '').trim().toLowerCase()

  // ── Estado transiente: aguardando telefone do cliente ────────────────
  const estadoAtual = getEstadoVinculo(rep.telefone)
  if (estadoAtual?.acao === 'aguardando_telefone_cliente' && type === 'texto') {
    clearEstadoVinculo(rep.telefone)
    return handleVincularComerciantePorTelefone(rep, message.trim())
  }

  // ── Comandos de vínculo do representante ─────────────────────────────

  // Vincular comerciante por telefone: "cliente 11999990001"
  const matchCliente = cmd.match(/^cliente\s+([\d\s\-\+]+)$/)
  if (matchCliente) {
    const tel = matchCliente[1].replace(/[\s\-\+]/g, '')
    return handleVincularComerciantePorTelefone(rep, tel)
  }

  // Listar clientes vinculados
  if (cmd === 'meus clientes' || cmd === 'clientes') {
    return handleListarClientes(rep)
  }

  // Adicionar cliente
  if (cmd === 'adicionar cliente' || cmd === 'novo cliente' || cmd === 'add cliente') {
    setEstadoVinculo(rep.telefone, 'aguardando_telefone_cliente')
    await sendText(rep.telefone, [
      'Qual o telefone do cliente?',
      '',
      'Ex: _11999990001_',
      '',
      'Envie *cancelar* para desistir.',
    ].join('\n'))
    return { ok: true }
  }

  // Meu código de convite
  if (cmd === 'meu codigo' || cmd === 'meu código' || cmd === 'codigo' || cmd === 'código' || cmd === 'convite') {
    const codigo = await gerarCodigoConvite(rep.id)
    await sendText(rep.telefone, [
      `*Seu código de convite: ${codigo}*`,
      '',
      'Compartilhe com seus clientes. Eles devem enviar para o Kota:',
      `_fornecedor ${codigo}_`,
      '',
      'Ou informe seu telefone para eles adicionarem diretamente.',
    ].join('\n'))
    return { ok: true }
  }

  // Cancelar fluxo de vínculo
  if (cmd === 'cancelar') {
    clearEstadoVinculo(rep.telefone)
    await sendText(rep.telefone, 'Ok, operação cancelada.')
    return { ok: true }
  }

  // Classifica o que o rep está enviando (só para texto)
  let classificacao = 'cotacao'
  if (message && type === 'texto') {
    classificacao = await classificarMensagemRep(message)
  } else if (['planilha', 'pdf', 'foto'].includes(type)) {
    classificacao = 'catalogo'
  } else if (type === 'documento') {
    // Documento de formato não mapeado (ex: .numbers, .pages, .ods, .csv sem extensão)
    // Verifica se o mimeType é suportado antes de tentar processar
    const mimeSuportado = mimeType && (
      mimeType.includes('sheet') ||
      mimeType.includes('excel') ||
      mimeType.includes('pdf') ||
      mimeType.includes('csv')
    )
    if (mimeSuportado) {
      classificacao = 'catalogo'
    } else {
      await sendText(rep.telefone, [
        'Não consigo processar esse formato de arquivo.',
        '',
        'Para enviar seu catálogo, use:',
        '• Planilha Excel (.xlsx) — recomendado',
        '• PDF',
        '• Foto da tabela impressa',
        '• Lista em texto (ex: _Coca-Cola 2L · R$ 8,50 · pgto 30d_)',
      ].join('\n'))
      return { ok: true }
    }
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
  await sendText(rep.telefone, 'Recebido! Processando...')

  try {
    const extraido = await extrairCatalogo({ tipo: type, texto: message, mediaId, mimeType })

    if (!extraido.itens?.length) {
      await sendText(rep.telefone, 'Não encontrei produtos com preços. Envie uma planilha Excel ou lista no formato:\nProduto – R$ X,XX – pgto Xd – entrega Xd')
      return { ok: false }
    }

    const resultado = await upsertCatalogoEmLote(rep.id, extraido.itens, type === 'texto' ? 'whatsapp' : type)

    const msgs = [
      `*Catálogo atualizado!*`,
      ``,
      `${resultado.inseridos > 0 ? `${resultado.inseridos} novo(s) produto(s) adicionado(s)` : ''}`,
      `${resultado.atualizados > 0 ? `${resultado.atualizados} produto(s) com preço atualizado` : ''}`,
      ``,
      `Agora, a IA do Kota responde automaticamente suas próximas cotações.`,
    ].filter(l => l !== '')

    if (resultado.erros.length) {
      msgs.push(`${resultado.erros.length} item(ns) com erro — não foram salvos`)
    }

    // Feature 4: inclui aviso de variações significativas na confirmação para o rep
    if (resultado.alertas?.length) {
      msgs.push(``)
      msgs.push(`*Variações de preço detectadas (≥10%):*`)
      for (const al of resultado.alertas) {
        const seta = al.subiu ? '📈' : '📉'
        const sinal = al.subiu ? '+' : ''
        msgs.push(`${seta} ${al.produto}: R$ ${al.preco_anterior?.toFixed(2)} → R$ ${al.preco_novo?.toFixed(2)} (${sinal}${al.variacao_pct}%)`)
      }
    }

    await sendText(rep.telefone, msgs.join('\n'))

    // Feature 4: notifica comerciantes com cotações ativas que têm esses produtos
    if (resultado.alertas?.length) {
      await notificarComerciantesComVariacao(resultado.alertas, rep)
    }

    return { ok: true, inseridos: resultado.inseridos, atualizados: resultado.atualizados }

  } catch (err) {
    console.error('[catalogo] erro:', err.message)
    await sendText(rep.telefone, 'Erro ao processar sua tabela. Tente enviar um arquivo Excel (.xlsx) ou liste os produtos em texto.')
    return { ok: false }
  }
}

// Feature 4: busca comerciantes com cotações ativas e notifica sobre variação de preço
async function notificarComerciantesComVariacao(alertas, rep) {
  try {
    const produtosAfetados = alertas.map(a => a.produto)

    // Busca cotacao_itens com esses produtos em cotações aguardando respostas ou escolha
    const { data: itensAtivos } = await supabase
      .from('cotacao_itens')
      .select(`
        produto,
        cotacoes!inner(
          id, status,
          comerciantes!inner(id, telefone, nome)
        )
      `)
      .in('produto', produtosAfetados)
      .in('cotacoes.status', ['aguardando_respostas', 'aguardando_escolha'])

    if (!itensAtivos?.length) return

    // Deduplicar por telefone de comerciante
    const notificados = new Set()
    for (const item of itensAtivos) {
      const comerciante = item.cotacoes?.comerciantes
      if (!comerciante?.telefone || notificados.has(comerciante.telefone)) continue
      notificados.add(comerciante.telefone)

      // Filtra só os alertas relevantes para este comerciante
      const alertasDoItem = alertas.filter(al =>
        al.produto.toLowerCase().includes(item.produto?.toLowerCase()) ||
        item.produto?.toLowerCase().includes(al.produto?.toLowerCase())
      )
      if (!alertasDoItem.length) continue

      const linhasAlerta = alertasDoItem.map(al => {
        const seta = al.subiu ? '📈' : '📉'
        const sinal = al.subiu ? '+' : ''
        return `${seta} ${al.produto}: ${sinal}${al.variacao_pct}% (R$ ${al.preco_anterior?.toFixed(2)} → R$ ${al.preco_novo?.toFixed(2)})`
      }).join('\n')

      await sendText(comerciante.telefone, [
        `*Alerta de preço — ${rep.nome} (${rep.empresa ?? ''})* atualizo sua tabela.`,
        ``,
        `Produtos com variação ≥ 10% em sua cotação em aberto:`,
        linhasAlerta,
        ``,
        `Envie *minha cotação* para ver o comparativo atualizado.`,
      ].join('\n'))

      console.log(`[variacao] notificado: ${comerciante.nome} (${comerciante.telefone}) sobre ${alertasDoItem.length} produto(s)`)
    }
  } catch (err) {
    // Não deixa falha na notificação derrubar o fluxo principal
    console.error('[notificarComerciantesComVariacao] erro:', err.message)
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
      `*Promoção salva!*`,
      `${extraido.itens.length} produto(s) com preço promocional ativo.`,
      `Será usado automaticamente nas próximas cotações!`,
    ].join('\n'))

    return { ok: true }
  } catch (err) {
    console.error('[promocao] erro:', err.message)
    await sendText(rep.telefone, 'Erro ao salvar promoção. Tente no formato:\nProduto – R$ XX – válido até DD/MM')
    return { ok: false }
  }
}

// ── Rep responde cotação manualmente ─────────────────────────────────

async function handleRespostaCotacao({ rep, message }) {
  if (!message) {
    await sendText(rep.telefone, 'Para responder a cotação, envie os preços em texto.')
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
    await sendText(rep.telefone, 'Não entendi sua proposta. Formato esperado:\n1. Produto – R$ 0,00 – pgto Xd – entrega Xd')
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

  await sendText(rep.telefone, 'Proposta recebida! Obrigado. Se você for escolhido, o pedido chegará em seguida.')

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
    await sendText(cotacao.comerciantes.telefone, 'Nenhum fornecedor respondeu. Tente novamente mais tarde.')
    return
  }

  const consolidado = consolidarPropostas(itens, propostas)

  for (const rep of consolidado.rankingFornecedores) {
    await supabase.from('propostas').update({ score: rep.score })
      .eq('cotacao_id', cotacaoId).eq('representante_id', rep.id)
  }

  await supabase.from('cotacoes').update({ status: 'aguardando_escolha' }).eq('id', cotacaoId)

  // Feature 3: gera resumo em linguagem natural com trade-offs
  const resumo = await gerarResumoNegociacao(consolidado)

  const msgComparativo = templateComparativoComIntencao(consolidado, cotacaoId, resumo)
  await sendText(cotacao.comerciantes.telefone, msgComparativo)
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

  // Mensagem de confirmação final ao comerciante
  const linhasPedido = pedidoItens.map(it => {
    const marca = it.marca ? ` (${it.marca})` : ''
    return `${it.produto}${marca}: R$ ${it.preco_unitario?.toFixed(2)} × ${it.quantidade ?? 1}`
  }).join('\n')

  await sendText(comerciante.telefone, [
    `Pedido confirmado.`,
    ``,
    `${repEscolhido.nome} · ${repEscolhido.empresa ?? ''}`,
    linhasPedido,
    ``,
    `Total: R$ ${pedido.valor_total?.toFixed(2)}`,
    `Pagamento: ${pedido.prazo_pagamento_dias}d · Entrega: ${pedido.prazo_entrega_dias}d`,
    ``,
    `O representante foi notificado.`,
  ].join('\n'))

  const resumo = pedidoItens.map(it => `• ${it.produto} ×${it.quantidade} — R$ ${it.preco_total?.toFixed(2)}`).join('\n')
  await sendText(repEscolhido.telefone, [
    `*Pedido #${pedido.id.slice(-6).toUpperCase()} recebido!*`, '',
    `Cliente: ${comerciante.nome} (${comerciante.telefone})`, '',
    resumo, '',
    `*Total: R$ ${valorTotal.toFixed(2)}*`,
    `Pagamento: ${pedido.prazo_pagamento_dias}d | Entrega: ${pedido.prazo_entrega_dias}d`,
  ].join('\n'))

  return { ok: true, pedidoId: pedido.id }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }


// ── Ver cotação atual ─────────────────────────────────────────────────
async function handleVerCotacaoAtual(comerciante, phone) {
  const { data: cotacao } = await supabase
    .from('cotacoes')
    .select('*')
    .eq('comerciante_id', comerciante.id)
    .in('status', ['aguardando_respostas', 'aguardando_escolha', 'consulta'])
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  if (!cotacao) {
    await sendText(phone, 'Você não tem nenhuma cotação em aberto no momento.\n\nEnvie uma lista de produtos para iniciar uma nova cotação.')
    return { ok: true }
  }

  const statusMsg = {
    aguardando_respostas: 'Aguardando respostas dos fornecedores',
    aguardando_escolha:   '📊 Comparativo pronto — aguardando sua escolha',
    consulta:             'Salva para consulta',
  }[cotacao.status] ?? cotacao.status

  const itensCotacao = await supabase.from('cotacao_itens').select('*').eq('cotacao_id', cotacao.id).order('ordem')

  const itensStr = (itensCotacao.data ?? []).map((it, i) => 
    `${i+1}. ${it.produto}${it.marca ? ` (${it.marca})` : ''} × ${it.quantidade ?? 1}`
  ).join('\n')

  await sendText(phone, [
    `*Cotação #${cotacao.id.slice(-6).toUpperCase()}*`,
    `Status: ${statusMsg}`,
    `Data: ${new Date(cotacao.criado_em).toLocaleDateString('pt-BR')}`,
    '',
    '*Itens:*',
    itensStr,
    '',
    cotacao.status === 'aguardando_escolha' ? 'Envie *comprar* para ver o comparativo e fechar o pedido.' :
    cotacao.status === 'consulta' ? 'Envie *comprar* para retomar e fechar o pedido.' :
    'Aguarde as respostas dos fornecedores.',
  ].join('\n'))

  return { ok: true }
}

// ── Cancelar cotação ──────────────────────────────────────────────────
async function handleCancelarCotacao(comerciante, phone) {
  const { data: cotacao } = await supabase
    .from('cotacoes')
    .select('*')
    .eq('comerciante_id', comerciante.id)
    .in('status', ['aguardando_respostas', 'aguardando_escolha', 'consulta'])
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  if (!cotacao) {
    await sendText(phone, 'Você não tem nenhuma cotação em aberto para cancelar.')
    return { ok: true }
  }

  await supabase.from('cotacoes').update({ status: 'cancelada', fechado_em: new Date().toISOString() }).eq('id', cotacao.id)
  await sendText(phone, `Cotação *#${cotacao.id.slice(-6).toUpperCase()}* cancelada.\n\nEnvie uma nova lista quando quiser cotar novamente.`)
  return { ok: true }
}

// ── Histórico de cotações ─────────────────────────────────────────────
async function handleHistorico(comerciante, phone) {
  const { data: cotacoes } = await supabase
    .from('cotacoes')
    .select('*')
    .eq('comerciante_id', comerciante.id)
    .order('criado_em', { ascending: false })
    .limit(5)

  if (!cotacoes?.length) {
    await sendText(phone, 'Você ainda não fez nenhuma cotação.')
    return { ok: true }
  }

  const statusEmoji = {
    pedido_gerado: '✅', aguardando_escolha: '📊', aguardando_respostas: '⏳',
    consulta: '🔍', cancelada: '❌'
  }

  const linhas = cotacoes.map(c => 
    `${statusEmoji[c.status] ?? '•'} *#${c.id.slice(-6).toUpperCase()}* — ${new Date(c.criado_em).toLocaleDateString('pt-BR')} — ${c.input_raw?.slice(0, 40) ?? ''}...`
  ).join('\n')

  await sendText(phone, `*Suas últimas cotações:*\n\n${linhas}\n\nEnvie *minha cotação* para ver detalhes da cotação em aberto.`)
  return { ok: true }
}

// ── Pedir escolha de fornecedor (pós-intenção de compra) ─────────────────
async function handlePedirEscolhaFornecedor(comerciante, cotacao, phone) {
  const { itens } = await getCotacaoComItens(cotacao.id)
  const propostas = await getPropostasDaCotacao(cotacao.id)
  const consolidado = consolidarPropostas(itens, propostas)
  const reps = consolidado.rankingFornecedores

  const opcoes = reps.map((r, i) =>
    `${i + 1}. *${r.nome}* (${r.empresa ?? ''}) — R$ ${r.valor_total?.toFixed(2) ?? '?'}`
  ).join('\n')

  await sendText(phone, [
    'Com qual fornecedor deseja fechar o pedido?',
    '',
    opcoes,
    '',
    'Responda com o *número* do fornecedor.',
    'Envie *0* para voltar ao comparativo.',
    'Envie *descartar* para cancelar e fazer uma nova cotação.',
  ].join('\n'))
  return { ok: true }
}

// ── Cancelar cotação atual e liberar para nova ────────────────────────
// ── Handlers de vínculos — Comerciante ───────────────────────────────

async function handleVincularRepPorCodigo(comerciante, phone, codigo) {
  const rep = await findRepByCodigoConvite(codigo)
  if (!rep) {
    await sendText(phone, [
      `Código *${codigo.toUpperCase()}* não encontrado.`,
      '',
      'Confirme o código com seu fornecedor e tente novamente.',
    ].join('\n'))
    return { ok: true }
  }
  return handleConfirmarVinculoComRep(comerciante, phone, rep)
}

async function handleVincularRepPorTelefone(comerciante, phone, telefone) {
  // Normaliza telefone
  const tel = telefone.replace(/\D/g, '')
  const { data: rep } = await supabase
    .from('representantes')
    .select('*')
    .eq('telefone', tel)
    .eq('ativo', true)
    .single()

  if (!rep) {
    await sendText(phone, [
      'Fornecedor não encontrado com esse telefone.',
      '',
      'Verifique o número ou peça o código de convite ao fornecedor.',
    ].join('\n'))
    return { ok: true }
  }
  return handleConfirmarVinculoComRep(comerciante, phone, rep)
}

async function handleConfirmarVinculoComRep(comerciante, phone, rep) {
  await criarVinculo(comerciante.id, rep.id)

  await sendText(phone, [
    `*${rep.nome}* (${rep.empresa ?? ''}) adicionado como fornecedor.`,
    '',
    'Nas próximas cotações, ele receberá seus pedidos automaticamente.',
  ].join('\n'))

  // Notifica o rep
  await sendText(rep.telefone, [
    `*${comerciante.nome ?? 'Um comerciante'}* adicionou você como fornecedor no Kota.`,
    '',
    'Você receberá as cotações desse cliente automaticamente.',
  ].join('\n'))

  return { ok: true }
}

async function handleListarFornecedores(comerciante, phone) {
  const reps = await getRepresentantesVinculados(comerciante.id)

  if (!reps.length) {
    await sendText(phone, [
      'Você ainda não tem fornecedores vinculados.',
      '',
      'Para adicionar:',
      '• Envie _fornecedor CODIGO_ com o código do fornecedor',
      '• Envie _fornecedor 11999990001_ com o telefone',
      '• Envie _adicionar fornecedor_ para iniciar o fluxo',
    ].join('\n'))
    return { ok: true }
  }

  const lista = reps.map((r, i) => `${i + 1}. *${r.nome}* — ${r.empresa ?? ''}`).join('\n')
  await sendText(phone, [
    `*Seus fornecedores (${reps.length}):*`,
    '',
    lista,
    '',
    'Para adicionar novo: _adicionar fornecedor_',
  ].join('\n'))
  return { ok: true }
}

// ── Handlers de vínculos — Representante ─────────────────────────────

async function handleVincularComerciantePorTelefone(rep, telefone) {
  const tel = telefone.replace(/\D/g, '')
  const { data: comerciante } = await supabase
    .from('comerciantes')
    .select('*')
    .eq('telefone', tel)
    .single()

  if (!comerciante) {
    await sendText(rep.telefone, [
      'Cliente não encontrado com esse telefone.',
      '',
      'O cliente precisa estar cadastrado no Kota.',
    ].join('\n'))
    return { ok: true }
  }

  await criarVinculo(comerciante.id, rep.id)

  await sendText(rep.telefone, [
    `*${comerciante.nome ?? 'Cliente'}* vinculado com sucesso.`,
    '',
    'Você receberá as cotações desse cliente automaticamente.',
  ].join('\n'))

  await sendText(comerciante.telefone, [
    `*${rep.nome}* (${rep.empresa ?? ''}) foi adicionado como seu fornecedor no Kota.`,
  ].join('\n'))

  return { ok: true }
}

async function handleListarClientes(rep) {
  const comerciantes = await getComerciantesVinculados(rep.id)

  if (!comerciantes.length) {
    await sendText(rep.telefone, [
      'Você ainda não tem clientes vinculados.',
      '',
      'Para adicionar:',
      '• Envie _cliente 11999990001_ com o telefone do cliente',
      '• Compartilhe seu código: envie _meu código_',
    ].join('\n'))
    return { ok: true }
  }

  const lista = comerciantes.map((c, i) => `${i + 1}. *${c.nome ?? c.telefone}*`).join('\n')
  await sendText(rep.telefone, [
    `*Seus clientes (${comerciantes.length}):*`,
    '',
    lista,
    '',
    'Para adicionar novo: _adicionar cliente_',
  ].join('\n'))
  return { ok: true }
}

async function handleCancelarParaNovaCotacao(comerciante, cotacao, phone) {
  await supabase.from('cotacoes')
    .update({ status: 'cancelada', obs_interna: null, fechado_em: new Date().toISOString() })
    .eq('id', cotacao.id)

  await sendText(phone, [
    `Cotação *#${cotacao.id.slice(-6).toUpperCase()}* descartada.`,
    '',
    'Pode enviar sua nova lista de produtos quando quiser!',
  ].join('\n'))
  return { ok: true }
}

// ── Reenviar comparativo para o comerciante retomar ───────────────────
async function handleReenviarComparativo(comerciante, cotacao, phone) {
  const { itens } = await getCotacaoComItens(cotacao.id)
  const propostas = await getPropostasDaCotacao(cotacao.id)

  if (!propostas?.length) {
    await sendText(phone, 'Ainda não há propostas para esta cotação.')
    return { ok: true }
  }

  const consolidado = consolidarPropostas(itens, propostas)
  const msg = templateComparativoComIntencao(consolidado, cotacao.id)
  await sendText(phone, msg)
  return { ok: true }
}

// ── Template comparativo com pergunta de intenção ─────────────────────
function templateComparativoComIntencao(consolidado, cotacaoId, resumo = null) {
  const { propostas } = consolidado

  const reps = [...new Set(propostas.map(p => p.representantes?.nome))]
  const msg = [`*Cotação #${cotacaoId.slice(-6).toUpperCase()}*`]

  for (const rep of reps) {
    const props = propostas.filter(p => p.representantes?.nome === rep)
    const empresa = props[0]?.representantes?.empresa ?? ''
    const pg = props[0]?.prazo_pagamento_dias
    const en = props[0]?.prazo_entrega_dias
    const origem = props[0]?.origem // catalogo | manual | promocao
    const criadoEm = props[0]?.criado_em
      ? new Date(props[0].criado_em).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
      : null

    msg.push('')
    msg.push(`*${rep}* · ${empresa}`)

    // Informa origem da resposta
    if (origem === 'catalogo' || origem === 'promocao') {
      msg.push(`Catálogo · atualizado em ${criadoEm ?? '—'}`)
    } else {
      msg.push(`Resposta manual · ${criadoEm ?? '—'}`)
    }

    msg.push('')
    msg.push('Preço por item:')
    for (const p of props) {
      const marca = p.marca ? ` (${p.marca})` : ''
      msg.push(`${p.produto}${marca}: R$ ${p.preco_unitario?.toFixed(2)}`)
    }

    msg.push('')
    msg.push('Condições:')
    msg.push(`Prazo de Pagamento: ${pg ?? '?'}d`)
    msg.push(`Prazo de Entrega: ${en ?? '?'}d`)
  }

  msg.push('')
  msg.push('—')
  // Feature 3: resumo em linguagem natural com trade-offs (quando disponível)
  if (resumo) {
    msg.push(resumo)
    msg.push('')
  }
  msg.push('O que deseja fazer?')
  msg.push('1. Comprar agora — escolher fornecedor e gerar pedido')
  msg.push('2. Só estava consultando — salvar sem comprar')
  msg.push('3. Decidir depois — cotação fica salva por 7 dias')
  msg.push('4. Descartar e fazer nova cotação')

  return msg.join('\n')
}
