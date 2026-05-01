import { supabase } from '../db/client.js'
import { sendText, sendDocument } from '../services/whatsapp.js'

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
    if (texto === 'cadastro' || texto === 'cadastrar') {
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
    'Ola! Bem-vindo ao *Kota*.',
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
    await sendText(telefone, 'Otimo! Vamos criar seu cadastro. Qual é o seu nome?')
    return { ok: true }
  }

  if (texto === '2' || texto.includes('representante') || texto.includes('receber')) {
    await supabase.from('onboarding_sessoes')
      .update({ tipo: 'representante', etapa: 'aguardando_nome', atualizado_em: new Date().toISOString() })
      .eq('telefone', telefone)
    await sendText(telefone, 'Otimo! Vamos criar seu cadastro. Qual é o seu nome?')
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

  await sendText(telefone, 'Otimo! Vamos criar seu cadastro. Qual é o seu nome?')
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
        .update({ empresa: texto, etapa: 'aguardando_prazo_entrega', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)
      await sendText(telefone, `Qual é o seu prazo de entrega padrão (em dias)?\n\nEx: _2_ para 2 dias úteis`)
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
      await sendText(telefone, `Entendido, ${dias} dia(s). E o prazo de pagamento padrão (em dias)?\n\nEx: _30_ para 30 dias, _0_ para à vista`)
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
        nome: s.nome, empresa: s.empresa, telefone,
        prazo_entrega_padrao_dias: s.prazo_entrega_dias,
        prazo_pagamento_padrao_dias: diasPg, ativo: true,
      }, { onConflict: 'telefone' }).select().single()
      if (error) { await sendText(telefone, 'Erro ao finalizar cadastro. Tente novamente.'); return { ok: false } }
      await supabase.from('onboarding_sessoes')
        .update({ etapa: 'concluido', prazo_pagamento_dias: diasPg, atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)

      await sendText(telefone, [
        `*Cadastro concluido! Bem-vindo ao Kota, ${s.nome}.*`,
        '',
        `*${s.empresa}*`,
        `Entrega: ${s.prazo_entrega_dias} dia(s) · Pagamento: ${diasPg === 0 ? 'à vista' : `${diasPg} dias`}`,
        '',
        'A partir de agora você receberá pedidos de cotação aqui no WhatsApp.',
        '',
        '*Como funciona:*',
        '• Com catálogo → cotações respondidas automaticamente pela IA, com notificações no WhatsApp',
        '• Sem catálogo → você recebe as cotações e responde direto pelo WhatsApp',
        '',
        '*Proximo passo:* envie seu catálogo para ativar as respostas automáticas.',
        'Pode enviar como:',
        '- Planilha Excel (.xlsx) — em anexo um template para preencher',
        '- Arquivo PDF',
        '- Lista em texto (ex: _Coca-Cola 2L R$ 8,50_)',
        '- Foto da tabela impressa',
      ].join('\n'))

      // Envia template Excel se URL configurada
      if (TEMPLATE_CATALOGO_URL) {
        await sendDocument(
          telefone,
          TEMPLATE_CATALOGO_URL,
          'catalogo_kota_template.xlsx',
          'Preencha com seus produtos e preços e envie de volta para mim.'
        )
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

  await sendText(telefone, 'Otimo! Vamos criar seu cadastro. Qual é o seu nome?')
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
      await supabase.from('comerciantes')
        .update({ nome: s.nome, empresa: texto })
        .eq('telefone', telefone)
      await supabase.from('onboarding_sessoes')
        .update({ empresa: texto, etapa: 'concluido', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)

      await sendText(telefone, [
        `*Tudo pronto! Bem-vindo ao Kota, ${s.nome}.*`,
        '',
        `*${texto}* está pronto para cotar.`,
        '',
        'Me manda a lista de produtos que você precisa comprar e eu cuido do resto.',
        '',
        '*Como funciona:*',
        '• Com catálogo → cotações respondidas automaticamente pela IA, com notificações no WhatsApp',
        '• Sem catálogo → você recebe as cotações e responde direto pelo WhatsApp',
        '',
        'Nos dois casos você recebe um comparativo com preços e condições para escolher o melhor fornecedor.',
        '',
        '*Como enviar sua lista:*',
        '- Texto: _2cx Coca-Cola 2L, 1fd Detergente Ypê_',
        '- Foto da lista ou do pedido',
        '- Audio descrevendo os produtos',
        '',
        'Pode enviar sua lista agora ou quando precisar.',
      ].join('\n'))
      return { ok: true, etapa: 'concluido' }
    }
    default: return null
  }
}
