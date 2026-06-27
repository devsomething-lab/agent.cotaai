// tests/scenarios/onboarding.mjs
// T01–T10: Onboarding e cadastro

import { makePayload, PHONES, CNPJS } from '../fixtures/messages.mjs'
import { cleanupPhones, seedRep, seedComerciantge, getSimMessages, clearSimMessages, supabase } from '../fixtures/db.mjs'

export const scenarios = [

  {
    id: 'T01',
    name: 'Número novo — seleção de perfil',
    priority: 'crítico',
    setup: async () => { await cleanupPhones({ d: PHONES.desconhecido }) },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.desconhecido, 'oi'))
      const msgs = getSimMessages()
      if (!msgs.length) throw new Error('Nenhuma mensagem enviada')
      const body = msgs[0].text
      if (!body.includes('1') || !body.includes('2')) throw new Error(`Menu de perfil não encontrado: ${body}`)
      return { ok: true, msg: 'Menu de seleção de perfil enviado corretamente' }
    },
    teardown: async () => { await cleanupPhones({ d: PHONES.desconhecido }) }
  },

  {
    id: 'T02',
    name: 'Resposta inválida no menu de perfil',
    priority: 'alto',
    setup: async () => { await cleanupPhones({ d: PHONES.desconhecido }) },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.desconhecido, 'oi'))
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.desconhecido, 'talvez'))
      const msgs = getSimMessages()
      if (!msgs.length) throw new Error('Nenhuma mensagem enviada')
      const body = msgs[0].text
      if (!body.includes('1') || !body.includes('2')) throw new Error(`Deveria repedir a escolha: ${body}`)
      return { ok: true, msg: 'Resposta inválida tratada — menu reenviado' }
    },
    teardown: async () => { await cleanupPhones({ d: PHONES.desconhecido }) }
  },

  {
    id: 'T03',
    name: 'Onboarding comerciante completo',
    priority: 'crítico',
    setup: async () => { await cleanupPhones({ c: PHONES.comerciante }) },
    run: async (handleWebhook) => {
      const phone = PHONES.comerciante
      clearSimMessages()
      // Seleciona perfil comerciante
      await handleWebhook(makePayload(phone, 'oi'))
      await handleWebhook(makePayload(phone, '1'))
      // Nome
      await handleWebhook(makePayload(phone, 'João Silva'))
      // Empresa
      await handleWebhook(makePayload(phone, 'Mercado São João'))
      // CNPJ
      await handleWebhook(makePayload(phone, CNPJS.valido_ativo))
      // Confirma
      await handleWebhook(makePayload(phone, '1'))

      const { data } = await supabase.from('comerciantes').select('*').eq('telefone', phone).single()
      if (!data) throw new Error('Comerciante não foi persistido no banco')
      if (!data.nome || !data.empresa || !data.cnpj) throw new Error(`Dados incompletos: ${JSON.stringify(data)}`)

      const msgs = getSimMessages()
      const ultima = msgs[msgs.length - 1]?.text ?? ''
      if (!ultima.toLowerCase().includes('conclu') && !ultima.toLowerCase().includes('cadastr') && !ultima.toLowerCase().includes('fornecedor')) {
        throw new Error(`Mensagem de conclusão não encontrada: ${ultima}`)
      }
      return { ok: true, msg: `Comerciante cadastrado: ${data.nome} · ${data.empresa}` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T04',
    name: 'Onboarding representante completo',
    priority: 'crítico',
    setup: async () => { await cleanupPhones({ r: PHONES.representante }) },
    run: async (handleWebhook) => {
      const phone = PHONES.representante
      clearSimMessages()
      await handleWebhook(makePayload(phone, 'oi'))
      await handleWebhook(makePayload(phone, '2'))
      await handleWebhook(makePayload(phone, 'Pedro Muegge'))
      await handleWebhook(makePayload(phone, 'PM Representações'))
      await handleWebhook(makePayload(phone, CNPJS.valido_ativo))
      await handleWebhook(makePayload(phone, '2'))  // prazo entrega
      await handleWebhook(makePayload(phone, '30')) // prazo pagamento
      await handleWebhook(makePayload(phone, '1'))  // confirma

      const { data } = await supabase.from('representantes').select('*').eq('telefone', phone).single()
      if (!data) throw new Error('Representante não foi persistido')
      if (data.prazo_entrega_padrao_dias !== 2) throw new Error(`Prazo entrega incorreto: ${data.prazo_entrega_padrao_dias}`)
      if (data.prazo_pagamento_padrao_dias !== 30) throw new Error(`Prazo pgto incorreto: ${data.prazo_pagamento_padrao_dias}`)
      return { ok: true, msg: `Rep cadastrado: ${data.nome} · entrega ${data.prazo_entrega_padrao_dias}d · pgto ${data.prazo_pagamento_padrao_dias}d` }
    },
    teardown: async () => { await cleanupPhones({ r: PHONES.representante }) }
  },

  {
    id: 'T05',
    name: 'Keyword CADASTRO vai direto para onboarding de rep',
    priority: 'alto',
    setup: async () => { await cleanupPhones({ r: PHONES.representante }) },
    run: async (handleWebhook) => {
      const phone = PHONES.representante
      clearSimMessages()
      await handleWebhook(makePayload(phone, 'CADASTRO'))
      const msgs = getSimMessages()
      const body = msgs[0]?.text ?? ''
      // Deve perguntar o nome diretamente — sem menu de perfil
      if (body.includes('Sou comerciante') || body.includes('Sou representante')) {
        throw new Error('CADASTRO não deveria mostrar menu de perfil')
      }
      if (!body.toLowerCase().includes('nome')) throw new Error(`Deveria pedir nome: ${body}`)
      return { ok: true, msg: 'CADASTRO inicia onboarding de rep diretamente' }
    },
    teardown: async () => { await cleanupPhones({ r: PHONES.representante }) }
  },

  {
    id: 'T06',
    name: 'Rep existente manda CADASTRO — não reinicia onboarding',
    priority: 'médio',
    setup: async () => { await seedRep(PHONES.representante) },
    run: async (handleWebhook) => {
      const phone = PHONES.representante
      clearSimMessages()
      await handleWebhook(makePayload(phone, 'CADASTRO'))
      const msgs = getSimMessages()
      const body = msgs[0]?.text ?? ''
      if (body.toLowerCase().includes('nome') && body.toLowerCase().includes('empresa')) {
        throw new Error('Rep existente não deveria reiniciar onboarding')
      }
      return { ok: true, msg: 'Rep existente não reinicia onboarding ao mandar CADASTRO' }
    },
    teardown: async () => { await cleanupPhones({ r: PHONES.representante }) }
  },

  {
    id: 'T07',
    name: 'Validação CNPJ — formato inválido rejeitado',
    priority: 'alto',
    setup: async () => { await cleanupPhones({ c: PHONES.comerciante }) },
    run: async (handleWebhook) => {
      const phone = PHONES.comerciante
      await handleWebhook(makePayload(phone, 'oi'))
      await handleWebhook(makePayload(phone, '1'))
      await handleWebhook(makePayload(phone, 'Teste'))
      await handleWebhook(makePayload(phone, 'Empresa Teste'))
      clearSimMessages()
      await handleWebhook(makePayload(phone, CNPJS.formato_invalido))
      const msgs = getSimMessages()
      const body = msgs[0]?.text ?? ''
      if (!body.toLowerCase().includes('cnpj') || !body.toLowerCase().includes('inv')) {
        throw new Error(`CNPJ inválido deveria ser rejeitado: ${body}`)
      }
      return { ok: true, msg: 'CNPJ com formato inválido rejeitado corretamente' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T08',
    name: 'Validação CNPJ — dígitos verificadores errados',
    priority: 'alto',
    setup: async () => { await cleanupPhones({ c: PHONES.comerciante }) },
    run: async (handleWebhook) => {
      const phone = PHONES.comerciante
      await handleWebhook(makePayload(phone, 'oi'))
      await handleWebhook(makePayload(phone, '1'))
      await handleWebhook(makePayload(phone, 'Teste'))
      await handleWebhook(makePayload(phone, 'Empresa Teste'))
      clearSimMessages()
      await handleWebhook(makePayload(phone, CNPJS.digito_errado))
      const msgs = getSimMessages()
      const body = msgs[0]?.text ?? ''
      if (!body.toLowerCase().includes('cnpj')) throw new Error(`Deveria rejeitar CNPJ: ${body}`)
      return { ok: true, msg: 'CNPJ com dígito verificador errado rejeitado' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T09',
    name: 'Validação CNPJ — BrasilAPI timeout → fallback aceita',
    priority: 'alto',
    setup: async () => { await cleanupPhones({ c: PHONES.comerciante }) },
    run: async (handleWebhook) => {
      // Simula timeout da BrasilAPI via env
      const original = process.env.BRASILAPI_TIMEOUT
      process.env.BRASILAPI_TIMEOUT = '1' // 1ms = sempre timeout

      const phone = PHONES.comerciante
      await handleWebhook(makePayload(phone, 'oi'))
      await handleWebhook(makePayload(phone, '1'))
      await handleWebhook(makePayload(phone, 'Teste'))
      await handleWebhook(makePayload(phone, 'Empresa Teste'))
      clearSimMessages()
      await handleWebhook(makePayload(phone, CNPJS.valido_ativo))
      const msgs = getSimMessages()
      const body = msgs[0]?.text ?? ''

      process.env.BRASILAPI_TIMEOUT = original

      // Com timeout, deve aceitar pelo formato e avançar
      if (body.toLowerCase().includes('inválido')) {
        throw new Error(`Com timeout da BrasilAPI, deveria aceitar CNPJ pelo formato: ${body}`)
      }
      return { ok: true, msg: 'Timeout da BrasilAPI → fallback gracioso aceita CNPJ pelo formato' }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante }) }
  },

  {
    id: 'T10',
    name: 'Convite de rep pelo comerciante',
    priority: 'alto',
    setup: async () => {
      await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante })
      await seedComerciantge(PHONES.comerciante)
    },
    run: async (handleWebhook) => {
      clearSimMessages()
      await handleWebhook(makePayload(PHONES.comerciante, `adicionar fornecedor ${PHONES.representante}`))
      const msgs = getSimMessages()
      // Deve ter disparado mensagem para o rep
      const msgParaRep = msgs.find(m => m.to === PHONES.representante)
      if (!msgParaRep) throw new Error('Convite não foi enviado para o rep')
      // Verifica convite no banco
      const { data } = await supabase.from('convites_pendentes').select('*').eq('telefone_fornecedor', PHONES.representante).single()
      if (!data) throw new Error('Convite não foi salvo no banco')
      return { ok: true, msg: `Convite criado e enviado para ${PHONES.representante}` }
    },
    teardown: async () => { await cleanupPhones({ c: PHONES.comerciante, r: PHONES.representante }) }
  },

]
