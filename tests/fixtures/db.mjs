// tests/fixtures/db.mjs
// Setup e teardown do banco para testes

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'
import { simGetMessages, simClearMessages } from '../../src/services/whatsapp.js'

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

// Apaga todos os dados de teste (por número de telefone)
export async function cleanupPhones(phones) {
  const phoneList = Object.values(phones)

  // Ordem respeitando FK
  const reps = await supabase.from('representantes').select('id').in('telefone', phoneList)
  const coms = await supabase.from('comerciantes').select('id').in('telefone', phoneList)

  const repIds = (reps.data ?? []).map(r => r.id)
  const comIds = (coms.data ?? []).map(c => c.id)

  if (comIds.length) try { await supabase.from('vinculos').delete().in('comerciante_id', comIds) } catch {}
  if (repIds.length) try { await supabase.from('vinculos').delete().in('representante_id', repIds) } catch {}

  if (repIds.length) {
    await supabase.from('catalogo_historico').delete().in('representante_id', repIds)
    await supabase.from('catalogo_promocoes').delete().in('representante_id', repIds)
    await supabase.from('catalogo_representante').delete().in('representante_id', repIds)
  }

  const cotIds = comIds.length
    ? (await supabase.from('cotacoes').select('id').in('comerciante_id', comIds)).data?.map(c => c.id) ?? []
    : []

  if (cotIds.length) {
    const envIds = (await supabase.from('cotacao_envios').select('id').in('cotacao_id', cotIds)).data?.map(e => e.id) ?? []
    if (envIds.length) await supabase.from('propostas').delete().in('cotacao_envio_id', envIds)
    await supabase.from('cotacao_envios').delete().in('cotacao_id', cotIds)
    await supabase.from('cotacao_itens').delete().in('cotacao_id', cotIds)
    const pedIds = (await supabase.from('pedidos').select('id').in('cotacao_id', cotIds)).data?.map(p => p.id) ?? []
    if (pedIds.length) await supabase.from('pedido_itens').delete().in('pedido_id', pedIds)
    await supabase.from('pedidos').delete().in('cotacao_id', cotIds)
    await supabase.from('cotacoes').delete().in('id', cotIds)
  }

  await supabase.from('onboarding_sessoes').delete().in('telefone', phoneList)
  await supabase.from('representantes').delete().in('telefone', phoneList)
  await supabase.from('comerciantes').delete().in('telefone', phoneList)
  try { await supabase.from('convites_pendentes').delete().in('telefone_fornecedor', phoneList) } catch {}
}

// Cria rep de teste diretamente no banco
export async function seedRep(phone, { nome = 'Rep Teste', empresa = 'Dist Teste', prazo_entrega = 2, prazo_pagamento = 30 } = {}) {
  const { data, error } = await supabase.from('representantes').upsert({
    nome, empresa, telefone: phone,
    prazo_entrega_padrao_dias: prazo_entrega,
    prazo_pagamento_padrao_dias: prazo_pagamento,
    ativo: true,
  }, { onConflict: 'telefone' }).select().single()
  if (error) throw error
  return data
}

// Cria comerciante de teste diretamente no banco
export async function seedComerciantge(phone, { nome = 'Comerciante Teste', empresa = 'Mercado Teste', cnpj = '11222333000181' } = {}) {
  const { data, error } = await supabase.from('comerciantes').upsert({
    nome, empresa, cnpj, telefone: phone, ativo: true,
  }, { onConflict: 'telefone' }).select().single()
  if (error) throw error
  return data
}

// Cria catálogo de teste
export async function seedCatalogo(repId, itens) {
  for (const item of itens) {
    await supabase.from('catalogo_representante').upsert({
      representante_id: repId,
      produto: item.produto,
      marca: item.marca ?? null,
      unidade: item.unidade ?? 'unidade',
      preco_unitario: item.preco,
      prazo_pagamento_dias: item.prazo_pagamento ?? 30,
      prazo_entrega_dias: item.prazo_entrega ?? 2,
      ativo: true,
      origem: 'teste',
    }, { onConflict: 'representante_id,produto,unidade' })
  }
}

// Cria vínculo entre comerciante e rep (por telefone)
export async function seedVinculo(comPhone, repPhone) {
  const { data: com } = await supabase.from('comerciantes').select('id').eq('telefone', comPhone).single()
  const { data: rep } = await supabase.from('representantes').select('id').eq('telefone', repPhone).single()
  if (!com || !rep) throw new Error(`seedVinculo: não encontrou com(${comPhone}) ou rep(${repPhone})`)
  await supabase.from('vinculos').upsert(
    { comerciante_id: com.id, representante_id: rep.id, ativo: true },
    { onConflict: 'comerciante_id,representante_id' }
  )
}

// Busca última cotação do comerciante
export async function getUltimaCotacao(comercianteId) {
  const { data } = await supabase
    .from('cotacoes')
    .select('*, cotacao_itens(*), cotacao_envios(*)')
    .eq('comerciante_id', comercianteId)
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()
  return data
}

// Busca mensagens capturadas em SIM_MODE
export function getSimMessages() {
  return simGetMessages()
}

export function clearSimMessages() {
  simClearMessages()
}
