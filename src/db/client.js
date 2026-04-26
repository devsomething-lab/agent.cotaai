import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

// ── Comerciantes ──────────────────────────────────────────────────────

export async function findOrCreateComercianteByTelefone(telefone, nome = null) {
  const { data } = await supabase
    .from('comerciantes')
    .select('*')
    .eq('telefone', telefone)
    .single()

  if (data) return data

  const { data: novo, error } = await supabase
    .from('comerciantes')
    .insert({ telefone, nome: nome ?? telefone })
    .select()
    .single()

  if (error) throw error
  return novo
}

// ── Representantes ────────────────────────────────────────────────────

export async function findRepresentanteByTelefone(telefone) {
  const { data } = await supabase
    .from('representantes')
    .select('*')           // inclui prazo_entrega_padrao_dias e prazo_pagamento_padrao_dias
    .eq('telefone', telefone)
    .single()
  return data
}

export async function getAllRepresentantesAtivos() {
  const { data, error } = await supabase
    .from('representantes')
    .select('*')           // inclui campos de prazo padrão
    .eq('ativo', true)
    .order('nome')
  if (error) throw error
  return data
}

/**
 * Resolve o prazo de entrega com hierarquia:
 * 1. Valor informado na proposta/cotação (proposta ou catálogo)
 * 2. Prazo padrão do cadastro do representante
 * 3. Fallback fixo
 */
export function resolverPrazoEntrega(prazoInformado, rep, fallback = 3) {
  return prazoInformado ?? rep?.prazo_entrega_padrao_dias ?? fallback
}

export function resolverPrazoPagamento(prazoInformado, rep, fallback = 30) {
  return prazoInformado ?? rep?.prazo_pagamento_padrao_dias ?? fallback
}

// ── Cotações ──────────────────────────────────────────────────────────

export async function getCotacaoComItens(cotacaoId) {
  const [{ data: cotacao }, { data: itens }, { data: envios }] = await Promise.all([
    supabase.from('cotacoes').select('*, comerciantes(*)').eq('id', cotacaoId).single(),
    supabase.from('cotacao_itens').select('*').eq('cotacao_id', cotacaoId).order('ordem'),
    supabase.from('cotacao_envios').select('*, representantes(*)').eq('cotacao_id', cotacaoId),
  ])
  return { cotacao, itens, envios }
}

export async function getPropostasDaCotacao(cotacaoId) {
  const { data, error } = await supabase
    .from('propostas')
    .select('*, representantes(nome, empresa, telefone, prazo_entrega_padrao_dias, prazo_pagamento_padrao_dias)')
    .eq('cotacao_id', cotacaoId)
  if (error) throw error
  return data
}

export async function getCotacaoPendentePorTelefone(telefoneRep) {
  const rep = await findRepresentanteByTelefone(telefoneRep)
  if (!rep) return null

  const { data } = await supabase
    .from('cotacao_envios')
    .select('*, cotacoes(*)')
    .eq('representante_id', rep.id)
    .eq('status', 'aguardando')
    .order('enviado_em', { ascending: false })
    .limit(1)
    .single()

  return data
}
