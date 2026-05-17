import { supabase } from '../db/client.js'
import { sendText, sendDocument, sendTemplate } from '../services/whatsapp.js'
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
    // Resposta ao convite do comerciante (texto "sim" ou botão "Confirmar" do template)
    if (texto === 'sim' || texto === 'ok' || texto === 'quero' || texto === 'confirmar') {
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
        'As informações estão corretas?',
        '',
        '1. Sim — confirmar cadastro',
        '2. Não — corrigir informações',
      ].filter(l => l !== '').join('\n'))

      // Salva dados completos na sessão aguardando confirmação
      await supabase.from('onboarding_sessoes')
        .update({
          etapa:               'aguardando_confirmacao_cadastro',
          prazo_pagamento_dias: diasPg,
          atualizado_em:       new Date().toISOString(),
        })
        .eq('telefone', telefone)

      // Salva rep provisoriamente (será ativado na confirmação)
      await supabase.from('representantes').upsert({
        nome: s.nome, empresa: s.empresa, cnpj: s.cnpj ?? null, telefone,
        prazo_entrega_padrao_dias:  s.prazo_entrega_dias,
        prazo_pagamento_padrao_dias: diasPg, ativo: false,
      }, { onConflict: 'telefone' })

      return { ok: true }
    }
    case 'aguardando_confirmacao_cadastro': {
      const cmd = texto.toLowerCase()
      if (cmd === '1' || cmd === 'sim' || cmd === 's') {
        // Ativa o rep e finaliza
        const { data: rep } = await supabase.from('representantes')
          .update({ ativo: true })
          .eq('telefone', telefone)
          .select()
          .single()
        await supabase.from('onboarding_sessoes')
          .update({ etapa: 'concluido', atualizado_em: new Date().toISOString() })
          .eq('telefone', telefone)

        await sendText(telefone, [
          'Cadastro confirmado!',
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
        ].join('\n'))

        if (TEMPLATE_CATALOGO_URL) {
          await sendDocument(telefone, TEMPLATE_CATALOGO_URL, 'catalogo_kota_template.xlsx',
            'Preencha com seus produtos e preços e envie de volta para mim.')
        }

        // Verifica convites pendentes e cria vínculos
        if (rep) {
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
              const com = convite.comerciantes
              if (com?.telefone) {
                await sendText(com.telefone, [
                  `*${rep.nome}* (${rep.empresa}) concluiu o cadastro no Kota e está vinculado como seu fornecedor.`,
                  'Você já pode cotá-los na sua próxima lista.',
                ].join('\n'))
              }
            }
          } catch (err) {
            console.warn('[onboarding] erro ao processar convites pendentes:', err.message)
          }
        }
        return { ok: true, repId: rep?.id }
      }

      if (cmd === '2' || cmd === 'não' || cmd === 'nao' || cmd === 'n') {
        // Reinicia o cadastro do rep
        await supabase.from('representantes').delete().eq('telefone', telefone)
        await supabase.from('onboarding_sessoes')
          .update({ etapa: 'aguardando_nome', nome: null, empresa: null, cnpj: null,
                    prazo_entrega_dias: null, prazo_pagamento_dias: null,
                    atualizado_em: new Date().toISOString() })
          .eq('telefone', telefone)
        await sendText(telefone, 'Tudo bem! Vamos recomeçar.\n\nQual é o seu nome?')
        return { ok: true }
      }

      await sendText(telefone, 'Responda com *1* para confirmar ou *2* para corrigir.')
      return { ok: true }
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
        'As informações estão corretas?',
        '',
        '1. Sim — confirmar cadastro',
        '2. Não — corrigir informações',
      ].filter(l => l !== '').join('\n'))

      // Aguarda confirmação antes de prosseguir
      await supabase.from('onboarding_sessoes')
        .update({ etapa: 'aguardando_confirmacao_cadastro', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)

      return { ok: true }
    }
    case 'aguardando_confirmacao_cadastro': {
      const cmd = texto.toLowerCase()
      if (cmd === '1' || cmd === 'sim' || cmd === 's') {
        await supabase.from('onboarding_sessoes')
          .update({ etapa: 'cadastrando_fornecedores', atualizado_em: new Date().toISOString() })
          .eq('telefone', telefone)

        await sendText(telefone, [
          'Cadastro confirmado!',
          '',
          'Agora você tem um agente de IA cuidando das suas compras.',
          '',
          '*Como funciona:*',
          '• Cadastre seus fornecedores aqui no Kota',
          '• Envie sua lista de produtos e a IA entra em contato com todos eles, recebe as propostas e te apresenta o melhor preço para você fechar negócio',
        ].join('\n'))

        await sendText(telefone, [
          'Agora vamos cadastrar seus fornecedores.',
          '',
          'Envie os números de WhatsApp — pode enviar vários de uma vez, um por linha.',
          'Quando quiser parar, é só enviar sua lista de produtos.',
          '',
          'Ex:',
          '_47999990001_',
          '_11988880002_',
        ].join('\n'))
        return { ok: true }
      }

      if (cmd === '2' || cmd === 'não' || cmd === 'nao' || cmd === 'n') {
        // Reinicia o cadastro do comerciante
        await supabase.from('onboarding_sessoes')
          .update({ etapa: 'aguardando_nome', nome: null, empresa: null, cnpj: null,
                    atualizado_em: new Date().toISOString() })
          .eq('telefone', telefone)
        await sendText(telefone, 'Tudo bem! Vamos recomeçar.\n\nQual é o seu nome?')
        return { ok: true }
      }

      await sendText(telefone, 'Responda com *1* para confirmar ou *2* para corrigir.')
      return { ok: true }
    }
    case 'cadastrando_fornecedores': {
      const { validos, invalidos } = extrairTelefones(texto)

      // Tem números inválidos (sem DDD) — avisa e não processa
      if (invalidos.length > 0 && validos.length === 0) {
        await sendText(telefone, [
          'Número(s) incompleto(s) — parece que está faltando o DDD.',
          '',
          ...invalidos.map(n => `• ${n} ← faltando DDD`),
          '',
          'Envie com DDD + número. Ex:',
          '_47 99272878_',
          '_47 991267785_',
        ].join('\n'))
        return { ok: true }
      }

      // Tem mistura de válidos e inválidos — processa os válidos e avisa sobre os inválidos
      if (invalidos.length > 0 && validos.length > 0) {
        await sendText(telefone, [
          'Alguns números estão incompletos (sem DDD):',
          ...invalidos.map(n => `• ${n} ← faltando DDD`),
          '',
          'Esses foram ignorados. Reenvie com DDD quando quiser.',
        ].join('\n'))
      }

      if (validos.length) {
        const emLote = validos.length > 1
        if (emLote) await sendText(telefone, `Processando ${validos.length} contato(s)...`)
        for (const tel of validos) {
          await handleConvidarFornecedor(telefone, tel, { silencioso: emLote })
        }
        if (emLote) await sendText(telefone, `${validos.length} contato(s) adicionado(s). Pode enviar mais ou sua lista de produtos quando quiser.`)
        return { ok: true }
      }

      // Não é número — encerra o estado e devolve null para o webhook processar normalmente
      await supabase.from('onboarding_sessoes')
        .update({ etapa: 'concluido', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)
      return null
    }
    default: return null
  }
}

// ── Helper: extrai múltiplos telefones de uma mensagem ────────────────
// Retorna { validos: [...], invalidos: [...] }
// Sempre com código do país 55 (formato Meta API)

function extrairTelefones(texto) {
  const partes = texto.split(/[\n,;]+/)
  const validos = []
  const invalidos = []

  for (const parte of partes) {
    const raw = parte.trim()
    if (!raw) continue
    const digits = raw.replace(/\D/g, '')
    if (!digits) continue

    if (digits.length >= 7 && digits.length <= 9) {
      // Parece um telefone mas sem DDD
      invalidos.push(raw)
      continue
    }

    if (digits.length < 10) continue // muito curto para ser telefone

    let tel = digits
    if (tel.startsWith('55') && tel.length >= 12) { /* ok */ }
    else if (tel.length >= 10 && tel.length <= 11) tel = '55' + tel
    else continue

    validos.push(tel)
  }

  return { validos: [...new Set(validos)], invalidos }
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
        'Pode enviar mais números ou enviar sua lista de produtos quando quiser.',
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
    // Novo fornecedor — usa template aprovado (alcança números que nunca interagiram com o Kota)
    await supabase.from('convites_pendentes').upsert({
      comerciante_id:      comerciante.id,
      telefone_fornecedor: telefoneFornecedor,
      aceito:              false,
      criado_em:           new Date().toISOString(),
    }, { onConflict: 'comerciante_id,telefone_fornecedor', ignoreDuplicates: true })

    const nomeComerciant = comerciante.empresa ?? comerciante.nome ?? 'Um comerciante'
    const templateResult = await sendTemplate(telefoneFornecedor, 'convite_fornecedor', [nomeComerciant])

    if (!templateResult.ok) {
      console.warn(`[convite] falha ao enviar template para ${telefoneFornecedor}:`, templateResult.error)
    }

    if (!silencioso) {
      await sendText(telefoneComerciant, [
        `Convite enviado para *${telefoneFornecedor}*.`,
        'Quando o fornecedor confirmar, o vínculo é criado automaticamente.',
        '',
        'Pode enviar mais números ou sua lista de produtos quando quiser.',
      ].join('\n'))
    } else {
      await sendText(telefoneComerciant, `Convite enviado para *${telefoneFornecedor}*.`)
    }
  }

  return { ok: true }
}
