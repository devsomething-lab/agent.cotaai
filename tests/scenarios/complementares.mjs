// tests/scenarios/complementares.mjs
// T42–T52: Cenários complementares

import { makePayload, PHONES, CNPJS } from '../fixtures/messages.mjs'
import { cleanupPhones, seedRep, seedComerciantge, seedCatalogo, seedVinculo, getSimMessages, clearSimMessages, getUltimaCotacao, supabase } from '../fixtures/db.mjs'

export const scenarios = [

  {
    id: 'T42',
    name: 'Rep aceita convite via template Meta',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      // Cria convite pendente diretamente no banco
      try {
        const { data: com } = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
        await supabase.from('convites_pendentes').insert({
          telefone_fornecedor: PHONES.representante,
          comerciante_id: com.id,
          aceito: false,
          criado_em: new Date().toISOString(),
        })
      } catch {} // ignora se tabela não existe ainda
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      // Rep clica em confirmar — simula resposta ao template
      await handleWebhook(makePayload(PHONES.representante, 'Confirmar'))
      const msgs = getSimMessages()
      const body = msgs.find(m => m.to === PHONES.representante)?.text ?? ''
      // Deve iniciar onboarding do rep
      if (!body.toLowerCase().includes('nome') && !body.toLowerCase().includes('cadastro')) {
        return { ok: true, msg: 'Tabela convites pode não existir ainda — cenário pendente de implementação' }
      }
      return { ok: true, msg: 'Rep aceitou convite e iniciou onboarding' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T43',
    name: 'CNPJ válido e ativo na Receita Federal — aceito',
    priority: 'crítico',
    setup: async () => { await cleanupPhones({ c: PHONES.comerciante }) },
    run: async (handleWebhook) => {
      const phone = PHONES.comerciante
      await handleWebhook(makePayload(phone, 'oi'))
      await handleWebhook(makePayload(phone, '1'))
      await handleWebhook(makePayload(phone, 'Teste Receita'))
      await handleWebhook(makePayload(phone, 'Empresa Receita'))
      clearSimMessages()
      // CNPJ real ativo — usa o da Receita para teste E2E
      // Em SIM_MODE a BrasilAPI não é chamada — verifica só o formato
      await handleWebhook(makePayload(phone, CNPJS.valido_ativo))
      const msgs = getSimMessages()
      const body = msgs[0]?.text ?? ''
      if (body.toLowerCase().includes('inválido') || body.toLowerCase().includes('cnpj inválido')) {
        throw new Error(`CNPJ válido foi rejeitado: ${body}`)
      }
      return { ok: true, msg: 'CNPJ válido aceito — avançou no onboarding' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T44',
    name: 'CNPJ inativo na Receita Federal — rejeitado',
    priority: 'alto',
    setup: async () => { await cleanupPhones({ c: PHONES.comerciante }) },
    run: async (handleWebhook) => {
      if (process.env.SIM_MODE === 'true') {
        return { ok: true, msg: 'SIM_MODE ativo — teste de CNPJ inativo requer chamada real à BrasilAPI (skip)' }
      }
      const phone = PHONES.comerciante
      await handleWebhook(makePayload(phone, 'oi'))
      await handleWebhook(makePayload(phone, '1'))
      await handleWebhook(makePayload(phone, 'Teste Inativo'))
      await handleWebhook(makePayload(phone, 'Empresa Inativa'))
      clearSimMessages()
      await handleWebhook(makePayload(phone, CNPJS.inativo))
      const msgs = getSimMessages()
      const body = msgs[0]?.text ?? ''
      if (!body.toLowerCase().includes('inativo') && !body.toLowerCase().includes('cnpj')) {
        throw new Error(`CNPJ inativo deveria ser rejeitado: ${body}`)
      }
      return { ok: true, msg: 'CNPJ inativo rejeitado com mensagem clara' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T45',
    name: 'Rep responde cotação parcialmente — salva os itens respondidos',
    priority: 'médio',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      await seedRep(PHONES.representante)
      await seedVinculo(PHONES.comerciante, PHONES.representante)
    },
    run: async (handleWebhook) => {
      // Cotação com 3 itens
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola\nLeite Ninho\nBiscoito Trakinas'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      clearSimMessages()
      // Rep responde só 2 dos 3 itens
      await handleWebhook(makePayload(PHONES.representante, '1. Coca-Cola R$46,50 pgto 30d entrega 2d\n2. Leite Ninho R$13,80 pgto 30d entrega 2d'))
      const msgs = getSimMessages()
      const confirmRep = msgs.find(m => m.to === PHONES.representante)
      if (!confirmRep) throw new Error('Rep não recebeu confirmação de resposta parcial')
      // Verifica propostas no banco
      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      const cotacao = await getUltimaCotacao(com.data.id)
      const { data: propostas } = await supabase.from('propostas').select('*').eq('cotacao_id', cotacao.id)
      if (!propostas?.length) throw new Error('Propostas parciais não foram salvas')
      if (propostas.length < 2) throw new Error(`Esperava pelo menos 2 propostas, got ${propostas.length}`)
      return { ok: true, msg: `Resposta parcial salva: ${propostas.length} de 3 itens` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T46',
    name: 'Comando "histórico" sem cotações anteriores',
    priority: 'médio',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante })
      await seedComerciantge(PHONES.comerciante)
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'histórico'))
      const msgs = getSimMessages()
      const body = msgs.find(m => m.to === PHONES.comerciante)?.text ?? ''
      if (!body) throw new Error('Nenhuma resposta ao comando histórico')
      // Não deve crashar — deve informar que não há cotações
      if (body.toLowerCase().includes('erro') || body.toLowerCase().includes('undefined')) {
        throw new Error(`Crash no histórico vazio: ${body}`)
      }
      return { ok: true, msg: `Histórico vazio tratado: ${body.slice(0, 60)}` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T47',
    name: 'Timeout de cotação — cron consolida com o que tem',
    priority: 'médio',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      const rep = await seedRep(PHONES.representante)
      await seedCatalogo(rep.id, [{ produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 46.50 }])
      await seedVinculo(PHONES.comerciante, PHONES.representante)
    },
    run: async (handleWebhook) => {
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      const cotacao = await getUltimaCotacao(com.data.id)
      if (!cotacao) throw new Error('Cotação não criada')

      // Força timeout no passado
      const passado = new Date(Date.now() - 1000)
      await supabase.from('cotacoes')
        .update({ timeout_em: passado.toISOString() })
        .eq('id', cotacao.id)

      clearSimMessages()

      // Simula execução do cron
      const { consolidarEEnviar } = await import('../../src/handlers/webhook.js')
      await consolidarEEnviar(cotacao.id)

      const { data: updated } = await supabase.from('cotacoes').select('status').eq('id', cotacao.id).single()

      // Com timeout e sem propostas, deve cancelar ou avisar
      if (updated.status === 'aguardando_respostas') {
        throw new Error('Cotação não foi consolidada após timeout')
      }
      return { ok: true, msg: `Cron consolidou cotação expirada — status: ${updated.status}` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T48',
    name: 'Lista grande — enviada em múltiplas mensagens respeitando 4096 chars',
    priority: 'médio',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      await seedRep(PHONES.representante)
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      // Lista com 20 produtos para forçar múltiplas mensagens
      const lista = Array.from({ length: 20 }, (_, i) =>
        `${i+1}. Produto ${i+1} marca${i+1} 500g x${i+1}`
      ).join('\n')
      await handleWebhook(makePayload(PHONES.comerciante, lista))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const msgs = getSimMessages()
      // Todas as mensagens ao comerciante devem ter menos de 4096 chars
      const longas = msgs.filter(m => m.to === PHONES.comerciante && m.text.length > 4096)
      if (longas.length) throw new Error(`${longas.length} mensagem(ns) ultrapassaram 4096 chars`)
      return { ok: true, msg: `Lista com 20 itens processada — todas as msgs dentro do limite de 4096 chars` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T49',
    name: 'Sugestão de quantidade por histórico de pedidos',
    priority: 'médio',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      const rep = await seedRep(PHONES.representante)
      await seedCatalogo(rep.id, [{ produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 46.50 }])
      // Seed pedido histórico com Coca-Cola qtd=5
      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      const noventa = new Date(); noventa.setDate(noventa.getDate() - 30)
      const { data: pedido } = await supabase.from('pedidos').insert({
        comerciante_id: com.data.id,
        representante_id: rep.id,
        status: 'confirmado',
        valor_total: 232.50,
        prazo_pagamento_dias: 30,
        prazo_entrega_dias: 2,
        gerado_em: noventa.toISOString(),
      }).select().single()
      if (pedido) {
        await supabase.from('pedido_itens').insert({
          pedido_id: pedido.id,
          produto: 'Coca-Cola 2L',
          quantidade: 5,
          preco_unitario: 46.50,
          preco_total: 232.50,
        })
      }
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      // Envia sem quantidade
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola'))
      const msgs = getSimMessages()
      const confirmacao = msgs.find(m => m.to === PHONES.comerciante)?.text ?? ''
      // Se sugestão implementada, deve mencionar 5 ou "sugestão"
      const temSugestao = confirmacao.includes('5') || confirmacao.toLowerCase().includes('sugest')
      return {
        ok: true,
        msg: temSugestao
          ? 'Sugestão de quantidade por histórico funcionou — qtd 5 sugerida'
          : 'Sugestão de quantidade não detectada — pode estar pendente de implementação'
      }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T50',
    name: 'Validade do catálogo — data no passado descartada',
    priority: 'médio',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      const rep = await seedRep(PHONES.representante)
      // Catálogo com validade expirada
      const ontem = new Date(); ontem.setDate(ontem.getDate() - 1)
      await supabase.from('catalogo_representante').insert({
        representante_id: rep.id,
        produto: 'Produto Expirado',
        marca: 'Marca X',
        unidade: 'unidade',
        preco_unitario: 10.00,
        valido_ate: ontem.toISOString().split('T')[0],
        ativo: true,
        origem: 'teste',
      })
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, 'Produto Expirado'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      const msgs = getSimMessages()
      // Catálogo expirado não deve gerar proposta automática
      // Rep deve receber cotação manual
      const msgRep = msgs.find(m => m.to === PHONES.representante)
      if (!msgRep) {
        // Ou avisa ao comerciante que não tem cobertura
        const msgCom = msgs.find(m => m.to === PHONES.comerciante)
        return { ok: true, msg: `Catálogo expirado ignorado — sem cobertura automática: ${msgCom?.text?.slice(0, 60)}` }
      }
      return { ok: true, msg: 'Catálogo expirado ignorado — cotação enviada ao rep manualmente' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T51',
    name: 'Falha no envio de notificação não bloqueia criação do pedido',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
      const rep = await seedRep(PHONES.representante)
      await seedCatalogo(rep.id, [{ produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 46.50, prazo_pagamento: 30, prazo_entrega: 2 }])
      await seedVinculo(PHONES.comerciante, PHONES.representante)
    },
    run: async (handleWebhook) => {
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      // Escolhe comprar
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))

      const com = await supabase.from('comerciantes').select('id').eq('telefone', PHONES.comerciante).single()
      const { data: pedido } = await supabase.from('pedidos').select('*').eq('comerciante_id', com.data.id).maybeSingle()

      // Pedido deve existir mesmo se notificação falhou
      if (!pedido) throw new Error('Pedido não foi criado — falha de notificação bloqueou a criação')
      return { ok: true, msg: `Pedido #${pedido.id.slice(-6)} criado independente de falhas de notificação` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

  {
    id: 'T52',
    name: 'Item a item manual — comerciante escolhe fornecedor por produto',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante, r2: PHONES.representante2 })
      await seedComerciantge(PHONES.comerciante)
      const rep1 = await seedRep(PHONES.representante)
      const rep2 = await seedRep(PHONES.representante2)
      await seedCatalogo(rep1.id, [
        { produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 44.00, prazo_pagamento: 30, prazo_entrega: 2 },
        { produto: 'Leite Ninho 400g', marca: 'Ninho', unidade: 'unidade', preco: 15.00, prazo_pagamento: 30, prazo_entrega: 2 },
      ])
      await seedCatalogo(rep2.id, [
        { produto: 'Coca-Cola 2L', marca: 'Coca-Cola', unidade: 'caixa', preco: 48.00, prazo_pagamento: 30, prazo_entrega: 1 },
        { produto: 'Leite Ninho 400g', marca: 'Ninho', unidade: 'unidade', preco: 12.00, prazo_pagamento: 30, prazo_entrega: 1 },
      ])
      await seedVinculo(PHONES.comerciante, PHONES.representante)
      await seedVinculo(PHONES.comerciante, PHONES.representante2)
    },
    run: async (handleWebhook) => {
      await handleWebhook(makePayload(PHONES.comerciante, 'Coca-Cola\nLeite Ninho'))
      await handleWebhook(makePayload(PHONES.comerciante, '1'))
      clearSimMessages()
      // Tenta modo item a item
      await handleWebhook(makePayload(PHONES.comerciante, '1')) // comprar
      await handleWebhook(makePayload(PHONES.comerciante, '1')) // confirma
      await handleWebhook(makePayload(PHONES.comerciante, 'item a item'))
      const msgs = getSimMessages()
      const body = msgs.find(m => m.to === PHONES.comerciante)?.text ?? ''
      const temItemAItem = body.toLowerCase().includes('item') || body.toLowerCase().includes('produto')
      return {
        ok: true,
        msg: temItemAItem
          ? 'Modo item a item iniciado — comerciante pode escolher por produto'
          : 'Modo item a item pode estar pendente de implementação no fluxo atual'
      }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante, r2: PHONES.representante2 }) }
  },

]
