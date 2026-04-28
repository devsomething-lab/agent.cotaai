import { supabase } from '../db/client.js'
import { sendText } from '../services/whatsapp.js'

// ── Verifica se o número está em processo de auto-cadastro ────────────

export async function getSessaoOnboarding(telefone) {
  const { data } = await supabase
    .from('onboarding_sessoes')
    .select('*')
    .eq('telefone', telefone)
    .neq('etapa', 'concluido')
    .single()
  return data
}

// ── Entry point: processa qualquer mensagem de número desconhecido ─────

export async function handleAutocadastro(telefone, message) {
  const texto = (message ?? '').trim().toLowerCase()

  // Verifica se já tem sessão em andamento
  const sessao = await getSessaoOnboarding(telefone)

  // Sem sessão ativa — verifica se é keyword de cadastro
  if (!sessao) {
    if (texto === 'cadastro' || texto === 'cadastrar' || texto === 'quero me cadastrar') {
      return iniciarCadastro(telefone)
    }
    return null // não é cadastro, deixa o fluxo normal tratar
  }

  // Tem sessão ativa — processa a etapa atual
  return processarEtapa(telefone, sessao, message)
}

async function iniciarCadastro(telefone) {
  // Cria sessão de onboarding
  await supabase.from('onboarding_sessoes').upsert({
    telefone,
    etapa: 'aguardando_nome',
    atualizado_em: new Date().toISOString(),
  }, { onConflict: 'telefone' })

  await sendText(telefone, [
    'Olá! Bem-vindo ao *Kota*!',
    '',
    'Vou cadastrar você como representante em menos de 1 minuto.',
    '',
    'Qual é o seu *nome completo*?',
  ].join('\n'))

  return { ok: true, etapa: 'aguardando_nome' }
}

async function processarEtapa(telefone, sessao, message) {
  const texto = (message ?? '').trim()

  switch (sessao.etapa) {
    case 'aguardando_nome': {
      if (texto.length < 2) {
        await sendText(telefone, 'Por favor, informe seu nome completo.')
        return { ok: true }
      }

      await supabase.from('onboarding_sessoes')
        .update({ nome: texto, etapa: 'aguardando_empresa', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)

      await sendText(telefone, [
        `Ótimo, *${texto}*! `,
        '',
        'Qual é o nome da sua *empresa ou distribuidora*?',
      ].join('\n'))
      return { ok: true, etapa: 'aguardando_empresa' }
    }

    case 'aguardando_empresa': {
      if (texto.length < 2) {
        await sendText(telefone, 'Por favor, informe o nome da sua empresa.')
        return { ok: true }
      }

      await supabase.from('onboarding_sessoes')
        .update({ empresa: texto, etapa: 'aguardando_prazo_entrega', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)

      await sendText(telefone, [
        `*${texto}*, anotado! 📦`,
        '',
        'Qual é o seu *prazo de entrega padrão* em dias?',
        '(Ex: 2 para 2 dias úteis)',
      ].join('\n'))
      return { ok: true, etapa: 'aguardando_prazo_entrega' }
    }

    case 'aguardando_prazo_entrega': {
      const dias = parseInt(texto)
      if (isNaN(dias) || dias < 1 || dias > 30) {
        await sendText(telefone, 'Por favor, informe um número de dias válido. Ex: *2*')
        return { ok: true }
      }

      await supabase.from('onboarding_sessoes')
        .update({ prazo_entrega_dias: dias, etapa: 'aguardando_prazo_pagamento', atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)

      await sendText(telefone, [
        `*${dias} dia(s)* de entrega. ✅`,
        '',
        'Qual é o seu *prazo de pagamento padrão* em dias?',
        '(Ex: 30 para 30 dias, 0 para à vista)',
      ].join('\n'))
      return { ok: true, etapa: 'aguardando_prazo_pagamento' }
    }

    case 'aguardando_prazo_pagamento': {
      const diasPg = parseInt(texto)
      if (isNaN(diasPg) || diasPg < 0 || diasPg > 120) {
        await sendText(telefone, 'Por favor, informe um número de dias válido. Ex: *30*')
        return { ok: true }
      }

      // Busca sessão completa
      const { data: sessaoCompleta } = await supabase
        .from('onboarding_sessoes')
        .select('*')
        .eq('telefone', telefone)
        .single()

      // Cria o representante
      const { data: rep, error } = await supabase
        .from('representantes')
        .upsert({
          nome: sessaoCompleta.nome,
          empresa: sessaoCompleta.empresa,
          telefone,
          prazo_entrega_padrao_dias: sessaoCompleta.prazo_entrega_dias,
          prazo_pagamento_padrao_dias: diasPg,
          ativo: true,
        }, { onConflict: 'telefone' })
        .select()
        .single()

      if (error) {
        console.error('[onboarding] erro ao criar rep:', error)
        await sendText(telefone, 'Erro ao finalizar cadastro. Tente novamente ou entre em contato com o suporte.')
        return { ok: false }
      }

      // Marca sessão como concluída
      await supabase.from('onboarding_sessoes')
        .update({ etapa: 'concluido', prazo_pagamento_dias: diasPg, atualizado_em: new Date().toISOString() })
        .eq('telefone', telefone)

      await sendText(telefone, [
        `*Cadastro concluído, ${sessaoCompleta.nome}!*`,
        '',
        `*Seus dados:*`,
        `• Empresa: ${sessaoCompleta.empresa}`,
        `• Prazo de entrega: ${sessaoCompleta.prazo_entrega_dias} dia(s)`,
        `• Prazo de pagamento: ${diasPg} dia(s)`,
        '',
        'Você já está pronto para receber solicitações de cotação pelo Kota!',
        '',
        'Quando um comerciante solicitar cotação dos seus produtos, você receberá uma mensagem aqui.',
        '',
        '*Dica:* Você também pode enviar sua tabela de preços a qualquer momento — basta mandar um arquivo Excel ou listar seus produtos com preços.',
      ].join('\n'))

      console.log(`[onboarding] rep cadastrado: ${sessaoCompleta.nome} (${telefone})`)
      return { ok: true, repId: rep.id, etapa: 'concluido' }
    }

    default:
      return null
  }
}
