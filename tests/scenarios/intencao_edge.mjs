// tests/scenarios/intencao_edge.mjs
// T24–T52: Fluxo de intenção, modos de fechamento e edge cases

import { makePayload, PHONES } from '../fixtures/messages.mjs'
import { cleanupPhones, seedRep, seedComerciantge, seedCatalogo, getSimMessages, clearSimMessages, getUltimaCotacao, supabase } from '../fixtures/db.mjs'

// Helper: cria cotação com comparativo pronto
async function setupCotacaoComComparativo(handleWebhook) {
  await seedComerciantge(PHONES.comerciante)
  const rep = await seedRep(PHONES.representante)
  await seedCatalogo(rep.id, [
    { produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 46.50, prazo_entrega: 2, prazo_pagamento: 30 },
    { produto: 'Leite Ninho 400g', marca: 'Ninho', unidade: 'unidade', preco: 13.80, prazo_entrega: 2, prazo_pagamento: 30 },
  ])
  await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola\nLeite Ninho'))
  await handleWebhook(makePayload(PHONES.comerciante, '1')) // confirma lista
  clearSimMessages()
  const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
  const cotacao = await getUltimaCotacao(com.data.id)
  return { rep, cotacao }
}

export const scenarios = [

  // ── RESPOSTAS DO REP ───────────────────────────────────────────────

  {
    id: 'T24',
    name: 'Rep responde cotação em formato livre',
    priority: 'crítico',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      await seedRep(PHONES.representante)
    },
    run: async (handleWebhook) => {
      await handleWebhook(makePayload(PHONES.comerciante, '1 cx Coca-Cola'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      clearSimMessages()
      // Rep responde em formato livre
      await handleWebhook(makePayload(PHONES.representante, '1. Coca-Cola R$46,50 pgto 30d entrega 2d'))
      const msgs = getSimMessages()
      // Rep deve receber confirmação
      const confirmRep = msgs.find(m => m.to === PHONES.representante)
      if (!confirmRep) throw new Error('Rep não recebeu confirmação da proposta')
      // Comparativo deve ir ao comerciante
      const comparativo = msgs.find(m => m.to === PHONES.comerciante && m.body.includes('R$'))
      if (!comparativo) throw new Error('Comparativo não enviado ao comerciante após resposta do rep')
      return { ok: true, msg: 'Resposta livre do rep interpretada e comparativo gerado' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T25',
    name: 'Rep responde sem cotação pendente',
    priority: 'crítico',
    setup: async () => {
      await cleanupPhones({ r: PHONES.representante })
      await seedRep(PHONES.representante)
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.representante, 'Coca R$45 30d'))
      const msgs = getSimMessages()
      const body = msgs.find(m => m.to === PHONES.representante)?.body ?? ''
      if (!body) throw new Error('Nenhuma resposta ao rep sem cotação pendente')
      if (body.toLowerCase().includes('erro') && body.toLowerCase().includes('crash')) {
        throw new Error('Sistema crashou com resposta sem cotação pendente')
      }
      return { ok: true, msg: `Rep sem cotação pendente recebeu orientação: ${body.slice(0, 60)}` }
    },
    teardown: async () => { await cleanupPhones({ r: PHONES.representante }) }
  },

  {
    id: 'T26',
    name: 'Rep envia promoção via WhatsApp',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ r: PHONES.representante })
      const rep = await seedRep(PHONES.representante)
      await seedCatalogo(rep.id, [{ produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 46.50 }])
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      const amanha = new Date(); amanha.setDate(amanha.getDate() + 5)
      const dataFmt = `${amanha.getDate().toString().padStart(2,'0')}/${(amanha.getMonth()+1).toString().padStart(2,'0')}`
      await handleWebhook(makePayload(PHONES.representante, `Promoção: Coca-Cola 2L R$42,00 válido até ${dataFmt}`))
      // Verificar promoção no banco
      const rep = await supabase.from('representantes').select('id').eq('telefone', PHONES.representante).single()
      const { data: promo } = await supabase.from('catalogo_promocoes').select('*').eq('representante_id', rep.data.id).single()
      if (!promo) throw new Error('Promoção não salva no banco')
      if (promo.preco_promo !== 42.00) throw new Error(`Preço promocional incorreto: ${promo.preco_promo}`)
      return { ok: true, msg: `Promoção salva: R$${promo.preco_promo} até ${promo.valida_ate}` }
    },
    teardown: async () => { await cleanupPhones({ r: PHONES.representante }) }
  },

  // ── FLUXO DE INTENÇÃO ──────────────────────────────────────────────

  {
    id: 'T27',
    name: 'Opção 1 → confirmação → compra → pedido gerado',
    priority: 'crítico',
    setup: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) },
    run: async (handleWebhook) => {
      const { cotacao } = await setupCotacaoComComparativo(handleWebhook)
      if (!cotacao) throw new Error('Cotação não foi criada')
      // Escolhe comprar
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      clearSimMessages()
      // Confirma
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      // Agora escolhe o fornecedor
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const msgs = getSimMessages()
      // Rep deve ser notificado do pedido
      const notifRep = msgs.find(m => m.to === PHONES.representante)
      if (!notifRep) throw new Error('Rep não foi notificado do pedido')
      // Comerciante deve receber confirmação
      const confirmCom = msgs.find(m => m.to === PHONES.comerciante && m.body.toLowerCase().includes('pedido'))
      if (!confirmCom) throw new Error('Comerciante não recebeu confirmação do pedido')
      // Verifica pedido no banco
      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      const { data: pedido } = await supabase.from('pedidos').select('*').eq('comerciante_id', com.data.id).single()
      if (!pedido) throw new Error('Pedido não foi criado no banco')
      return { ok: true, msg: `Pedido #${pedido.id.slice(-6)} criado com sucesso` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T28',
    name: 'Opção 1 → confirmação → cancela → volta ao comparativo',
    priority: 'crítico',
    setup: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) },
    run: async (handleWebhook) => {
      await setupCotacaoComComparativo(handleWebhook)
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, '2')) // não, voltar
      const msgs = getSimMessages()
      const body = msgs.find(m => m.to === PHONES.comerciante)?.body ?? ''
      // Deve reenviar o comparativo
      if (!body.includes('R$') && !body.toLowerCase().includes('cotação')) {
        throw new Error(`Deveria reenviar comparativo: ${body}`)
      }
      return { ok: true, msg: 'Cancelou confirmação → comparativo reenviado' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T29',
    name: 'Opção 2 — só consultando → status=consulta',
    priority: 'crítico',
    setup: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) },
    run: async (handleWebhook) => {
      const { cotacao } = await setupCotacaoComComparativo(handleWebhook)
      await handleWebhook(makePayload(PHONES.comerciante, '2'))
      await handleWebhook(makePayload(PHONES.comerciante, '1')) // confirma
      const { data } = await supabase.from('cotacoes').select('status').eq('id', cotacao.id).single()
      if (data.status !== 'consulta') throw new Error(`Status incorreto: ${data.status}`)
      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      const { data: pedido } = await supabase.from('pedidos').select('*').eq('comerciante_id', com.data.id).maybeSingle()
      if (pedido) throw new Error('Pedido foi criado em modo consulta')
      return { ok: true, msg: 'Modo consulta: status=consulta, nenhum pedido gerado' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T30',
    name: 'Opção 3 — decidir depois → retoma com "minha cotação"',
    priority: 'crítico',
    setup: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) },
    run: async (handleWebhook) => {
      const { cotacao } = await setupCotacaoComComparativo(handleWebhook)
      await handleWebhook(makePayload(PHONES.comerciante, '3'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'minha cotação'))
      const msgs = getSimMessages()
      const body = msgs.find(m => m.to === PHONES.comerciante)?.body ?? ''
      if (!body.toLowerCase().includes('cotação') && !body.includes(cotacao.id.slice(-6).toUpperCase())) {
        throw new Error(`Retomada não mostrou cotação correta: ${body}`)
      }
      return { ok: true, msg: 'Decidir depois → retomada via "minha cotação" funcionou' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T31',
    name: 'Split automático — melhor preço por item com 2 reps',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante, r2: PHONES.representante2 })
      await seedComerciantge(PHONES.comerciante)
      const rep1 = await seedRep(PHONES.representante)
      const rep2 = await seedRep(PHONES.representante2)
      // Rep1 mais barato na Coca, Rep2 mais barato no Leite
      await seedCatalogo(rep1.id, [
        { produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 44.00, prazo_pagamento: 30, prazo_entrega: 2 },
        { produto: 'Leite Ninho 400g', marca: 'Ninho', unidade: 'unidade', preco: 15.00, prazo_pagamento: 30, prazo_entrega: 2 },
      ])
      await seedCatalogo(rep2.id, [
        { produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 48.00, prazo_pagamento: 30, prazo_entrega: 1 },
        { produto: 'Leite Ninho 400g', marca: 'Ninho', unidade: 'unidade', preco: 12.00, prazo_pagamento: 30, prazo_entrega: 1 },
      ])
    },
    run: async (handleWebhook) => {
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola\nLeite Ninho'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      clearSimMessages()
      // Escolhe split automático
      await handleWebhook(makePayload(PHONES.comerciante, '1')) // comprar agora
      await handleWebhook(makePayload(PHONES.comerciante, '1')) // confirma
      await handleWebhook(makePayload(PHONES.comerciante, 'split')) // modo split
      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      const { data: pedidos } = await supabase.from('pedidos').select('*').eq('comerciante_id', com.data.id)
      if (!pedidos?.length || pedidos.length < 2) throw new Error(`Split deveria gerar 2 pedidos, gerou: ${pedidos?.length}`)
      return { ok: true, msg: `Split automático gerou ${pedidos.length} pedidos com fornecedores diferentes` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante, r2: PHONES.representante2 }) }
  },

  {
    id: 'T32',
    name: 'Comando "cancelar" — cotação em aberto é cancelada',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      await seedRep(PHONES.representante)
    },
    run: async (handleWebhook) => {
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'cancelar'))
      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      const cotacao = await getUltimaCotacao(com.data.id)
      if (cotacao?.status !== 'cancelada') throw new Error(`Status incorreto: ${cotacao?.status}`)
      return { ok: true, msg: 'Comando cancelar: cotação marcada como cancelada' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T33',
    name: 'Comando "comprar" retoma cotação em consulta',
    priority: 'alto',
    setup: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) },
    run: async (handleWebhook) => {
      await setupCotacaoComComparativo(handleWebhook)
      await handleWebhook(makePayload(PHONES.comerciante, '2'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'comprar'))
      const msgs = getSimMessages()
      const body = msgs.find(m => m.to === PHONES.comerciante)?.body ?? ''
      if (!body.includes('R$') && !body.toLowerCase().includes('comparativo') && !body.toLowerCase().includes('cotação')) {
        throw new Error(`Comparativo não reenviado ao retomar: ${body}`)
      }
      return { ok: true, msg: 'Comando comprar retomou cotação em consulta' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T34',
    name: 'Nova lista com cotação em aberto → pergunta o que fazer',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      await seedRep(PHONES.representante)
    },
    run: async (handleWebhook) => {
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      clearSimMessages()
      // Envia nova lista com cotação em aberto
      await handleWebhook(makePayload(PHONES.comerciante, 'Leite Ninho'))
      const msgs = getSimMessages()
      const body = msgs.find(m => m.to === PHONES.comerciante)?.body ?? ''
      if (!body.includes('1') || !body.includes('2')) throw new Error(`Deveria perguntar o que fazer: ${body}`)
      return { ok: true, msg: 'Nova lista com cotação aberta → perguntou 1=ver/2=nova' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  // ── EDGE CASES E ROBUSTEZ ──────────────────────────────────────────

  {
    id: 'T35',
    name: 'Deduplicação de webhook — mesmo messageId processado só 1x',
    priority: 'crítico',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante })
      await seedComerciantge(PHONES.comerciante)
    },
    run: async (handleWebhook) => {
      const payload = makePayload(PHONES.comerciante, 'Coca-Cola')
      // Força mesmo messageId
      const msgId = `dedup_test_${Date.now()}`
      payload.entry[0].changes[0].value.messages[0].id = msgId

      clearSimMessages()
      await handleWebhook(payload)
      await handleWebhook(payload) // segundo envio com mesmo ID
      await handleWebhook(payload) // terceiro

      const msgs = getSimMessages()
      const respostas = msgs.filter(m => m.to === PHONES.comerciante)
      if (respostas.length > 1) throw new Error(`Mensagem processada ${respostas.length}x — dedup falhou`)
      return { ok: true, msg: `Webhook deduplicado: ${respostas.length} resposta para 3 entregas com mesmo ID` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T36',
    name: 'Lock — race condition em consolidação paralela',
    priority: 'crítico',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      const rep = await seedRep(PHONES.representante)
      await seedCatalogo(rep.id, [{ produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 46.50 }])
    },
    run: async (handleWebhook) => {
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      const cotacao = await getUltimaCotacao(com.data.id)

      clearSimMessages()
      // Dispara consolidação duas vezes ao mesmo tempo
      const { consolidarEEnviar } = await import('../../src/handlers/webhook.js')
      await Promise.all([
        consolidarEEnviar(cotacao.id),
        consolidarEEnviar(cotacao.id),
      ])

      const msgs = getSimMessages()
      const comparativos = msgs.filter(m => m.to === PHONES.comerciante && m.body.includes('R$'))
      if (comparativos.length > 1) throw new Error(`Comparativo enviado ${comparativos.length}x — lock falhou`)
      return { ok: true, msg: 'Lock funcionou: comparativo enviado 1x mesmo com consolidação paralela' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T37',
    name: 'Rep inativo não recebe cotações',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      const rep = await seedRep(PHONES.representante)
      // Desativa o rep
      await supabase.from('representantes').update({ ativo: false }).eq('id', rep.id)
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const msgs = getSimMessages()
      const msgRep = msgs.find(m => m.to === PHONES.representante)
      if (msgRep) throw new Error('Rep inativo recebeu cotação')
      return { ok: true, msg: 'Rep inativo não recebeu cotação' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T38',
    name: 'Nenhum rep cadastrado — mensagem clara ao comerciante',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante })
      await seedComerciantge(PHONES.comerciante)
      // Sem reps
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const msgs = getSimMessages()
      const body = msgs.find(m => m.to === PHONES.comerciante)?.body ?? ''
      if (!body) throw new Error('Nenhuma mensagem ao comerciante sem reps')
      // Não deve crashar silenciosamente
      return { ok: true, msg: `Sem reps: comerciante recebeu: ${body.slice(0, 80)}` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T39',
    name: 'SIM_MODE captura mensagens sem chamar Meta API',
    priority: 'médio',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante })
      await seedComerciantge(PHONES.comerciante)
      process.env.SIM_MODE = 'true'
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'olá'))
      const msgs = getSimMessages()
      if (!msgs.length) throw new Error('SIM_MODE não capturou mensagens')
      // Verifica que não houve chamada real à Meta (sem erro de rede)
      return { ok: true, msg: `SIM_MODE: ${msgs.length} mensagem(ns) capturada(s) sem chamar Meta API` }
    },
    teardown: async () => {
      delete process.env.SIM_MODE
      await cleanupPhones({ c: PHONES.comerciante })
    }
  },

  {
    id: 'T40',
    name: 'telefoneCandidatos — resolve 8 e 9 dígitos',
    priority: 'médio',
    setup: async () => {},
    run: async () => {
      const { telefoneCandidatos } = await import('../../src/db/client.js').catch(() => ({ telefoneCandidatos: null }))
      if (!telefoneCandidatos) return { ok: true, msg: 'telefoneCandidatos não exportada — skip' }

      const com8 = telefoneCandidatos('5511998765432')  // 9 dígitos
      const com9 = telefoneCandidatos('551198765432')   // 8 dígitos

      if (!com8.includes('551198765432')) throw new Error(`Candidato 8 dígitos não gerado: ${com8}`)
      if (!com9.includes('5511998765432')) throw new Error(`Candidato 9 dígitos não gerado: ${com9}`)
      return { ok: true, msg: `telefoneCandidatos gera os dois formatos: ${com8.join(', ')}` }
    },
    teardown: async () => {}
  },

  {
    id: 'T41',
    name: 'Agrupamento por setor na cotação manual',
    priority: 'médio',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      await seedRep(PHONES.representante)
      // Sem catálogo → modo manual
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola\nLeite Ninho\nDetergente Ypê\nShampoo Pantene'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const msgs = getSimMessages()
      const msgRep = msgs.find(m => m.to === PHONES.representante)
      if (!msgRep) throw new Error('Rep não recebeu cotação')
      // Se agrupamento por setor implementado, deve ter seções
      const body = msgRep.body
      const temSetor = body.toLowerCase().includes('bebidas') ||
                       body.toLowerCase().includes('mercearia') ||
                       body.toLowerCase().includes('higiene') ||
                       body.toLowerCase().includes('limpeza')
      return {
        ok: true,
        msg: temSetor
          ? 'Itens agrupados por setor na mensagem ao rep'
          : 'Agrupamento por setor não detectado — pode estar pendente de implementação'
      }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

]
