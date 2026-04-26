import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import 'dotenv/config'

import { handleWebhook, consolidarEEnviar } from './handlers/webhook.js'
import { supabase, getAllRepresentantesAtivos } from './db/client.js'
import cron from 'node-cron'
import * as XLSX from 'xlsx'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }) // 10MB

// ── Webhook Meta Cloud API ────────────────────────────────────────────
// GET: verificação (handshake inicial obrigatório pela Meta)
app.get("/webhook", async (req, reply) => {
  const mode      = req.query["hub.mode"]
  const token     = req.query["hub.verify_token"]
  const challenge = req.query["hub.challenge"]
  if (mode === "subscribe" && token === process.env.WEBHOOK_SECRET) {
    app.log.info("[webhook] Meta verificação OK")
    return reply.code(200).send(challenge)
  }
  return reply.code(403).send("Forbidden")
})

// POST: recebe mensagens e eventos
app.post("/webhook", async (req, reply) => {
  try {
    const result = await handleWebhook(req.body)
    return reply.code(200).send(result)
  } catch (err) {
    app.log.error(err)
    return reply.code(200).send({ ok: false, error: err.message })
  }
})

// ── API Dashboard ─────────────────────────────────────────────────────

// Lista cotações (com filtros)
app.get('/api/cotacoes', async (req, reply) => {
  const { status, comerciante_id, limit = 50, offset = 0 } = req.query

  let query = supabase
    .from('cotacoes')
    .select(`
      *,
      comerciantes(nome, telefone),
      cotacao_itens(count),
      cotacao_envios(count)
    `)
    .order('criado_em', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('status', status)
  if (comerciante_id) query = query.eq('comerciante_id', comerciante_id)

  const { data, error, count } = await query
  if (error) return reply.code(500).send(error)
  return reply.send({ data, count })
})

// Detalhe de uma cotação com propostas
app.get('/api/cotacoes/:id', async (req, reply) => {
  const { id } = req.params

  const [{ data: cotacao }, { data: itens }, { data: envios }, { data: propostas }, { data: pedido }] = await Promise.all([
    supabase.from('cotacoes').select('*, comerciantes(*)').eq('id', id).single(),
    supabase.from('cotacao_itens').select('*').eq('cotacao_id', id).order('ordem'),
    supabase.from('cotacao_envios').select('*, representantes(*)').eq('cotacao_id', id),
    supabase.from('propostas').select('*, representantes(nome, empresa, telefone)').eq('cotacao_id', id),
    supabase.from('pedidos').select('*, pedido_itens(*), representantes(nome, empresa, telefone)').eq('cotacao_id', id).limit(1).single(),
  ])

  return reply.send({ cotacao, itens, envios, propostas, pedido: pedido ?? null })
})

// Força consolidação manual de uma cotação
app.post('/api/cotacoes/:id/consolidar', async (req, reply) => {
  const { id } = req.params
  try {
    await consolidarEEnviar(id)
    return reply.send({ ok: true })
  } catch (err) {
    return reply.code(500).send({ error: err.message })
  }
})

// Pedidos
app.get('/api/pedidos', async (req, reply) => {
  const { representante_id, limit = 50, offset = 0 } = req.query

  let query = supabase
    .from('pedidos')
    .select('*, comerciantes(nome, telefone), representantes(nome, empresa), pedido_itens(*)')
    .order('gerado_em', { ascending: false })
    .range(offset, offset + limit - 1)

  if (representante_id) query = query.eq('representante_id', representante_id)

  const { data, error } = await query
  if (error) return reply.code(500).send(error)
  return reply.send({ data })
})

// Representantes
app.get('/api/representantes', async (req, reply) => {
  const { data, error } = await supabase.from('representantes').select('*').order('nome')
  if (error) return reply.code(500).send(error)
  return reply.send({ data })
})

app.post('/api/representantes', async (req, reply) => {
  const { nome, empresa, telefone } = req.body
  const { data, error } = await supabase.from('representantes').insert({ nome, empresa, telefone }).select().single()
  if (error) return reply.code(400).send(error)
  return reply.code(201).send(data)
})

app.patch('/api/representantes/:id', async (req, reply) => {
  const { id } = req.params
  const { data, error } = await supabase.from('representantes').update(req.body).eq('id', id).select().single()
  if (error) return reply.code(400).send(error)
  return reply.send(data)
})

// Comerciantes
app.get('/api/comerciantes', async (req, reply) => {
  const { data, error } = await supabase.from('comerciantes').select('*').order('nome')
  if (error) return reply.code(500).send(error)
  return reply.send({ data })
})

// Dashboard stats
app.get('/api/stats', async (req, reply) => {
  const [
    { count: totalCotacoes },
    { count: cotacoesAbertas },
    { count: pedidosGerados },
    { data: tempoMedioData },
  ] = await Promise.all([
    supabase.from('cotacoes').select('*', { count: 'exact', head: true }),
    supabase.from('cotacoes').select('*', { count: 'exact', head: true }).in('status', ['aguardando_respostas', 'aguardando_escolha']),
    supabase.from('pedidos').select('*', { count: 'exact', head: true }),
    supabase.from('cotacao_envios').select('enviado_em, respondido_em').eq('status', 'respondido').limit(100),
  ])

  // Tempo médio de resposta dos representantes
  let tempoMedioHoras = null
  if (tempoMedioData?.length) {
    const tempos = tempoMedioData
      .filter(e => e.enviado_em && e.respondido_em)
      .map(e => (new Date(e.respondido_em) - new Date(e.enviado_em)) / 3600000)
    if (tempos.length) tempoMedioHoras = (tempos.reduce((a, b) => a + b, 0) / tempos.length).toFixed(1)
  }

  return reply.send({
    totalCotacoes,
    cotacoesAbertas,
    pedidosGerados,
    tempoMedioRespostaHoras: tempoMedioHoras,
  })
})

// Histórico de preços por produto
app.get('/api/historico/produto', async (req, reply) => {
  const { produto } = req.query
  if (!produto) return reply.code(400).send({ error: 'produto obrigatório' })

  const { data, error } = await supabase
    .from('propostas')
    .select('preco_unitario, criado_em, representantes(nome, empresa), cotacoes(fechado_em)')
    .ilike('produto', `%${produto}%`)
    .order('criado_em', { ascending: false })
    .limit(100)

  if (error) return reply.code(500).send(error)
  return reply.send({ data })
})

// ── Cron: verifica cotações com timeout vencido ───────────────────────

cron.schedule('*/30 * * * *', async () => {
  const { data: vencidas } = await supabase
    .from('cotacoes')
    .select('id')
    .eq('status', 'aguardando_respostas')
    .lt('timeout_em', new Date().toISOString())

  for (const c of vencidas ?? []) {
    app.log.info(`[cron] consolidando cotação vencida ${c.id}`)
    try {
      await consolidarEEnviar(c.id)
    } catch (err) {
      app.log.error(`[cron] erro ao consolidar ${c.id}: ${err.message}`)
    }
  }
})

// ── Start ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3000')
try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`\n🚀 CotAI backend rodando na porta ${PORT}`)
  console.log(`   Webhook: POST /webhook`)
  console.log(`   Dashboard API: GET /api/cotacoes\n`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
