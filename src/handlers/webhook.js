import { supabase, findOrCreateComercianteByTelefone, findRepresentanteByTelefone,
         getCotacaoComItens, getPropostasDaCotacao, getCotacaoPendentePorTelefone,
         getAllRepresentantesAtivos } from '../db/client.js'
import { extrairListaProdutos, estruturarRespostaRep, transcreverAudio, classificarSetores } from '../agents/extractor.js'
import { extrairCatalogo, classificarMensagemRep } from '../agents/catalogo_agent.js'
import { consolidarPropostas, gerarResumoNegociacao, compararPorItem,
         montarPedidoOtimizado, montarPedidoFornecedorUnico, montarPedidoManual } from '../agents/consolidator.js'
import { resolverCotacaoAutomatica, salvarPropostasAutomaticas } from '../agents/auto_quote.js'
import { upsertCatalogoEmLote, salvarPromocao } from '../db/catalogo.js'
import { sendText, sendButtons, sendTextOrTemplate, downloadMedia, normalizeMetaPayload,
         templateCotacaoParaRep, templateComparativo, templatePedidoConfirmado } from '../services/whatsapp.js'
import * as XLSX from 'xlsx'
import { handleAutocadastro, getSessaoOnboarding, handleOnboardingComerciantge, getSessaoOnboardingComerciantge, handleConvidarFornecedor, iniciarOnboardingRepPorConvite } from './onboarding.js'
import { criarVinculo, removerVinculo, getRepresentantesVinculados, getComerciantesVinculados,
         findRepByCodigoConvite, gerarCodigoConvite } from '../db/vinculos.js'
import 'dotenv/config'

// ── Normalização de número brasileiro (8 vs 9 dígitos) ───────────────
// A Meta às vezes entrega/armazena o número sem o 9 do celular.
function telefoneCandidatos(tel) {
  const digits = (tel ?? '').replace(/\D/g, '')
  const set = new Set([digits])
  if (digits.startsWith('55') && digits.length === 13) {
    set.add('55' + digits.slice(2, 4) + digits.slice(5))
  }
  if (digits.startsWith('55') && digits.length === 12) {
    set.add('55' + digits.slice(2, 4) + '9' + digits.slice(4))
  }
  return [...set]
}

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

// ── Helper: extrai telefones de texto livre no webhook ────────────────
// Mesmo algoritmo do onboarding — sempre com código 55

function extrairTelefonesWebhook(texto) {
  const partes = texto.split(/[\n,;]+/)
  const validos = [], invalidos = []
  for (const parte of partes) {
    const digits = parte.trim().replace(/\D/g, '')
    if (!digits) continue
    if (digits.length >= 7 && digits.length <= 9) { invalidos.push(parte.trim()); continue }
    if (digits.length < 10) continue
    let tel = digits
    if (tel.startsWith('55') && tel.length >= 12) { /* ok */ }
    else if (tel.length >= 10 && tel.length <= 11) tel = '55' + tel
    else continue
    validos.push(tel)
  }
  return { validos: [...new Set(validos)], invalidos }
}

// ── Deduplicação de webhooks ──────────────────────────────────────────
// Meta Cloud API pode entregar o mesmo webhook 2x em rápida sucessão.
// Guarda messageIds processados por 60s para descartar duplicatas.

const _mensagensProcessadas = new Map() // messageId → timestamp

function jaProcessada(messageId) {
  if (!messageId) return false
  const agora = Date.now()
  for (const [id, ts] of _mensagensProcessadas) {
    if (agora - ts > 60_000) _mensagensProcessadas.delete(id)
  }
  if (_mensagensProcessadas.has(messageId)) return true
  _mensagensProcessadas.set(messageId, agora)
  return false
}

// ── Lock por cotação ──────────────────────────────────────────────────
// Previne race condition quando dois webhooks chegam com ms de diferença
// e ambos leem obs_interna antes de qualquer um terminar o update no banco.

const _cotacoesEmProcessamento = new Set()

function lockCotacao(cotacaoId) {
  if (_cotacoesEmProcessamento.has(cotacaoId)) return false
  _cotacoesEmProcessamento.add(cotacaoId)
  setTimeout(() => _cotacoesEmProcessamento.delete(cotacaoId), 10_000)
  return true
}

function unlockCotacao(cotacaoId) {
  _cotacoesEmProcessamento.delete(cotacaoId)
}

// ── Navegação no histórico de cotações ───────────────────────────────
const _estadosHistorico = new Map() // phone → { cotacoes: [id,...], expiresAt }

function setEstadoHistorico(phone, cotacoes) {
  _estadosHistorico.set(phone, { cotacoes, expiresAt: Date.now() + 5 * 60_000 })
}
function getEstadoHistorico(phone) {
  const h = _estadosHistorico.get(phone)
  if (!h) return null
  if (Date.now() > h.expiresAt) { _estadosHistorico.delete(phone); return null }
  return h
}

// ── Aguardando confirmação de salvar catálogo (após resposta manual) ──
const _pendenteCatalogo = new Map() // phone → { message, expiresAt }

function setPendenteCatalogo(phone, message) {
  _pendenteCatalogo.set(phone, { message, expiresAt: Date.now() + 5 * 60_000 })
}
function getPendenteCatalogo(phone) {
  const p = _pendenteCatalogo.get(phone)
  if (!p) return null
  if (Date.now() > p.expiresAt) { _pendenteCatalogo.delete(phone); return null }
  return p
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
  // null = onboarding concluiu e a mensagem deve continuar no fluxo de cotação
  const sessaoAtiva = await getSessaoOnboarding(phone)
  if (sessaoAtiva) {
    const resultado = await handleAutocadastro(phone, message)
    if (resultado !== null) return resultado
  }

  // 2. Resposta ao template de convite — SEMPRE verifica convite pendente primeiro
  // (independente de o número já ter outro cadastro)
  const msgLower = (message ?? '').trim().toLowerCase()
  if (msgLower === 'confirmar' || msgLower === 'sim' || msgLower === 'ok') {
    const candidatos = telefoneCandidatos(phone)
    const { data: convitePendente } = await supabase
      .from('convites_pendentes')
      .select('id, comerciante_id')
      .in('telefone_fornecedor', candidatos)
      .eq('aceito', false)
      .order('criado_em', { ascending: false })
      .limit(1)
      .single()

    if (convitePendente) {
      // Tem convite pendente — inicia onboarding de representante
      return iniciarOnboardingRepPorConvite(phone)
    }
  }

  // 3. Keyword de cadastro direto
  if (msgLower === 'cadastro' || msgLower === 'cadastrar') {
    return handleAutocadastro(phone, message)
  }

  // 3. Rota normal: representante ou comerciante
  const rep = await findRepresentanteByTelefone(phone)
  if (rep) {
    return handleMensagemRepresentante({ rep, message, type, mediaId, mimeType })
  }

  // 4. Verifica onboarding do comerciante em andamento
  const sessaoComerciantge = await getSessaoOnboardingComerciantge(phone)
  if (sessaoComerciantge) {
    const resultadoOnboarding = await handleOnboardingComerciantge(phone, message)
    // null = onboarding concluiu nesta mensagem (ex: lista em cadastrando_fornecedores)
    // nao descarta: continua para processar a mensagem normalmente
    if (resultadoOnboarding !== null) return resultadoOnboarding
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

  // 6. Número desconhecido — inicia seleção de perfil sem criar comerciante prematuramente
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
    const comerGreet = await findOrCreateComercianteByTelefone(phone)
    const primeiroNome = (comerGreet?.nome ?? '').split(' ')[0]
    await sendText(phone, [
      primeiroNome ? `Olá, *${primeiroNome}*!` : 'Olá!',
      '',
      'Envie sua lista de produtos para iniciar uma cotação.',
      '',
      'Exemplo:',
      '_2cx Coca-Cola 2L_',
      '_10fd Arroz Urbano 5kg_',
      '',
      'Outros comandos: *minha cotação* · *meus fornecedores* · *histórico*',
    ].join('\n'))
    return { ok: true }
  }

  const comerciante = await findOrCreateComercianteByTelefone(phone)

  // ── Estado transiente: aguardando telefone do fornecedor ─────────────
  const estadoAtual = getEstadoVinculo(phone)
  if (estadoAtual?.acao === 'aguardando_telefone_fornecedor' && type === 'texto') {
    if (cmd === 'cancelar') {
      clearEstadoVinculo(phone)
      await sendText(phone, 'Ok, cancelado.')
      return { ok: true }
    }
    const { validos, invalidos } = extrairTelefonesWebhook(message.trim())
    if (invalidos.length > 0 && validos.length === 0) {
      await sendText(phone, [
        'Número(s) incompleto(s) — parece que está faltando o DDD.',
        '',
        ...invalidos.map(n => `• ${n} ← faltando DDD`),
        '',
        'Envie com DDD + número. Ex: _47 99272878_',
      ].join('\n'))
      return { ok: true }
    }
    if (!validos.length) {
      await sendText(phone, 'Número inválido. Envie o WhatsApp do fornecedor.\n\nEx: _47999990001_')
      return { ok: true }
    }
    clearEstadoVinculo(phone)
    const emLote = validos.length > 1
    if (emLote) await sendText(phone, `Processando ${validos.length} contato(s)...`)
    for (const tel of validos) {
      await handleConvidarFornecedor(phone, tel, { silencioso: emLote })
    }
    if (emLote) await sendText(phone, `${validos.length} fornecedor(es) adicionado(s).`)
    return { ok: true }
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

  // Adicionar fornecedor por número direto: "adicionar fornecedor 47999990001"
  const matchAddFornecedor = cmd.match(/^(?:adicionar|novo|add)\s+fornecedor\s+([\d\s]+)$/)
  if (matchAddFornecedor) {
    const { validos } = extrairTelefonesWebhook(matchAddFornecedor[1])
    if (validos.length) {
      for (const tel of validos) await handleConvidarFornecedor(phone, tel)
      return { ok: true }
    }
  }

  // Iniciar fluxo de adicionar fornecedor (sem número na mensagem)
  if (cmd === 'adicionar fornecedor' || cmd === 'novo fornecedor' || cmd === 'add fornecedor') {
    setEstadoVinculo(phone, 'aguardando_telefone_fornecedor')
    await sendText(phone, [
      'Envie o número de WhatsApp do fornecedor.',
      '',
      'Pode enviar vários de uma vez, um por linha.',
      '',
      'Ex:',
      '_47999990001_',
      '_11988880002_',
    ].join('\n'))
    return { ok: true }
  }

  // Estado: aguardando número após "adicionar fornecedor"
  // (já tratado no topo pelo getEstadoVinculo)

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
      .in('status', ['aguardando_respostas', 'aguardando_escolha', 'aguardando_modo_fechamento', 'escolha_item_a_item', 'consulta'])
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

  // ── Navegação no histórico: usuário digitou número após ver a lista ──
  const estadoHistorico = getEstadoHistorico(phone)
  if (estadoHistorico && type === 'texto') {
    const num = parseInt(cmd)
    if (!isNaN(num) && num >= 1 && num <= estadoHistorico.cotacoes.length) {
      _estadosHistorico.delete(phone)
      return handleHistoricoDetalhe(estadoHistorico.cotacoes[num - 1], phone)
    }
    // Número inválido ou outro comando — limpa o estado e continua o fluxo normal
    _estadosHistorico.delete(phone)
  }

  // ── Cotação aguardando confirmação da lista ───────────────────────
  const { data: cotacaoConfirmando } = await supabase
    .from('cotacoes')
    .select('*, cotacao_itens(*)')
    .eq('comerciante_id', comerciante.id)
    .eq('status', 'aguardando_respostas')
    .eq('obs_interna', 'aguardando_confirmacao_lista')
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  if (cotacaoConfirmando && message) {
    if (cmd === '1' || cmd === 'sim' || cmd === 'seguir' || cmd === 'confirmar') {
      // Confirma — classifica setores e dispara cotação
      await supabase.from('cotacoes')
        .update({ obs_interna: null })
        .eq('id', cotacaoConfirmando.id)

      const itensDaCotacao = cotacaoConfirmando.cotacao_itens ?? []
      try {
        const setores = await classificarSetores(itensDaCotacao)
        await Promise.all(itensDaCotacao.map((it, i) =>
          supabase.from('cotacao_itens').update({ setor: setores[i] }).eq('id', it.id)
        ))
      } catch (err) {
        console.warn('[webhook] erro ao classificar setores:', err.message)
      }

      await sendText(phone, 'Verificando catálogos dos representantes...')
      await dispararCotacao(cotacaoConfirmando, comerciante)
      return { ok: true }
    }
    if (cmd === '2' || cmd === 'cancelar' || cmd === 'nova lista' || cmd === 'ajustar') {
      // Cancela cotação e pede nova lista
      await supabase.from('cotacoes')
        .update({ status: 'cancelada', obs_interna: null, fechado_em: new Date().toISOString() })
        .eq('id', cotacaoConfirmando.id)
      await sendText(phone, 'Tudo bem! Pode me enviar a lista corrigida quando quiser.')
      return { ok: true }
    }
    // Mensagem parece uma nova lista — cancela pendente e processa a nova
    const pareceNovaLista = (message ?? '').length > 15 || (message ?? '').includes('\n')
    if (pareceNovaLista) {
      await supabase.from('cotacoes')
        .update({ status: 'cancelada', obs_interna: null, fechado_em: new Date().toISOString() })
        .eq('id', cotacaoConfirmando.id)
      return handleMensagemComerciantge({ phone, message, type, mediaId, mimeType })
    }

    // Resposta curta não reconhecida — mostra itens pendentes e repete pergunta
    const itensPendentes = cotacaoConfirmando.cotacao_itens ?? []
    const linhasPendentes = itensPendentes.map((it, i) => {
      const marca = it.marca ? ` (${it.marca})` : ''
      const un = it.unidade ? ` – ${it.unidade}` : ''
      return `${i + 1}. ${it.produto}${marca}${un} × ${it.quantidade ?? 1}`
    })
    await sendText(phone, [
      `*Sua lista — ${itensPendentes.length} produto(s):*`,
      '',
      ...linhasPendentes,
      '',
      '1. Confirmar e cotar',
      '2. Cancelar e enviar nova lista',
    ].join('\n'))
    return { ok: true }
  }

  // ── Cotação aguardando escolha do modo de fechamento ou loop item a item ──
  const { data: cotacaoFechamento } = await supabase
    .from('cotacoes')
    .select('*')
    .eq('comerciante_id', comerciante.id)
    .in('status', ['aguardando_modo_fechamento', 'escolha_item_a_item'])
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  if (cotacaoFechamento && message) {
    // Lock por cotação — descarta segundo request paralelo
    if (!lockCotacao(cotacaoFechamento.id)) {
      console.log(`[webhook] cotação ${cotacaoFechamento.id} em processamento — descartando request paralelo`)
      return { ok: true, skipped: true, reason: 'cotacao_locked' }
    }
    try {
      if (cotacaoFechamento.status === 'escolha_item_a_item') {
        return await handleEscolhaItemAItem({ comerciante, cotacao: cotacaoFechamento, message, phone })
      }
      return await handleModoFechamento({ comerciante, cotacao: cotacaoFechamento, message, phone })
    } finally {
      unlockCotacao(cotacaoFechamento.id)
    }
  }

  // ── Cotação aguardando escolha (modo compra) — fluxo legado ───────
  const { data: cotacaoAguardandoEscolha } = await supabase
    .from('cotacoes')
    .select('*')
    .eq('comerciante_id', comerciante.id)
    .eq('status', 'aguardando_escolha')
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  if (cotacaoAguardandoEscolha && message) {

    // Lock por cotação — descarta segundo request que chegou em paralelo
    if (!lockCotacao(cotacaoAguardandoEscolha.id)) {
      console.log(`[webhook] cotação ${cotacaoAguardandoEscolha.id} em processamento — descartando request paralelo`)
      return { ok: true, skipped: true, reason: 'cotacao_locked' }
    }

    try {

    // ── Passo 2: intenção já confirmada → usuário está escolhendo fornecedor ──
    if (cotacaoAguardandoEscolha.obs_interna === 'confirmando:comprar') {
      if (cmd === '0' || cmd === 'voltar' || cmd === 'voltar ao comparativo') {
        await supabase.from('cotacoes')
          .update({ obs_interna: null })
          .eq('id', cotacaoAguardandoEscolha.id)
        return handleReenviarComparativo(comerciante, cotacaoAguardandoEscolha, phone)
      }
      if (cmd === 'nova cotacao' || cmd === 'nova cotação' || cmd === 'descartar' || cmd === 'cancelar') {
        return handleCancelarParaNovaCotacao(comerciante, cotacaoAguardandoEscolha, phone)
      }
      if (/^\d+$/.test(cmd) || cmd.length > 3) {
        return handleEscolhaFornecedor({ comerciante, cotacao: cotacaoAguardandoEscolha, resposta: message })
      }
      return handlePedirEscolhaFornecedor(comerciante, cotacaoAguardandoEscolha, phone)
    }

    // ── Passo 1: resposta de intenção (1 / 2 / 3) ────────────────────────────
    if (cmd === '1' || cmd === 'comprar' || cmd === 'comprar agora') {
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
    if (/^\d+$/.test(cmd) || cmd.length > 3) {
      return handleEscolhaFornecedor({ comerciante, cotacao: cotacaoAguardandoEscolha, resposta: message })
    }
    } finally {
      unlockCotacao(cotacaoAguardandoEscolha.id)
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
        .update({ status: 'aguardando_modo_fechamento', obs_interna: null })
        .eq('id', cotacaoConsulta.id)
      return handleReenviarComparativo(comerciante, cotacaoConsulta, phone)
    }
  }

  // ── Nova lista com cotação pendente ──────────────────────────────
  let { data: cotacaoPendente } = await supabase
    .from('cotacoes')
    .select('*')
    .eq('comerciante_id', comerciante.id)
    .in('status', ['aguardando_respostas', 'aguardando_escolha', 'aguardando_modo_fechamento', 'escolha_item_a_item', 'consulta'])
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  // ── Resposta ao aviso "1 = ver / 2 = nova cotação" ───────────────
  if (cotacaoPendente?.obs_interna?.startsWith('pendente_msg:')) {
    const listaSalva = cotacaoPendente.obs_interna.slice('pendente_msg:'.length)

    if (cmd === '1') {
      await supabase.from('cotacoes').update({ obs_interna: null }).eq('id', cotacaoPendente.id)
      return handleVerCotacaoAtual(comerciante, phone)
    }

    // cmd === '2' ou o usuário enviou uma nova lista diretamente
    await supabase.from('cotacoes')
      .update({ status: 'cancelada', obs_interna: null, fechado_em: new Date().toISOString() })
      .eq('id', cotacaoPendente.id)
    cotacaoPendente = null

    if (cmd !== '2' && (message?.length > 10 || mediaId)) {
      // Nova lista enviada diretamente — cai para extração abaixo
    } else {
      // Resposta "2" — reprocessa a lista salva automaticamente
      const eraMidia = listaSalva.startsWith('[') && listaSalva.endsWith(']')
      if (eraMidia) {
        await sendText(phone, 'Cotação anterior cancelada! Reenvie sua lista de produtos.')
        return { ok: true }
      }
      return handleMensagemComerciantge({ phone, message: listaSalva, type: 'texto', mediaId: null, mimeType: null })
    }
  }

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
    await supabase.from('cotacoes').update({
      obs_interna: `pendente_msg:${message ?? `[${type}]`}`
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
    console.error('[webhook] erro ao extrair lista:', err.message, err.stack)
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
    await sendText(phone, 'Não encontrei nenhum produto. Pode tentar novamente?')
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

  // Envia última mensagem com rodapé de confirmação
  const rodape = [
    temSugestoes ? '_Quantidades com (sugestão) são baseadas no seu histórico._' : '',
    '',
    'Essa é a sua lista. Deseja seguir com essa cotação ou prefere ajustar algo?',
    '',
    '1. Seguir com essa lista',
    '2. Cancelar e enviar uma nova lista',
  ].filter(l => l !== '').join('\n')

  const ultimoBloco = blocosMensagem.length > 1 ? blocosMensagem[blocosMensagem.length - 1] : ''
  if (ultimoBloco) {
    await sendText(phone, ultimoBloco + '\n\n' + rodape)
  } else {
    await sendText(phone, rodape)
  }

  // Salva cotação em estado aguardando confirmação antes de disparar
  await supabase.from('cotacoes')
    .update({ obs_interna: 'aguardando_confirmacao_lista' })
    .eq('id', cotacao.id)

  return { ok: true }

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
      const n = repsAutomaticos.length
      msgs.push(n === 1
        ? '1 fornecedor com catálogo respondeu automaticamente'
        : `${n} fornecedores com catálogo responderam automaticamente`)
    }
    if (repsManuais.length) {
      const n = repsManuais.length
      msgs.push(n === 1
        ? '1 fornecedor sem catálogo será consultado via WhatsApp'
        : `${n} fornecedores sem catálogo serão consultados via WhatsApp`)
      await dispararParaRepsManuais(cotacao, itens, repsManuais)
    }
    msgs.push(``, `Consolidarei as respostas em até ${TIMEOUT_HORAS}h.`)
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

  // Se há cotação pendente aguardando resposta deste rep, trata como resposta de cotação
  // independente do conteúdo — evita que listas de preços sejam classificadas como catálogo
  if (type === 'texto' || ['planilha', 'pdf', 'foto'].includes(type)) {
    const envioPendente = await getCotacaoPendentePorTelefone(rep.telefone)
    if (envioPendente) {
      return handleRespostaCotacao({ rep, message, type, mediaId, mimeType })
    }
  }

  // Verifica se rep confirmou salvar catálogo após resposta manual
  if (type === 'texto') {
    const pendente = getPendenteCatalogo(rep.telefone)
    if (pendente) {
      _pendenteCatalogo.delete(rep.telefone)
      if (cmd === 'sim' || cmd === 'salvar' || cmd === 'sim, salvar' || cmd === 's' || cmd === 'catalogo_sim') {
        return handleAtualizacaoCatalogo({ rep, message: pendente.message, type: 'texto', mediaId: null, mimeType: null })
      }
      await sendText(rep.telefone, 'Ok! Os preços não foram salvos no catálogo.')
      return { ok: true }
    }
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
        const seta = al.subiu ? '(+)' : '(-)'
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
        const seta = al.subiu ? '(+)' : '(-)'
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
  await sendText(rep.telefone, 'Recebi sua promoção! Processando...')

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

// Encontra o item original da cotação que melhor corresponde ao nome retornado pela IA.
// Usa pontuação por sobreposição de tokens para lidar com nomes abreviados do representante.
function encontrarItemOriginal(itens, nomeProduto) {
  const norm = s => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim()
  const normResp = norm(nomeProduto)
  // Tenta match exato primeiro
  const exato = itens.find(i => norm(i.produto) === normResp)
  if (exato) return exato
  // Pontuação por sobreposição de tokens
  const palavras = normResp.split(' ').filter(w => w.length > 1)
  if (!palavras.length) return null
  let melhor = null, melhorScore = -Infinity
  for (const it of itens) {
    const nItem = norm(it.produto)
    const hits = palavras.filter(w => nItem.includes(w)).length
    const palavrasItem = nItem.split(' ').filter(w => w.length > 1)
    // Penaliza palavras extra no item que não aparecem na resposta (itens mais específicos ficam acima)
    const extras = palavrasItem.filter(w => !palavras.includes(w)).length
    const score = hits * 10 - extras
    if (score > melhorScore) { melhorScore = score; melhor = it }
  }
  return melhorScore > 0 ? melhor : null
}

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
    const orig = encontrarItemOriginal(itens, it.produto)
    return {
      cotacao_envio_id:     envio.id,
      cotacao_id:           cotacaoId,
      representante_id:     rep.id,
      cotacao_item_id:      orig?.id ?? null,
      produto:              orig?.produto ?? it.produto,
      preco_unitario:       it.preco_unitario,
      preco_total:          it.preco_unitario != null && orig?.quantidade ? it.preco_unitario * orig.quantidade : null,
      prazo_pagamento_dias: it.prazo_pagamento_dias ?? prazoPg ?? rep.prazo_pagamento_padrao_dias ?? null,
      prazo_entrega_dias:   it.prazo_entrega_dias ?? prazoEn ?? rep.prazo_entrega_padrao_dias ?? null,
      resposta_raw:         message,
      origem:               'manual',
    }
  })

  await supabase.from('propostas').insert(propostasParaInserir)
  await supabase.from('cotacao_envios')
    .update({ status: 'respondido', modo_resposta: 'manual', respondido_em: new Date().toISOString() })
    .eq('id', envio.id)

  await sendButtons(
    rep.telefone,
    'Proposta recebida! Obrigado. Se você for escolhido, o pedido chegará em seguida.\n\nQuer salvar esses preços no seu catálogo para que futuras cotações sejam respondidas automaticamente?',
    [
      { id: 'catalogo_sim', label: 'Sim' },
      { id: 'catalogo_nao', label: 'Não' },
    ]
  )

  setPendenteCatalogo(rep.telefone, message)

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
  if (!lockCotacao(cotacaoId)) {
    console.log(`[consolidarEEnviar] cotação ${cotacaoId} já em processamento — ignorando`)
    return
  }
  try {
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

    await supabase.from('cotacoes').update({ status: 'aguardando_modo_fechamento', obs_interna: null }).eq('id', cotacaoId)

    // Feature 3: gera resumo em linguagem natural com trade-offs
    const resumo = await gerarResumoNegociacao(consolidado)

    const comparacao = compararPorItem(itens, propostas)
    const msgComparativo = templateComparativoPorItem(comparacao, cotacaoId, resumo)
    await sendText(cotacao.comerciantes.telefone, msgComparativo)
  } finally {
    unlockCotacao(cotacaoId)
  }
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
    `Pedido #${pedido.id.slice(-6).toUpperCase()} · Cotação #${cotacao.id.slice(-6).toUpperCase()}`,
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
    `*Pedido #${pedido.id.slice(-6).toUpperCase()} recebido!*`,
    `Cotação #${cotacao.id.slice(-6).toUpperCase()}`, '',
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
    .in('status', ['aguardando_respostas', 'aguardando_escolha', 'aguardando_modo_fechamento', 'escolha_item_a_item', 'consulta', 'pedido_gerado'])
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  if (!cotacao) {
    await sendText(phone, 'Você não tem nenhuma cotação em aberto no momento.\n\nEnvie uma lista de produtos para iniciar uma nova cotação.')
    return { ok: true }
  }

  const statusMsg = {
    aguardando_respostas:       'Aguardando respostas dos fornecedores',
    aguardando_escolha:         'Comparativo pronto — aguardando sua escolha',
    aguardando_modo_fechamento: 'Comparativo pronto — escolha como fechar',
    escolha_item_a_item:        'Escolhendo fornecedor item a item',
    consulta:                   'Salva para consulta',
    pedido_gerado:              'Pedido gerado',
  }[cotacao.status] ?? cotacao.status

  const itensCotacao = await supabase.from('cotacao_itens').select('*').eq('cotacao_id', cotacao.id).order('ordem')

  const itensStr = (itensCotacao.data ?? []).map((it, i) =>
    `${i+1}. ${it.produto}${it.marca ? ` (${it.marca})` : ''} × ${it.quantidade ?? 1}`
  ).join('\n')

  const linhas = [
    `*Cotação #${cotacao.id.slice(-6).toUpperCase()}*`,
    `Status: ${statusMsg}`,
    `Data: ${new Date(cotacao.criado_em).toLocaleDateString('pt-BR')}`,
    '',
    '*Itens:*',
    itensStr,
  ]

  if (cotacao.status === 'pedido_gerado') {
    const { data: pedidos } = await supabase
      .from('pedidos')
      .select('id, valor_total, representantes(nome)')
      .eq('cotacao_id', cotacao.id)
    if (pedidos?.length) {
      linhas.push('', '*Pedidos gerados:*')
      for (const p of pedidos) {
        linhas.push(`  Pedido #${p.id.slice(-6).toUpperCase()} — ${p.representantes?.nome ?? '?'} — R$ ${p.valor_total?.toFixed(2)}`)
      }
    }
  } else {
    linhas.push('',
      cotacao.status === 'aguardando_escolha' ? 'Envie *comprar* para ver o comparativo e fechar o pedido.' :
      cotacao.status === 'aguardando_modo_fechamento' ? 'Responda *1*, *2*, *3* ou *4* para escolher como fechar o pedido.' :
      cotacao.status === 'escolha_item_a_item' ? 'Continue escolhendo o fornecedor de cada item.' :
      cotacao.status === 'consulta' ? 'Envie *comprar* para retomar e fechar o pedido.' :
      'Aguarde as respostas dos fornecedores.'
    )
  }

  await sendText(phone, linhas.join('\n'))

  return { ok: true }
}

// ── Cancelar cotação ──────────────────────────────────────────────────
async function handleCancelarCotacao(comerciante, phone) {
  const { data: cotacao } = await supabase
    .from('cotacoes')
    .select('*')
    .eq('comerciante_id', comerciante.id)
    .in('status', ['aguardando_respostas', 'aguardando_escolha', 'aguardando_modo_fechamento', 'escolha_item_a_item', 'consulta'])
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
    .select('id, status, criado_em, cotacao_itens(id)')
    .eq('comerciante_id', comerciante.id)
    .order('criado_em', { ascending: false })
    .limit(5)

  if (!cotacoes?.length) {
    await sendText(phone, 'Você ainda não fez nenhuma cotação.')
    return { ok: true }
  }

  const statusLabel = {
    pedido_gerado:              'Pedido gerado',
    aguardando_escolha:         'Aguardando sua escolha',
    aguardando_modo_fechamento: 'Aguardando fechamento',
    escolha_item_a_item:        'Em fechamento',
    aguardando_respostas:       'Aguardando respostas',
    consulta:                   'Salvo sem pedido',
    cancelada:                  'Cancelada',
  }

  const idsPedido = cotacoes.filter(c => c.status === 'pedido_gerado').map(c => c.id)
  let pedidosPorCotacao = {}
  if (idsPedido.length) {
    const { data: pedidos } = await supabase
      .from('pedidos')
      .select('id, cotacao_id, valor_total, representantes(nome)')
      .in('cotacao_id', idsPedido)
    for (const p of pedidos ?? []) {
      if (!pedidosPorCotacao[p.cotacao_id]) pedidosPorCotacao[p.cotacao_id] = []
      pedidosPorCotacao[p.cotacao_id].push({
        id: p.id.slice(-6).toUpperCase(), valor: p.valor_total, rep: p.representantes?.nome ?? null,
      })
    }
  }

  const linhas = ['*Suas cotações:*', '']
  const ids = []
  cotacoes.forEach((c, i) => {
    ids.push(c.id)
    const label  = statusLabel[c.status] ?? c.status
    const data   = new Date(c.criado_em).toLocaleDateString('pt-BR')
    const nItens = (c.cotacao_itens ?? []).length
    const pedidos = pedidosPorCotacao[c.id]

    let linha = `${i + 1}. #${c.id.slice(-6).toUpperCase()} · ${data} · ${label} · ${nItens} item${nItens !== 1 ? 'ns' : ''}`
    if (pedidos?.length) {
      const total = pedidos.reduce((s, p) => s + (p.valor ?? 0), 0)
      linha += ` · R$ ${total.toFixed(2)}`
    }
    linhas.push(linha)
  })

  linhas.push('')
  linhas.push(`Digite o número para ver os detalhes (ex: *1*).`)

  setEstadoHistorico(phone, ids)
  await sendText(phone, linhas.join('\n'))
  return { ok: true }
}

async function handleHistoricoDetalhe(cotacaoId, phone) {
  const { cotacao, itens } = await getCotacaoComItens(cotacaoId)
  if (!cotacao) {
    await sendText(phone, 'Cotação não encontrada.')
    return { ok: true }
  }

  const statusLabel = {
    pedido_gerado:              'Pedido gerado',
    aguardando_escolha:         'Aguardando sua escolha',
    aguardando_modo_fechamento: 'Aguardando fechamento',
    escolha_item_a_item:        'Em fechamento',
    aguardando_respostas:       'Aguardando respostas dos fornecedores',
    consulta:                   'Salvo sem pedido',
    cancelada:                  'Cancelada',
  }

  const label = statusLabel[cotacao.status] ?? cotacao.status
  const data  = new Date(cotacao.criado_em).toLocaleDateString('pt-BR')

  const linhas = [
    `*Cotação #${cotacaoId.slice(-6).toUpperCase()} · ${data}*`,
    `Status: ${label}`,
    '',
  ]

  if (cotacao.status === 'pedido_gerado') {
    const { data: pedidos } = await supabase
      .from('pedidos')
      .select('id, valor_total, representantes(nome), pedido_itens(produto, quantidade, preco_unitario)')
      .eq('cotacao_id', cotacaoId)

    for (const p of pedidos ?? []) {
      linhas.push(`*${p.representantes?.nome ?? 'Fornecedor'}* — Pedido #${p.id.slice(-6).toUpperCase()}`)
      for (const it of p.pedido_itens ?? []) {
        linhas.push(`  ${it.produto} × ${it.quantidade ?? 1} — R$ ${it.preco_unitario?.toFixed(2)}`)
      }
      if (p.valor_total) linhas.push(`  _Total: R$ ${p.valor_total.toFixed(2)}_`)
      linhas.push('')
    }
  } else {
    linhas.push('*Itens:*')
    for (const it of itens) {
      const qtd = it.quantidade ? ` × ${it.quantidade}` : ''
      linhas.push(`  ${it.produto}${qtd}`)
    }
    linhas.push('')

    const statusAbertos = ['aguardando_respostas', 'aguardando_escolha', 'aguardando_modo_fechamento', 'escolha_item_a_item']
    if (statusAbertos.includes(cotacao.status)) {
      linhas.push('Envie *minha cotação* para retomar.')
    }
  }

  await sendText(phone, linhas.join('\n'))
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

// ── Disparar cotação após confirmação da lista ────────────────────────

async function dispararCotacao(cotacao, comerciante) {
  const itens = cotacao.cotacao_itens ?? []
  const phone = comerciante.telefone

  const { repsAutomaticos, repsManuais, itensSemCobertura, modo } =
    await resolverCotacaoAutomatica(cotacao.id, itens, comerciante.id)

  for (const { rep, propostas } of repsAutomaticos) {
    await salvarPropostasAutomaticas(cotacao.id, rep.id, propostas)
  }

  if (modo === 'automatico') {
    await sendText(phone, 'Todos os fornecedores têm catálogo atualizado. Comparativo pronto em segundos!')
    await consolidarEEnviar(cotacao.id)
  } else {
    const msgs = ['Consultando fornecedores:']
    if (repsAutomaticos.length) {
      const na = repsAutomaticos.length
      msgs.push(na === 1
        ? '1 fornecedor com catálogo respondeu automaticamente'
        : `${na} fornecedores com catálogo responderam automaticamente`)
    }
    if (repsManuais.length) {
      const nm = repsManuais.length
      msgs.push(nm === 1
        ? '1 fornecedor sem catálogo será consultado via WhatsApp'
        : `${nm} fornecedores sem catálogo serão consultados via WhatsApp`)
      await dispararParaRepsManuais(cotacao, itens, repsManuais)
    }
    await sendText(phone, msgs.join('\n'))
  }
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

  // Garante que voltamos ao estado de escolha de modo, sem sub-estado pendente
  await supabase.from('cotacoes')
    .update({ status: 'aguardando_modo_fechamento', obs_interna: null })
    .eq('id', cotacao.id)

  const comparacao = compararPorItem(itens, propostas)
  const msg = templateComparativoPorItem(comparacao, cotacao.id)
  await sendText(phone, msg)
  return { ok: true }
}

// ── ENTREGÁVEL: escolha de fechamento pelo comerciante ────────────────
// Após o comparativo, o comerciante escolhe COMO fechar:
//   1 split_auto       → melhor fornecedor por item (pode gerar N pedidos)
//   2 fornecedor_unico → tudo com o melhor no geral (sistema escolhe)
//   3 fornecedor_unico → tudo com um único rep escolhido por ele
//   4 manual           → escolhe o fornecedor item a item (loop)

async function handleModoFechamento({ comerciante, cotacao, message, phone }) {
  const cmd = (message ?? '').trim().toLowerCase()
  const obs = cotacao.obs_interna ?? ''

  // Comandos auxiliares disponíveis a qualquer momento
  if (cmd === 'consulta' || cmd === 'so consulta' || cmd === 'só consulta') {
    await supabase.from('cotacoes').update({ status: 'consulta', obs_interna: null }).eq('id', cotacao.id)
    await sendText(phone, [
      'Beleza! Salvei sua cotação para consulta.',
      'Envie *comprar* quando quiser fechar o pedido.',
    ].join('\n'))
    return { ok: true }
  }
  if (cmd === 'descartar' || cmd === 'nova cotacao' || cmd === 'nova cotação' || cmd === 'cancelar') {
    return handleCancelarParaNovaCotacao(comerciante, cotacao, phone)
  }

  // ── Sub-estado: confirmando um pedido já montado (split ou único) ──
  if (obs.startsWith('confirmando:')) {
    if (cmd === '0' || cmd === 'voltar') {
      return handleReenviarComparativo(comerciante, cotacao, phone)
    }
    if (cmd === '1' || cmd === 'sim' || cmd === 'confirmar' || cmd === 'confirmo') {
      const { itens } = await getCotacaoComItens(cotacao.id)
      const propostas = await getPropostasDaCotacao(cotacao.id)
      let resultado, modo
      if (obs === 'confirmando:split_auto') {
        resultado = montarPedidoOtimizado(itens, propostas)
        modo = 'split_auto'
      } else {
        const repId = obs.split(':')[2]
        resultado = montarPedidoFornecedorUnico(itens, propostas, repId)
        modo = 'fornecedor_unico'
      }
      return finalizarPedidos({ comerciante, cotacao, resultado, modo, phone })
    }
    await sendText(phone, 'Responda *1* para confirmar ou *0* para voltar ao comparativo.')
    return { ok: true }
  }

  // ── Sub-estado: escolhendo qual é o fornecedor único (opção 3) ──
  if (obs === 'escolhendo:fornecedor_unico') {
    if (cmd === '0' || cmd === 'voltar') {
      return handleReenviarComparativo(comerciante, cotacao, phone)
    }
    const { itens } = await getCotacaoComItens(cotacao.id)
    const propostas = await getPropostasDaCotacao(cotacao.id)
    const consolidado = consolidarPropostas(itens, propostas)
    const reps = consolidado?.rankingFornecedores ?? []
    let rep = null
    const n = parseInt(cmd)
    if (!isNaN(n) && n >= 1 && n <= reps.length) rep = reps[n - 1]
    else rep = reps.find(r => cmd.includes(r.nome.toLowerCase()) || (r.empresa && cmd.includes(r.empresa.toLowerCase())))
    if (!rep) {
      await sendText(phone, 'Não entendi. Envie o *número* do fornecedor (ou *0* para voltar).')
      return { ok: true }
    }
    const resultado = montarPedidoFornecedorUnico(itens, propostas, rep.id)
    await supabase.from('cotacoes').update({ obs_interna: `confirmando:fornecedor_unico:${rep.id}` }).eq('id', cotacao.id)
    await sendText(phone, templateResumoPedido(resultado, cotacao.id, `Fornecedor único — ${rep.nome}`))
    return { ok: true }
  }

  // ── Escolha inicial do modo de fechamento ──
  if (cmd === '1') {
    const { itens } = await getCotacaoComItens(cotacao.id)
    const propostas = await getPropostasDaCotacao(cotacao.id)
    const resultado = montarPedidoOtimizado(itens, propostas)
    if (!resultado.grupos.length) {
      await sendText(phone, 'Não consegui montar o split — nenhuma proposta válida.')
      return { ok: true }
    }
    await supabase.from('cotacoes')
      .update({ obs_interna: 'confirmando:split_auto', modo_fechamento: 'split_auto' })
      .eq('id', cotacao.id)
    await sendText(phone, templateResumoPedido(resultado, cotacao.id, 'Split automático'))
    return { ok: true }
  }
  if (cmd === '2') {
    const { itens } = await getCotacaoComItens(cotacao.id)
    const propostas = await getPropostasDaCotacao(cotacao.id)
    const consolidado = consolidarPropostas(itens, propostas)
    const melhor = consolidado?.melhorFornecedor
    if (!melhor) {
      await sendText(phone, 'Ainda não há propostas para fechar.')
      return { ok: true }
    }
    const resultado = montarPedidoFornecedorUnico(itens, propostas, melhor.id)
    await supabase.from('cotacoes')
      .update({ obs_interna: `confirmando:fornecedor_unico:${melhor.id}`, modo_fechamento: 'fornecedor_unico' })
      .eq('id', cotacao.id)
    await sendText(phone, templateResumoPedido(resultado, cotacao.id, `Fornecedor único — ${melhor.nome} (melhor no geral)`))
    return { ok: true }
  }
  if (cmd === '3') {
    await supabase.from('cotacoes')
      .update({ obs_interna: 'escolhendo:fornecedor_unico', modo_fechamento: 'fornecedor_unico' })
      .eq('id', cotacao.id)
    return handlePedirEscolhaFornecedor(comerciante, cotacao, phone)
  }
  if (cmd === '4') {
    const { itens } = await getCotacaoComItens(cotacao.id)
    const propostas = await getPropostasDaCotacao(cotacao.id)
    const comparacao = compararPorItem(itens, propostas)
    const estado = { i: 0, escolhas: {} }
    await supabase.from('cotacoes')
      .update({ status: 'escolha_item_a_item', modo_fechamento: 'manual', obs_interna: `itemaitem:${JSON.stringify(estado)}` })
      .eq('id', cotacao.id)
    return avancarManual({ comerciante, cotacao, phone, comparacao, itens, propostas, estado })
  }

  // Não reconhecido — repete as opções
  await sendText(phone, templateOpcoesFechamento())
  return { ok: true }
}

// ── Gera os pedidos a partir dos grupos e notifica todos os envolvidos ──
async function finalizarPedidos({ comerciante, cotacao, resultado, modo, phone }) {
  if (!resultado.grupos.length) {
    await sendText(phone, 'Não há propostas para fechar o pedido.')
    return { ok: false }
  }

  const criados = []
  for (const grupo of resultado.grupos) {
    const { data: pedido } = await supabase.from('pedidos').insert({
      cotacao_id:           cotacao.id,
      comerciante_id:       comerciante.id,
      representante_id:     grupo.rep.id,
      valor_total:          grupo.subtotal,
      prazo_pagamento_dias: grupo.rep.prazo_pagamento_dias,
      prazo_entrega_dias:   grupo.rep.prazo_entrega_dias,
    }).select().single()

    await supabase.from('pedido_itens').insert(grupo.itens.map(it => ({
      pedido_id:      pedido.id,
      produto:        it.produto,
      marca:          it.marca,
      quantidade:     it.quantidade,
      preco_unitario: it.preco_unitario,
      preco_total:    it.preco_total,
    })))

    criados.push({ pedido, grupo })

    // Notifica o representante (falha não cancela o pedido)
    const resumoRep = grupo.itens.map(it => `• ${it.produto} ×${it.quantidade ?? 1} — R$ ${it.preco_total?.toFixed(2)}`).join('\n')
    try {
      await sendText(grupo.rep.telefone, [
        `*Pedido #${pedido.id.slice(-6).toUpperCase()} recebido!*`,
        `Cotação #${cotacao.id.slice(-6).toUpperCase()}`, '',
        `Cliente: ${comerciante.nome} (${comerciante.telefone})`, '',
        resumoRep, '',
        `*Total: R$ ${grupo.subtotal.toFixed(2)}*`,
        `Pagamento: ${grupo.rep.prazo_pagamento_dias ?? '?'}d | Entrega: ${grupo.rep.prazo_entrega_dias ?? '?'}d`,
      ].join('\n'))
    } catch (err) {
      console.warn(`[finalizarPedidos] falha ao notificar rep ${grupo.rep.id}:`, err.message)
    }
  }

  await supabase.from('cotacoes')
    .update({ status: 'pedido_gerado', modo_fechamento: modo, obs_interna: null, fechado_em: new Date().toISOString() })
    .eq('id', cotacao.id)

  // Resumo ao comerciante
  const linhas = []
  for (const { pedido, grupo } of criados) {
    linhas.push(`*${grupo.rep.nome}*${grupo.rep.empresa ? ` · ${grupo.rep.empresa}` : ''} — Pedido #${pedido.id.slice(-6).toUpperCase()}`)
    for (const it of grupo.itens) linhas.push(`  ${it.produto} ×${it.quantidade ?? 1} — R$ ${it.preco_total?.toFixed(2)}`)
    linhas.push(`  _Subtotal: R$ ${grupo.subtotal.toFixed(2)}_`)
    linhas.push('')
  }
  if (resultado.itensSemProposta?.length) {
    linhas.push(`_Sem proposta (não incluídos): ${resultado.itensSemProposta.join(', ')}_`)
    linhas.push('')
  }

  try {
    await sendText(phone, [
      criados.length > 1 ? `*${criados.length} pedidos gerados (split):*` : '*Pedido confirmado!*',
      `Cotação #${cotacao.id.slice(-6).toUpperCase()}`,
      '',
      ...linhas,
      `*Total geral: R$ ${resultado.valorTotal.toFixed(2)}*`,
      criados.length > 1 ? `${criados.length} fornecedores foram notificados.` : 'O fornecedor foi notificado.',
    ].join('\n'))
  } catch (err) {
    console.warn('[finalizarPedidos] falha ao notificar comerciante:', err.message)
  }

  return { ok: true, pedidos: criados.map(c => c.pedido.id), modo }
}

// ── Loop de escolha item a item (opção 4) ─────────────────────────────
async function handleEscolhaItemAItem({ comerciante, cotacao, message, phone }) {
  const cmd = (message ?? '').trim().toLowerCase()
  const obs = cotacao.obs_interna ?? ''

  if (cmd === 'descartar' || cmd === 'cancelar' || cmd === 'nova cotacao' || cmd === 'nova cotação') {
    return handleCancelarParaNovaCotacao(comerciante, cotacao, phone)
  }

  const { itens } = await getCotacaoComItens(cotacao.id)
  const propostas = await getPropostasDaCotacao(cotacao.id)
  const comparacao = compararPorItem(itens, propostas)

  // ── Sub-estado: confirmando o resumo final ──
  if (obs.startsWith('itemaitem-confirmar:')) {
    if (cmd === '0' || cmd === 'voltar') {
      const estado = { i: 0, escolhas: {} }
      await supabase.from('cotacoes').update({ obs_interna: `itemaitem:${JSON.stringify(estado)}` }).eq('id', cotacao.id)
      return avancarManual({ comerciante, cotacao, phone, comparacao, itens, propostas, estado })
    }
    if (cmd === '1' || cmd === 'sim' || cmd === 'confirmar' || cmd === 'confirmo') {
      const escolhas = JSON.parse(obs.slice('itemaitem-confirmar:'.length))
      const resultado = montarPedidoManual(itens, propostas, escolhas)
      return finalizarPedidos({ comerciante, cotacao, resultado, modo: 'manual', phone })
    }
    await sendText(phone, 'Responda *1* para confirmar ou *0* para refazer as escolhas.')
    return { ok: true }
  }

  // ── Sub-estado: escolhendo o fornecedor do item atual ──
  let estado
  try { estado = JSON.parse(obs.slice('itemaitem:'.length)) }
  catch { estado = { i: 0, escolhas: {} } }

  const atual = comparacao[estado.i]
  if (!atual) {
    return mostrarResumoManual({ comerciante, cotacao, phone, itens, propostas, escolhas: estado.escolhas })
  }

  if (cmd === '0' || cmd === 'voltar') {
    if (estado.i > 0) {
      estado.i--
      const alvo = comparacao[estado.i]
      if (alvo) delete estado.escolhas[alvo.item.id]
      return avancarManual({ comerciante, cotacao, phone, comparacao, itens, propostas, estado })
    }
    return handleReenviarComparativo(comerciante, cotacao, phone)
  }

  if (cmd === 'pular' || cmd === 'pula') {
    estado.i++
    return avancarManual({ comerciante, cotacao, phone, comparacao, itens, propostas, estado })
  }

  // Seleção numérica (ou por nome) do fornecedor para o item atual
  const n = parseInt(cmd)
  let oferta = null
  if (!isNaN(n) && n >= 1 && n <= atual.ofertas.length) oferta = atual.ofertas[n - 1]
  else oferta = atual.ofertas.find(o => cmd.includes(o.nome.toLowerCase()))

  if (!oferta) {
    return avancarManual({ comerciante, cotacao, phone, comparacao, itens, propostas, estado, repetir: true })
  }

  estado.escolhas[atual.item.id] = oferta.representante_id
  estado.i++
  return avancarManual({ comerciante, cotacao, phone, comparacao, itens, propostas, estado })
}

// Avança o loop: pula itens sem proposta, persiste o estado e pergunta o item atual.
async function avancarManual({ cotacao, phone, comparacao, itens, propostas, estado, repetir = false }) {
  while (estado.i < comparacao.length && comparacao[estado.i].ofertas.length === 0) {
    estado.i++
  }

  if (estado.i >= comparacao.length) {
    await supabase.from('cotacoes').update({ obs_interna: `itemaitem:${JSON.stringify(estado)}` }).eq('id', cotacao.id)
    return mostrarResumoManual({ cotacao, phone, itens, propostas, escolhas: estado.escolhas })
  }

  await supabase.from('cotacoes').update({ obs_interna: `itemaitem:${JSON.stringify(estado)}` }).eq('id', cotacao.id)

  const { item, ofertas } = comparacao[estado.i]
  const qtdStr = item.quantidade ? ` × ${item.quantidade}` : ''
  const linhas = ofertas.map((o, i) =>
    `${i + 1}. ${o.nome} — R$ ${o.preco_unitario?.toFixed(2)}${o.melhor ? ' [melhor]' : ''} (pgto ${o.prazo_pagamento_dias ?? '?'}d · entrega ${o.prazo_entrega_dias ?? '?'}d)`)

  const header = repetir
    ? ['Não entendi — escolha pelo número:', `*${item.produto}${qtdStr}*`]
    : [`*Item ${estado.i + 1}/${comparacao.length}:* ${item.produto}${qtdStr}`, 'Escolha o fornecedor:']

  await sendText(phone, [
    ...header,
    ...linhas,
    '',
    'Envie o *número*. *pular* p/ não comprar este item · *0* p/ voltar.',
  ].join('\n'))
  return { ok: true }
}

// Monta o resumo final do modo manual e pede confirmação.
async function mostrarResumoManual({ cotacao, phone, itens, propostas, escolhas }) {
  const resultado = montarPedidoManual(itens, propostas, escolhas)
  if (!resultado.grupos.length) {
    await sendText(phone, 'Você não escolheu nenhum item. Envie *descartar* para recomeçar.')
    return { ok: true }
  }
  await supabase.from('cotacoes').update({ obs_interna: `itemaitem-confirmar:${JSON.stringify(escolhas)}` }).eq('id', cotacao.id)
  await sendText(phone, templateResumoPedido(resultado, cotacao.id, 'Item a item'))
  return { ok: true }
}

// ── Templates de comparativo e fechamento ─────────────────────────────

// Comparativo por item, com ⭐ no melhor preço de cada item.
function templateComparativoPorItem(comparacao, cotacaoId, resumo = null) {
  const msg = [`*Cotação #${cotacaoId.slice(-6).toUpperCase()} — comparativo por item*`]

  comparacao.forEach(({ item, ofertas }, i) => {
    const qtd = item.quantidade ? ` × ${item.quantidade}` : ''
    msg.push('')
    msg.push(`*${i + 1}. ${item.produto}${item.marca ? ` (${item.marca})` : ''}${qtd}*`)
    if (!ofertas.length) {
      msg.push('   _sem proposta_')
      return
    }
    for (const o of ofertas) {
      const prefix = o.melhor ? '> ' : '  '
      msg.push(`${prefix}${o.nome} — R$ ${o.preco_unitario?.toFixed(2)} (pgto ${o.prazo_pagamento_dias ?? '?'}d · entrega ${o.prazo_entrega_dias ?? '?'}d)`)
    }
  })

  if (resumo) {
    msg.push('')
    msg.push('—')
    msg.push(resumo)
  }

  msg.push('')
  msg.push(templateOpcoesFechamento())
  return msg.join('\n')
}

function templateOpcoesFechamento() {
  return [
    '*Como deseja fechar o pedido?*',
    '1. Split automatico — o melhor preco de cada item',
    '2. Fornecedor unico — fecho tudo com o melhor no geral',
    '3. Fornecedor unico — voce escolhe qual',
    '4. Item a item — voce escolhe o fornecedor de cada produto',
    '',
    'Ou *consulta* p/ salvar sem comprar · *descartar* p/ nova cotação.',
  ].join('\n')
}

// Resumo de um pedido montado (split, único ou manual) antes de confirmar.
function templateResumoPedido(resultado, cotacaoId, titulo) {
  const msg = [`*Confira seu pedido — ${titulo}*`, '']
  for (const grupo of resultado.grupos) {
    msg.push(`*${grupo.rep.nome}*${grupo.rep.empresa ? ` · ${grupo.rep.empresa}` : ''}`)
    for (const it of grupo.itens) {
      msg.push(`  ${it.produto} × ${it.quantidade ?? 1} — R$ ${it.preco_total?.toFixed(2)}`)
    }
    msg.push(`  _Subtotal: R$ ${grupo.subtotal.toFixed(2)} · pgto ${grupo.rep.prazo_pagamento_dias ?? '?'}d · entrega ${grupo.rep.prazo_entrega_dias ?? '?'}d_`)
    msg.push('')
  }
  if (resultado.itensSemProposta?.length) {
    msg.push(`_Sem proposta (não incluídos): ${resultado.itensSemProposta.join(', ')}_`)
    msg.push('')
  }
  msg.push(`*Total: R$ ${resultado.valorTotal.toFixed(2)}*`)
  if (resultado.grupos.length > 1) {
    msg.push(`_${resultado.grupos.length} pedidos serão gerados (um por fornecedor)._`)
  }
  msg.push('')
  msg.push('1. Confirmar pedido')
  msg.push('0. Voltar')
  return msg.join('\n')
}
