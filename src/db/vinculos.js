import { supabase } from './client.js'

// ── Busca vínculos ────────────────────────────────────────────────────

export async function getRepresentantesVinculados(comercianteId) {
  const { data, error } = await supabase
    .from('vinculos')
    .select('representantes(*)')
    .eq('comerciante_id', comercianteId)
    .eq('ativo', true)

  if (error) throw error
  return (data ?? []).map(v => v.representantes).filter(Boolean)
}

export async function getComerciantesVinculados(representanteId) {
  const { data, error } = await supabase
    .from('vinculos')
    .select('comerciantes(*)')
    .eq('representante_id', representanteId)
    .eq('ativo', true)

  if (error) throw error
  return (data ?? []).map(v => v.comerciantes).filter(Boolean)
}

export async function getVinculo(comercianteId, representanteId) {
  const { data } = await supabase
    .from('vinculos')
    .select('*')
    .eq('comerciante_id', comercianteId)
    .eq('representante_id', representanteId)
    .single()
  return data
}

// ── Cria vínculo ──────────────────────────────────────────────────────

export async function criarVinculo(comercianteId, representanteId) {
  const { data, error } = await supabase
    .from('vinculos')
    .upsert({
      comerciante_id:   comercianteId,
      representante_id: representanteId,
      ativo:            true,
    }, { onConflict: 'comerciante_id,representante_id', ignoreDuplicates: false })
    .select()
    .single()

  if (error) throw error
  return data
}

// ── Remove vínculo ────────────────────────────────────────────────────

export async function removerVinculo(comercianteId, representanteId) {
  const { error } = await supabase
    .from('vinculos')
    .update({ ativo: false })
    .eq('comerciante_id', comercianteId)
    .eq('representante_id', representanteId)

  if (error) throw error
}

// ── Busca rep por código de convite ───────────────────────────────────

export async function findRepByCodigoConvite(codigo) {
  const { data } = await supabase
    .from('representantes')
    .select('*')
    .eq('codigo_convite', codigo.toUpperCase())
    .eq('ativo', true)
    .single()
  return data
}

// ── Busca rep por telefone ────────────────────────────────────────────

export async function findRepByTelefone(telefone) {
  const { data } = await supabase
    .from('representantes')
    .select('*')
    .eq('telefone', telefone)
    .eq('ativo', true)
    .single()
  return data
}

// ── Gera e salva código de convite único para o rep ───────────────────

export async function gerarCodigoConvite(representanteId) {
  // Verifica se já tem código
  const { data: rep } = await supabase
    .from('representantes')
    .select('codigo_convite')
    .eq('id', representanteId)
    .single()

  if (rep?.codigo_convite) return rep.codigo_convite

  // Gera código único de 6 chars
  let codigo, tentativas = 0
  do {
    codigo = Math.random().toString(36).substring(2, 8).toUpperCase()
    const { data: existente } = await supabase
      .from('representantes')
      .select('id')
      .eq('codigo_convite', codigo)
      .single()
    if (!existente) break
    tentativas++
  } while (tentativas < 10)

  await supabase
    .from('representantes')
    .update({ codigo_convite: codigo })
    .eq('id', representanteId)

  return codigo
}

// ── Cotações abertas para um rep recém-cadastrado ─────────────────────
// Retorna cotações < 48h que o rep ainda não recebeu

export async function getCotacoesAbertasSemRep(representanteId, horasAtras = 48) {
  const desde = new Date(Date.now() - horasAtras * 3600000).toISOString()

  const { data: jaEnviadas } = await supabase
    .from('cotacao_envios')
    .select('cotacao_id')
    .eq('representante_id', representanteId)

  const idsJaEnviados = (jaEnviadas ?? []).map(e => e.cotacao_id)

  let query = supabase
    .from('cotacoes')
    .select('*, comerciantes(*), cotacao_itens(*)')
    .eq('status', 'aguardando_respostas')
    .gte('criado_em', desde)

  if (idsJaEnviados.length) {
    query = query.not('id', 'in', `(${idsJaEnviados.join(',')})`)
  }

  const { data } = await query
  return data ?? []
}
