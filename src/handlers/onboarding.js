import { supabase } from '../db/client.js'
import { sendText, sendDocument } from '../services/whatsapp.js'
import { criarVinculo } from '../db/vinculos.js'
import { findRepresentanteByTelefone } from '../db/client.js'

const TEMPLATE_CATALOGO_URL = process.env.TEMPLATE_CATALOGO_URL ?? null

// ── Verifica sessão ativa ─────────────────────────────────────────────

export async function getSessaoOnboarding(telefone) {
  const { data } = await supabase
    .from('onboarding_sessoes')
    .select('*')
    .eq('telefone', telefone)
    .neq('etapa', 'concluido')
    .single()
  return data
}

export async function getSessaoOnboardingComerciantge(telefone) {
  const { data } = await supabase
    .from('onboarding_sessoes')
    .select('*')
    .eq('telefone', telefone)
    .eq('tipo', 'comerciante')
    .neq('etapa', 'concluido')
    .single()
  return data
}

// ── Entry point — qualquer número desconhecido ────────────────────────

export async function handleAutocadastro(telefone, message) {
  const texto = (message ?? '').trim().toLowerCase()
  const sessao = await getSessaoOnboarding(telefone)

  if (!sessao) {
    // Auto-cadastro direto de representante
    if (texto === 'cadastro' || texto === 'cadastrar') {
      return iniciarOnboardingRep(telefone)
    }
    // Resposta ao convite do comerciante
    if (texto === 'sim' || texto === 'ok' || texto === 'quero') {
      return iniciarOnboardingRep(telefone)
    }
    return iniciarSeleçãoPerfil(telefone)
  }

  if (sessao.tipo === 'representante') {
    return processarEtapaRep(telefone, sessao, message)
  } else {
    return processarEtapaComerciantge(telefone, sessao, message)
  }
}

export async function handleOnboardingComerciantge(telefone, message) {
  const sessao = await getSessaoOnboardingComerciantge(telefone)
  if (!sessao) return iniciarOnboardingComerciantge(telefone)
  return processarEtapaComerciantge(telefone, sessao, message)
}

// ── Seleção de perfil ─────────────────────────────────────────────────

async function iniciarSeleçãoPerfil(telefone) {
  await supabase.from('onboarding_sessoes').upsert({
    telefone,
    tipo: 'indefinido',
    etapa: 'aguardando_perfil',
    atualizado_em: new Date().toISOString(),
  }, { onConflict: 'telefone' })

  await sendText(telefone, [
    'Olá! Bem-vindo ao *Kota*.',
    '',
    'Conectamos comerciantes e representantes para cotações mais ágeis e inteligentes com IA, direto no WhatsApp.',
    '',
    'Você é:',
    '1. Comerciante — quero cotar produtos',
    '2. Representante — quero receber cotações',
  ].join('\n'))
  return { ok: true, etapa: 'aguardando_perfil' }
}

async function processarSelecaoPerfil(telefone, sessao, message) {
  const texto = (message ?? '').trim().toLowerCase()

  if (texto === '1' || texto.includes('comerciante') || texto.includes('cotar')) {
    await supabase.from('onboarding_sessoes')
      .update({ tipo: 'comerciante', etapa: 'aguardando_nome', atualizado_em: new Date().toISOString() })
      .eq('telefone', telefone)
    await sendText(telefone, 'Ótimo! Vamos criar seu cadastro. Qual é o seu nome?')
    return { ok: true }
  }

  if (texto === '2' || texto.includes('representante') || texto.includes('receber')) {
    await supabase.from('onboarding_sessoes')
      .update({ tipo: 'representante', etapa: 'aguardando_nome', atualizado_em: new Date().toISOString() })
      .eq('telefone', telefone)
    await sendText(telefone, 'Ótimo! Vamos criar seu cadastro. Qual é o seu nome?')
    return { ok: true }
  }

  await sendText(telefone, 'Responda com *1* ou *2*:\n1. Comerciante\n2. Representante')
  return { ok: true }
}

// ══════════════════════════════════════════════════════════════
//  ONBOARDING DO REPRESENTANTE
// ══════════════════════════════════════════════════════════════

async function iniciarOnboardingRep(telefone) {
  await supabase.from('onboarding_sessoes').upsert({
    telefone,
    tipo: 'representante',
    etapa: 'aguardando_nome',
    atualizado_em: new Date().toISOString(),
  }, { onConflict: 'telefone' })

  await sendText(telefone, 'Ótimo! Vamos criar seu cadastro. Qual é o seu nome?')
  return { ok: true, etapa: 'aguardando_nome' }
}

async function processarEtapaRep(telefone, sessao, message) {
  if (sessao.etapa === 'aguardando_perfil') {
    return processarSelecaoPerfil(telefone, sessao, message)
  }

  const texto = (message ?? '').trim()

  switch (sessao.etapa) {
    case 'aguardando_nome': {
      if (texto.length < 2) { await sendText(telefone, 'Informe seu nome.'); return { ok: true } }
      await supabase.from('onboarding_sessoes')
        .update({ nome: texto, etapa: 'aguardando_empresa', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)
      await sendText(telefone, `Prazer, *${texto}*! Qual é o nome da sua empresa?`)
      return { ok: true }
    }
    case 'aguardando_empresa': {
      if (texto.length < 2) { await sendText(telefone, 'Informe o nome da empresa.'); return { ok: true } }
      await supabase.from('onboarding_sessoes')
        .update({ empresa: texto, etapa: 'aguardando_cnpj', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)
      await sendText(telefone, `Qual é o CNPJ da empresa?\n\nEx: _12.345.678/0001-90_`)
      return { ok: true }
    }
    case 'aguardando_cnpj': {
      const cnpjFinal = normalizarCNPJ(texto)
      if (!cnpjFinal) {
        await sendText(telefone, 'CNPJ inválido. Informe os 14 dígitos corretamente.\n\nEx: _12.345.678/0001-90_')
        return { ok: true }
      }
      await supabase.from('onboarding_sessoes')
        .update({ cnpj: cnpjFinal, etapa: 'aguardando_prazo_entrega', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)
      await sendText(telefone, `Qual é o seu prazo médio de entrega (em dias)?\n\nEx: _2_ para 2 dias úteis`)
      return { ok: true }
    }
    case 'aguardando_prazo_entrega': {
      const dias = parseInt(texto)
      if (isNaN(dias) || dias < 1 || dias > 30) {
        await sendText(telefone, 'Informe um número válido entre 1 e 30. Ex: _2_')
        return { ok: true }
      }
      await supabase.from('onboarding_sessoes')
        .update({ prazo_entrega_dias: dias, etapa: 'aguardando_prazo_pagamento', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)
      await sendText(telefone, `Entendido, ${dias} dia(s). E o prazo médio de pagamento (em dias)?\n\nEx: _30_ para 30 dias, _0_ para à vista`)
      return { ok: true }
    }
    case 'aguardando_prazo_pagamento': {
      const diasPg = parseInt(texto)
      if (isNaN(diasPg) || diasPg < 0 || diasPg > 120) {
        await sendText(telefone, 'Informe um número válido entre 0 e 120. Ex: _30_')
        return { ok: true }
      }
      const { data: s } = await supabase.from('onboarding_sessoes').select('*').eq('telefone', telefone).single()
      const { data: rep, error } = await supabase.from('representantes').upsert({
        nome: s.nome, empresa: s.empresa, cnpj: s.cnpj ?? null, telefone,
        prazo_entrega_padrao_dias: s.prazo_entrega_dias,
        prazo_pagamento_padrao_dias: diasPg, ativo: true,
      }, { onConflict: 'telefone' }).select().single()
      if (error) { await sendText(telefone, 'Erro ao finalizar cadastro. Tente novamente.'); return { ok: false } }
      await supabase.from('onboarding_sessoes')
        .update({ etapa: 'concluido', prazo_pagamento_dias: diasPg, atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)

      await sendText(telefone, [
        `*Cadastro concluído! Bem-vindo ao Kota, ${s.nome}.*`,
        '',
        '*Resumo do seu cadastro:*',
        `• Nome: ${s.nome}`,
        `• Empresa: ${s.empresa}`,
        s.cnpj ? `• CNPJ: ${formatarCNPJ(s.cnpj)}` : '',
        `• Prazo médio de entrega: ${s.prazo_entrega_dias} dia(s)`,
        `• Prazo médio de pagamento: ${diasPg === 0 ? 'à vista' : `${diasPg} dias`}`,
        '',
        'A partir de agora você receberá pedidos de cotação aqui no WhatsApp.',
        '',
        '*Como funciona:*',
        '• Com catálogo → cotações respondidas automaticamente pela IA, com notificações no WhatsApp',
        '• Sem catálogo → você recebe as cotações e responde direto pelo WhatsApp',
        '',
        '*Próximo passo:* envie seu catálogo para ativar as respostas automáticas.',
        'Pode enviar como:',
        '- Planilha Excel (.xlsx) — em anexo um template para preencher',
        '- Arquivo PDF',
        '- Lista em texto (ex: _Coca-Cola 2L R$ 8,50_)',
        '- Foto da tabela impressa',
      ].filter(l => l !== '').join('\n'))

      if (TEMPLATE_CATALOGO_URL) {
        await sendDocument(
          telefone,
          TEMPLATE_CATALOGO_URL,
          'catalogo_kota_template.xlsx',
          'Preencha com seus produtos e preços e envie de volta para mim.'
        )
      }

      // Verifica convites pendentes de comerciantes e cria vínculos automaticamente
      try {
        const { data: convitesPendentes } = await supabase
          .from('convites_pendentes')
          .select('comerciante_id, comerciantes(nome, empresa, telefone)')
          .eq('telefone_fornecedor', telefone)
          .eq('aceito', false)

        for (const convite of convitesPendentes ?? []) {
          await criarVinculo(convite.comerciante_id, rep.id)
          await supabase.from('convites_pendentes')
            .update({ aceito: true })
            .eq('comerciante_id', convite.comerciante_id)
            .eq('telefone_fornecedor', telefone)

          // Notifica o comerciante que o rep concluiu o cadastro
          const com = convite.comerciantes
          if (com?.telefone) {
            await sendText(com.telefone, [
              `*${s.nome}* (${s.empresa}) concluiu o cadastro no Kota e está vinculado como seu fornecedor.`,
              'Você já pode cotá-los na sua próxima lista.',
            ].join('\n'))
          }
        }
      } catch (err) {
        console.warn('[onboarding] erro ao processar convites pendentes:', err.message)
      }

      return { ok: true, repId: rep.id }
    }
    default: return null
  }
}

// ══════════════════════════════════════════════════════════════
//  ONBOARDING DO COMERCIANTE
// ══════════════════════════════════════════════════════════════

async function iniciarOnboardingComerciantge(telefone) {
  await supabase.from('onboarding_sessoes').upsert({
    telefone,
    tipo: 'comerciante',
    etapa: 'aguardando_nome',
    atualizado_em: new Date().toISOString(),
  }, { onConflict: 'telefone' })

  await sendText(telefone, 'Ótimo! Vamos criar seu cadastro. Qual é o seu nome?')
  return { ok: true, etapa: 'aguardando_nome' }
}

async function processarEtapaComerciantge(telefone, sessao, message) {
  if (sessao.etapa === 'aguardando_perfil') {
    return processarSelecaoPerfil(telefone, sessao, message)
  }

  const texto = (message ?? '').trim()

  switch (sessao.etapa) {
    case 'aguardando_nome': {
      if (texto.length < 2) { await sendText(telefone, 'Informe seu nome.'); return { ok: true } }
      await supabase.from('onboarding_sessoes')
        .update({ nome: texto, etapa: 'aguardando_empresa', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)
      await sendText(telefone, `Prazer, *${texto}*! Qual é o nome do seu estabelecimento?`)
      return { ok: true }
    }
    case 'aguardando_empresa': {
      if (texto.length < 2) { await sendText(telefone, 'Informe o nome do estabelecimento.'); return { ok: true } }
      const { data: s } = await supabase.from('onboarding_sessoes').select('*').eq('telefone', telefone).single()
      await supabase.from('onboarding_sessoes')
        .update({ empresa: texto, etapa: 'aguardando_cnpj', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)
      await sendText(telefone, `Qual é o CNPJ do estabelecimento?\n\nEx: _12.345.678/0001-90_`)
      return { ok: true }
    }
    case 'aguardando_cnpj': {
      const cnpjFinal = normalizarCNPJ(texto)
      if (!cnpjFinal) {
        await sendText(telefone, 'CNPJ inválido. Informe os 14 dígitos corretamente.\n\nEx: _12.345.678/0001-90_')
        return { ok: true }
      }
      await supabase.from('onboarding_sessoes')
        .update({ cnpj: cnpjFinal, etapa: 'cadastrando_fornecedores', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)

      // Busca dados atualizados da sessão para salvar no banco
      const { data: s2 } = await supabase.from('onboarding_sessoes').select('*').eq('telefone', telefone).single()
      const { data: comerciante } = await supabase.from('comerciantes')
        .update({ nome: s2.nome, empresa: s2.empresa, cnpj: cnpjFinal })
        .eq('telefone', telefone)
        .select()
        .single()

      await sendText(telefone, [
        `*Tudo pronto! Bem-vindo ao Kota, ${s2.nome}.*`,
        '',
        '*Resumo do seu cadastro:*',
        `• Nome: ${s2.nome}`,
        `• Estabelecimento: ${s2.empresa}`,
        cnpjFinal ? `• CNPJ: ${formatarCNPJ(cnpjFinal)}` : '',
        '',
        'Agora você tem um agente de IA cuidando das suas compras.',
        '',
        '*Como funciona:*',
        '• Cadastre seus fornecedores aqui no Kota',
        '• Envie sua lista de produtos e a IA entra em contato com todos eles, recebe as propostas e te apresenta o melhor preço para você fechar negócio',
      ].filter(l => l !== '').join('\n'))

      await sendText(telefone, [
        'Agora vamos cadastrar seus fornecedores.',
        '',
        'Envie o *número de WhatsApp* de cada fornecedor (um por mensagem).',
        'Quando terminar, envie *pronto*.',
        '',
        'Ex: _11999990001_',
      ].join('\n'))

      return { ok: true }
    }
    case 'cadastrando_fornecedores': {
      if (['pronto', 'ok', 'finalizar', 'fim', 'encerrar'].includes(texto.toLowerCase())) {
        await supabase.from('onboarding_sessoes')
          .update({ etapa: 'concluido', atualizado_em: new Date().toISOString() })
          .eq('telefone', telefone)
        await sendText(telefone, [
          'Perfeito! Seus fornecedores foram cadastrados.',
          '',
          'Quando eles concluírem o cadastro no Kota, o vínculo é criado automaticamente e você já pode cotá-los.',
          '',
          'Pode enviar sua lista de produtos quando precisar.',
        ].join('\n'))
        return { ok: true }
      }

      // Extrai todos os telefones da mensagem (aceita lista ou número único)
      const telefonesEncontrados = extrairTelefones(texto)
      if (!telefonesEncontrados.length) {
        await sendText(telefone, [
          'Número inválido. Envie o WhatsApp do fornecedor (só números):',
          '_11999990001_',
          '',
          'Para cadastrar vários de uma vez, envie um por linha:',
          '_11999990001_',
          '_47999990002_',
          '_21999990003_',
          '',
          'Quando terminar, envie *pronto*.',
        ].join('\n'))
        return { ok: true }
      }

      // Processa cada número — silencioso se for lote, normal se for único
      const emLote = telefonesEncontrados.length > 1
      if (emLote) {
        await sendText(telefone, `Processando ${telefonesEncontrados.length} contato(s)...`)
      }
      for (const tel of telefonesEncontrados) {
        await handleConvidarFornecedor(telefone, tel, { silencioso: emLote })
      }
      if (emLote) {
        await sendText(telefone, [
          `${telefonesEncontrados.length} contato(s) processado(s).`,
          '',
          'Envie mais números ou *pronto* para encerrar.',
        ].join('\n'))
      }
      return { ok: true }
    }
    default: return null
  }
}

// ── Helper: extrai múltiplos telefones de uma mensagem ────────────────
// Aceita: um por linha, separados por vírgula, espaço ou quebra de linha

function extrairTelefones(texto) {
  // Separa por quebra de linha, vírgula ou ponto e vírgula
  const partes = texto.split(/[\n,;]+/)
  const telefones = []
  for (const parte of partes) {
    const digits = parte.replace(/\D/g, '')
    // Telefone brasileiro: 10-11 dígitos (com DDD) ou 12-13 com código do país
    if (digits.length >= 10 && digits.length <= 13) {
      // Normaliza: remove código do país 55 se presente
      const tel = digits.startsWith('55') && digits.length > 11
        ? digits.slice(2)
        : digits
      if (tel.length >= 10) telefones.push(tel)
    }
  }
  return [...new Set(telefones)] // remove duplicatas
}

// ── Helpers de CNPJ ───────────────────────────────────────────────────

function normalizarCNPJ(valor) {
  const digits = (valor ?? '').replace(/\D/g, '')
  if (digits.length !== 14) return null
  // Validação dos dígitos verificadores
  const calc = (v, n) => {
    let sum = 0, pos = n - 7
    for (let i = n; i >= 1; i--) {
      sum += parseInt(v[n - i]) * pos--
      if (pos < 2) pos = 9
    }
    const r = sum % 11
    return r < 2 ? 0 : 11 - r
  }
  if (calc(digits, 12) !== parseInt(digits[12])) return null
  if (calc(digits, 13) !== parseInt(digits[13])) return null
  return digits
}

function formatarCNPJ(digits) {
  if (!digits || digits.length !== 14) return digits ?? ''
  return `${digits.slice(0,2)}.${digits.slice(2,5)}.${digits.slice(5,8)}/${digits.slice(8,12)}-${digits.slice(12)}`
}

export async function handleConvidarFornecedor(telefoneComerciant, telefoneFornecedor, opts = {}) {
  const silencioso = opts.silencioso ?? false
  const { data: comerciante } = await supabase
    .from('comerciantes')
    .select('*')
    .eq('telefone', telefoneComerciant)
    .single()
  if (!comerciante) return { ok: false }

  // Verifica se rep já existe no Kota
  const rep = await findRepresentanteByTelefone(telefoneFornecedor)

  if (rep) {
    await criarVinculo(comerciante.id, rep.id)
    if (!silencioso) {
      await sendText(telefoneComerciant, [
        `*${rep.nome}* (${rep.empresa ?? ''}) já está no Kota e foi vinculado como seu fornecedor.`,
        'Ele receberá suas cotações automaticamente.',
        '',
        'Envie o próximo número ou *pronto* para encerrar.',
      ].join('\n'))
    } else {
      await sendText(telefoneComerciant,
        `*${rep.nome}* (${rep.empresa ?? ''}) vinculado.`
      )
    }
    await sendText(telefoneFornecedor, [
      `*${comerciante.nome ?? 'Um comerciante'}* (${comerciante.empresa ?? ''}) adicionou você como cliente no Kota.`,
      'Você receberá as cotações desse cliente automaticamente.',
    ].join('\n'))
  } else {
    await supabase.from('convites_pendentes').upsert({
      comerciante_id:      comerciante.id,
      telefone_fornecedor: telefoneFornecedor,
      aceito:              false,
      criado_em:           new Date().toISOString(),
    }, { onConflict: 'comerciante_id,telefone_fornecedor', ignoreDuplicates: true })

    await sendText(telefoneFornecedor, [
      `*${comerciante.nome ?? 'Um comerciante'}* (${comerciante.empresa ?? ''}) convidou você para o *Kota*.`,
      '',
      'O Kota é um agente de cotação com IA — seus clientes enviam listas de produtos e você recebe as cotações automaticamente, direto pelo WhatsApp.',
      '',
      'Para começar seu cadastro como representante, responda *sim*.',
    ].join('\n'))

    if (!silencioso) {
      await sendText(telefoneComerciant, [
        `Convite enviado para *${telefoneFornecedor}*.`,
        'Quando o fornecedor concluir o cadastro, o vínculo é criado automaticamente.',
        '',
        'Envie o próximo número ou *pronto* para encerrar.',
      ].join('\n'))
    } else {
      await sendText(telefoneComerciant,
        `Convite enviado para *${telefoneFornecedor}*.`
      )
    }
  }

  return { ok: true }
}
