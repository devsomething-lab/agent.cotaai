import { supabase } from '../db/client.js'
import { sendText } from '../services/whatsapp.js'

export async function getSessaoOnboarding(telefone) {
  const { data } = await supabase
    .from('onboarding_sessoes')
    .select('*')
    .eq('telefone', telefone)
    .neq('etapa', 'concluido')
    .single()
  return data
}

export async function handleAutocadastro(telefone, message) {
  const texto = (message ?? '').trim().toLowerCase()
  const sessao = await getSessaoOnboarding(telefone)

  if (!sessao) {
    if (texto === 'cadastro' || texto === 'cadastrar') {
      return iniciarCadastro(telefone)
    }
    return null
  }
  return processarEtapa(telefone, sessao, message)
}

async function iniciarCadastro(telefone) {
  await supabase.from('onboarding_sessoes').upsert({
    telefone, etapa: 'aguardando_nome', atualizado_em: new Date().toISOString(),
  }, { onConflict: 'telefone' })

  await sendText(telefone, '👋 Olá! Bem-vindo ao *Kota*!\n\nVou cadastrar você como representante em menos de 1 minuto.\n\n📝 Qual é o seu *nome completo*?')
  return { ok: true, etapa: 'aguardando_nome' }
}

async function processarEtapa(telefone, sessao, message) {
  const texto = (message ?? '').trim()

  switch (sessao.etapa) {
    case 'aguardando_nome': {
      if (texto.length < 2) { await sendText(telefone, 'Por favor, informe seu nome completo.'); return { ok: true } }
      await supabase.from('onboarding_sessoes').update({ nome: texto, etapa: 'aguardando_empresa', atualizado_em: new Date().toISOString() }).eq('telefone', telefone)
      await sendText(telefone, `Ótimo, *${texto}*! 👍\n\n🏢 Qual é o nome da sua *empresa ou distribuidora*?`)
      return { ok: true }
    }
    case 'aguardando_empresa': {
      if (texto.length < 2) { await sendText(telefone, 'Por favor, informe o nome da sua empresa.'); return { ok: true } }
      await supabase.from('onboarding_sessoes').update({ empresa: texto, etapa: 'aguardando_prazo_entrega', atualizado_em: new Date().toISOString() }).eq('telefone', telefone)
      await sendText(telefone, `*${texto}*, anotado! 📦\n\n🚚 Qual é o seu *prazo de entrega padrão* em dias?\n(Ex: 2 para 2 dias úteis)`)
      return { ok: true }
    }
    case 'aguardando_prazo_entrega': {
      const dias = parseInt(texto)
      if (isNaN(dias) || dias < 1 || dias > 30) { await sendText(telefone, 'Por favor, informe um número válido. Ex: *2*'); return { ok: true } }
      await supabase.from('onboarding_sessoes').update({ prazo_entrega_dias: dias, etapa: 'aguardando_prazo_pagamento', atualizado_em: new Date().toISOString() }).eq('telefone', telefone)
      await sendText(telefone, `*${dias} dia(s)* de entrega. ✅\n\n💳 Qual é o seu *prazo de pagamento padrão* em dias?\n(Ex: 30 para 30 dias, 0 para à vista)`)
      return { ok: true }
    }
    case 'aguardando_prazo_pagamento': {
      const diasPg = parseInt(texto)
      if (isNaN(diasPg) || diasPg < 0 || diasPg > 120) { await sendText(telefone, 'Por favor, informe um número válido. Ex: *30*'); return { ok: true } }
      const { data: s } = await supabase.from('onboarding_sessoes').select('*').eq('telefone', telefone).single()
      const { data: rep, error } = await supabase.from('representantes').upsert({
        nome: s.nome, empresa: s.empresa, telefone,
        prazo_entrega_padrao_dias: s.prazo_entrega_dias,
        prazo_pagamento_padrao_dias: diasPg, ativo: true,
      }, { onConflict: 'telefone' }).select().single()
      if (error) { console.error('[onboarding]', error); await sendText(telefone, '⚠️ Erro ao finalizar. Tente novamente.'); return { ok: false } }
      await supabase.from('onboarding_sessoes').update({ etapa: 'concluido', prazo_pagamento_dias: diasPg, atualizado_em: new Date().toISOString() }).eq('telefone', telefone)
      await sendText(telefone, `✅ *Cadastro concluído, ${s.nome}!*\n\n📋 *Seus dados:*\n• Empresa: ${s.empresa}\n• Prazo de entrega: ${s.prazo_entrega_dias} dia(s)\n• Prazo de pagamento: ${diasPg} dia(s)\n\n🎉 Você já está pronto para receber solicitações de cotação pelo Kota!\n\n💡 *Dica:* Envie sua tabela de preços (Excel ou lista) a qualquer momento.`)
      return { ok: true, repId: rep.id }
    }
    default: return null
  }
}
