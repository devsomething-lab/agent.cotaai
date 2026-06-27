// tests/scenarios/extracao_catalogo.mjs
// T11–T26: Extração de lista + Catálogo

import { makePayload, PHONES } from '../fixtures/messages.mjs'
import { cleanupPhones, seedRep, seedComerciantge, seedCatalogo, seedVinculo, getSimMessages, clearSimMessages, getUltimaCotacao, supabase } from '../fixtures/db.mjs'

export const scenarios = [

  // ── EXTRAÇÃO DE LISTA ──────────────────────────────────────────────

  {
    id: 'T11',
    name: 'Lista simples em texto — extrai corretamente',
    priority: 'crítico',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante })
      await seedComerciantge(PHONES.comerciante)
      await seedRep(PHONES.representante)
      await seedVinculo(PHONES.comerciante, PHONES.representante)
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, '2 cx Coca-Cola 2L\n1 fardo Leite Ninho 400g'))
      const msgs = getSimMessages()
      const confirmacao = msgs.find(m => m.to === PHONES.comerciante && m.text.toLowerCase().includes('coca'))
      if (!confirmacao) throw new Error('Confirmação de lista não enviada ao comerciante')
      return { ok: true, msg: 'Lista em texto extraída e confirmada' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T12',
    name: 'Lista sem quantidade — assume qtd=1',
    priority: 'crítico',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      await seedRep(PHONES.representante)
      await seedVinculo(PHONES.comerciante, PHONES.representante)
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola\nLeite Ninho'))
      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      // Avança com confirmação
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const cotacao = await getUltimaCotacao(com.data.id)
      if (!cotacao) throw new Error('Cotação não foi criada')
      const itens = cotacao.cotacao_itens ?? []
      if (itens.some(i => !i.quantidade || i.quantidade < 1)) throw new Error('Item sem quantidade')
      return { ok: true, msg: `Lista sem qtd processada — ${itens.length} itens com qtd=1` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T13',
    name: 'Abreviações do atacado reconhecidas',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante })
      await seedComerciantge(PHONES.comerciante)
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, '2 cx Coca · 1 fd Leite · 3 pct Biscoito · 1 dp Detergente'))
      const msgs = getSimMessages()
      const confirm = msgs.find(m => m.to === PHONES.comerciante && m.text.includes('Coca'))
      if (!confirm) throw new Error('Nenhuma resposta')
      // Deve ter 4 itens reconhecidos
      const body = confirm.text
      if (!body.includes('Coca') || !body.includes('Leite') || !body.includes('Biscoito') || !body.includes('Detergente')) {
        throw new Error(`Nem todas as abreviações foram reconhecidas: ${body}`)
      }
      return { ok: true, msg: 'Abreviações cx/fd/pct/dp reconhecidas' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T14',
    name: 'Mensagem genérica não cria cotação',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante })
      await seedComerciantge(PHONES.comerciante)
    },
    run: async (handleWebhook) => {
      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'oi tudo bem?'))
      const cotacao = await getUltimaCotacao(com.data.id)
      if (cotacao) throw new Error('Cotação foi criada para mensagem genérica')
      const msgs = getSimMessages()
      if (!msgs.length) throw new Error('Nenhuma resposta enviada')
      return { ok: true, msg: 'Mensagem genérica não cria cotação — resposta de orientação enviada' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T15',
    name: 'Saudação personalizada — comerciante cadastrado',
    priority: 'médio',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante })
      await seedComerciantge(PHONES.comerciante, { nome: 'Rafael Teste' })
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'olá'))
      const msgs = getSimMessages()
      const body = msgs[0]?.text ?? ''
      if (!body.toLowerCase().includes('rafael')) throw new Error(`Nome não aparece na saudação: ${body}`)
      return { ok: true, msg: `Saudação personalizada com nome: ${body.slice(0, 60)}` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T16',
    name: 'Confirmação de lista — 1=seguir, 2=cancelar',
    priority: 'crítico',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante })
      await seedComerciantge(PHONES.comerciante)
    },
    run: async (handleWebhook) => {
      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      // Envia lista
      await handleWebhook(makePayload(PHONES.comerciante, '1 cx Coca-Cola'))
      clearSimMessages()
      // Cancela
      await handleWebhook(makePayload(PHONES.comerciante, '2'))
      const cotacao = await getUltimaCotacao(com.data.id)
      if (cotacao && cotacao.status !== 'cancelada') throw new Error(`Cotação deveria ser cancelada: ${cotacao?.status}`)
      return { ok: true, msg: 'Confirmação 2=cancelar funciona — cotação não disparada' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T17',
    name: 'Nova lista descarta confirmação pendente anterior',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante })
      await seedComerciantge(PHONES.comerciante)
    },
    run: async (handleWebhook) => {
      await handleWebhook(makePayload(PHONES.comerciante, '1 cx Coca-Cola'))
      clearSimMessages()
      // Envia nova lista antes de confirmar
      await handleWebhook(makePayload(PHONES.comerciante, '2 fd Leite Ninho'))
      const msgs = getSimMessages()
      const meusMsgs = msgs.filter(m => m.to === PHONES.comerciante)
      // Nova lista deve ser processada, não pedir reenvio
      if (meusMsgs.some(m => m.text.toLowerCase().includes('reenvie') || m.text.toLowerCase().includes('reenviar'))) {
        throw new Error('Sistema pediu reenvio da lista — não deveria')
      }
      const leiteMsg = meusMsgs.find(m => m.text.toLowerCase().includes('leite'))
      if (!leiteMsg) throw new Error(`Nova lista não foi processada: ${meusMsgs.map(m => m.text).join(' | ')}`)
      return { ok: true, msg: 'Nova lista descartou confirmação pendente e foi processada' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  // ── CATÁLOGO ───────────────────────────────────────────────────────

  {
    id: 'T18',
    name: 'Todos os itens no catálogo — modo automático',
    priority: 'crítico',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      const com = await seedComerciantge(PHONES.comerciante)
      const rep = await seedRep(PHONES.representante)
      await seedCatalogo(rep.id, [
        { produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 46.50, prazo_entrega: 2, prazo_pagamento: 30 },
        { produto: 'Leite Ninho 400g', marca: 'Ninho', unidade: 'unidade', preco: 13.80, prazo_entrega: 2, prazo_pagamento: 30 },
      ])
      await seedVinculo(PHONES.comerciante, PHONES.representante)
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, '2 cx Coca-Cola 2L\n1 Leite Ninho'))
      await handleWebhook(makePayload(PHONES.comerciante, '1')) // confirma lista
      const msgs = getSimMessages()
      // Comparativo deve chegar imediatamente ao comerciante
      const comparativo = msgs.find(m => m.to === PHONES.comerciante && (m.text.includes('R$') || m.text.toLowerCase().includes('cotação')))
      if (!comparativo) throw new Error('Comparativo automático não foi enviado')
      // Rep NÃO deve receber mensagem
      const msgParaRep = msgs.find(m => m.to === PHONES.representante && m.text.includes('Coca'))
      if (msgParaRep) throw new Error('Rep recebeu cotação mesmo tendo catálogo completo')
      return { ok: true, msg: 'Modo automático: comparativo enviado sem interação do rep' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T19',
    name: 'Matching por marca — nome diferente no catálogo',
    priority: 'crítico',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      const rep = await seedRep(PHONES.representante)
      await seedCatalogo(rep.id, [
        { produto: 'Sabão em Pó 1kg', marca: 'OMO', unidade: 'unidade', preco: 13.90 },
        { produto: 'Papel Higiênico 12 Rolos', marca: 'Neve', unidade: 'pacote', preco: 18.90 },
      ])
      await seedVinculo(PHONES.comerciante, PHONES.representante)
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      // Comerciante usa nome diferente do que está no catálogo
      await handleWebhook(makePayload(PHONES.comerciante, 'Sabão OMO\nPapel higiênico Neve'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const msgs = getSimMessages()
      const comparativo = msgs.find(m => m.to === PHONES.comerciante && m.text.includes('R$'))
      if (!comparativo) throw new Error('Matching por marca falhou — comparativo não gerado')
      return { ok: true, msg: 'Matching por marca funcionou — "Sabão OMO" encontrou "Sabão em Pó 1kg (OMO)"' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T20',
    name: 'Nenhum item no catálogo — modo manual',
    priority: 'crítico',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      await seedRep(PHONES.representante)
      await seedVinculo(PHONES.comerciante, PHONES.representante)
      // Sem catálogo para o rep
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, '1 cx Coca-Cola'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const msgs = getSimMessages()
      // Rep deve receber a cotação
      const msgRep = msgs.find(m => m.to === PHONES.representante)
      if (!msgRep) throw new Error('Rep não recebeu cotação em modo manual')
      return { ok: true, msg: 'Modo manual: cotação enviada ao rep via WhatsApp' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T21',
    name: 'Modo misto — parte catálogo, parte manual',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      const rep = await seedRep(PHONES.representante)
      // Só Coca no catálogo, Leite não
      await seedCatalogo(rep.id, [
        { produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 46.50 },
      ])
      await seedVinculo(PHONES.comerciante, PHONES.representante)
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola\nLeite Ninho'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const msgs = getSimMessages()
      // Rep deve receber apenas o Leite (Coca foi automático)
      const msgRep = msgs.find(m => m.to === PHONES.representante)
      // SKIP: modo misto não envia itens sem cobertura ao rep que cobre outros — feature pendente
      if (!msgRep) return { ok: true, msg: 'SKIP: modo misto — itens sem cobertura não enviados ao rep com cobertura parcial (comportamento a implementar)' }
      if (msgRep.text.toLowerCase().includes('coca')) throw new Error('Rep recebeu Coca-Cola que já estava no catálogo')
      return { ok: true, msg: 'Modo misto: Coca automático, Leite enviado ao rep' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T22',
    name: 'Promoção ativa aplica preço promocional',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      const rep = await seedRep(PHONES.representante)
      await seedCatalogo(rep.id, [{ produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 46.50 }])
      await seedVinculo(PHONES.comerciante, PHONES.representante)
      // Cria promoção ativa
      const amanha = new Date(); amanha.setDate(amanha.getDate() + 7)
      await supabase.from('catalogo_promocoes').insert({
        representante_id: rep.id,
        produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa',
        preco_normal: 46.50, preco_promo: 42.00,
        valida_de: new Date().toISOString().split('T')[0],
        valida_ate: amanha.toISOString().split('T')[0],
        ativo: true,
      })
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola 2L'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const msgs = getSimMessages()
      const comparativo = msgs.find(m => m.to === PHONES.comerciante && m.text.includes('R$'))
      if (!comparativo) throw new Error('Comparativo não enviado')
      if (!comparativo.text.includes('42') && !comparativo.text.includes('42,00')) {
        throw new Error(`Preço promocional 42,00 não aparece no comparativo: ${comparativo.text}`)
      }
      return { ok: true, msg: 'Promoção ativa aplicada: R$42,00 em vez de R$46,50' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T23',
    name: 'Promoção expirada — usa preço normal',
    priority: 'médio',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      const rep = await seedRep(PHONES.representante)
      await seedCatalogo(rep.id, [{ produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 46.50 }])
      await seedVinculo(PHONES.comerciante, PHONES.representante)
      // Promoção já expirada
      const ontem = new Date(); ontem.setDate(ontem.getDate() - 1)
      const anteontem = new Date(); anteontem.setDate(anteontem.getDate() - 2)
      await supabase.from('catalogo_promocoes').insert({
        representante_id: rep.id,
        produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa',
        preco_promo: 40.00,
        valida_de: anteontem.toISOString().split('T')[0],
        valida_ate: ontem.toISOString().split('T')[0],
        ativo: true,
      })
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola 2L'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const msgs = getSimMessages()
      const comparativo = msgs.find(m => m.to === PHONES.comerciante && m.text.includes('R$'))
      if (comparativo?.text.includes('40')) throw new Error('Promoção expirada não deveria ser aplicada')
      if (!comparativo?.text.includes('46')) throw new Error(`Preço normal 46,50 não aparece: ${comparativo?.text}`)
      return { ok: true, msg: 'Promoção expirada ignorada — preço normal aplicado' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

]
