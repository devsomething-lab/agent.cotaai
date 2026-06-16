/**
 * Kota – Test Runner com análise por IA
 *
 * Uso:
 *   node test/runner.mjs                   → roda todos os cenários
 *   node test/runner.mjs onboarding        → roda cenário específico
 *   node test/runner.mjs --no-ai           → sem análise da IA
 *
 * Requisitos:
 *   - Servidor rodando localmente: npm run dev
 *   - .env com ANTHROPIC_API_KEY e variáveis do Supabase
 */

import { spawn } from 'child_process'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import 'dotenv/config'

const BASE_URL  = process.env.TEST_URL ?? 'http://localhost:3000'
const USE_AI    = !process.argv.includes('--no-ai')
const FILTRO    = process.argv.slice(2).find(a => !a.startsWith('-') && !a.includes('/'))

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Telefones de teste (não são números reais) ────────────────────────
const FONES = {
  comerciante:    '5500000000001',
  representante:  '5500000000002',
  representante2: '5500000000003',
}

// ── Helpers ───────────────────────────────────────────────────────────

function payload(de, texto, tipo = 'text') {
  const msg = tipo === 'button'
    ? { from: de, type: 'button', button: { text: texto, payload: texto } }
    : { from: de, type: 'text', text: { body: texto } }
  return {
    entry: [{ changes: [{ value: { messages: [msg], contacts: [{ wa_id: de, profile: { name: `Test ${de.slice(-4)}` } }] } }] }]
  }
}

async function msg(de, texto, tipo = 'text') {
  const res = await fetch(`${BASE_URL}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload(de, texto, tipo)),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function limparDadosTeste() {
  const fones = Object.values(FONES)
  await supabase.from('pedidos').delete().in('comerciante_id',
    (await supabase.from('comerciantes').select('id').in('telefone', fones)).data?.map(r => r.id) ?? [])
  await supabase.from('cotacoes').delete().in('comerciante_id',
    (await supabase.from('comerciantes').select('id').in('telefone', fones)).data?.map(r => r.id) ?? [])
  await supabase.from('vinculos').delete().in('comerciante_id',
    (await supabase.from('comerciantes').select('id').in('telefone', fones)).data?.map(r => r.id) ?? [])
  await supabase.from('convites_pendentes').delete().in('telefone_fornecedor', fones)
  await supabase.from('onboarding_sessoes').delete().in('telefone', fones)
  await supabase.from('representantes').delete().in('telefone', fones)
  await supabase.from('comerciantes').delete().in('telefone', fones)
  console.log('  🧹 Dados de teste removidos\n')
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Log collector ─────────────────────────────────────────────────────

class LogCollector {
  constructor() { this.logs = [] }

  add(source, content) {
    this.logs.push({ ts: new Date().toISOString().slice(11, 19), source, content })
    const icon = source === 'ERRO' ? '❌' : source === 'RESP' ? '↩' : '→'
    console.log(`  ${icon} [${source}] ${content}`)
  }

  resumo() { return this.logs.map(l => `[${l.ts}] [${l.source}] ${l.content}`).join('\n') }
}

// ── Cenários ──────────────────────────────────────────────────────────

const CENARIOS = {

  // ── 1. Onboarding comerciante ──────────────────────────────────────
  onboarding_comerciante: {
    descricao: 'Comerciante realiza cadastro completo',
    esperado: 'Sessão concluída, comerciante salvo no banco com nome e empresa',
    passos: async (log) => {
      log.add('MSG', `[comerciante] "ola"`)
      await msg(FONES.comerciante, 'ola'); await sleep(800)

      log.add('MSG', `[comerciante] "1" (sou comerciante)`)
      await msg(FONES.comerciante, '1'); await sleep(800)

      log.add('MSG', `[comerciante] "Pedro Teste"`)
      await msg(FONES.comerciante, 'Pedro Teste'); await sleep(800)

      log.add('MSG', `[comerciante] "Mercado Teste"`)
      await msg(FONES.comerciante, 'Mercado Teste'); await sleep(800)

      log.add('MSG', `[comerciante] "11.222.333/0001-81"`)
      await msg(FONES.comerciante, '11.222.333/0001-81'); await sleep(800)

      log.add('MSG', `[comerciante] "1" (confirmar)`)
      await msg(FONES.comerciante, '1'); await sleep(2000)

      // Valida banco
      const { data: com } = await supabase.from('comerciantes').select('*').eq('telefone', FONES.comerciante).single()
      if (com?.empresa) {
        log.add('OK', `Comerciante salvo: ${com.nome} / ${com.empresa}`)
        return { sucesso: true, dados: com }
      } else {
        log.add('ERRO', `Comerciante não encontrado ou sem empresa no banco`)
        return { sucesso: false, dados: com }
      }
    },
  },

  // ── 2. Onboarding representante via convite ────────────────────────
  onboarding_representante_convite: {
    descricao: 'Comerciante convida representante, representante confirma e se cadastra',
    esperado: 'Vínculo criado, comerciante recebe confirmação',
    depende_de: 'onboarding_comerciante',
    passos: async (log) => {
      // Comerciante envia número do rep
      log.add('MSG', `[comerciante] "${FONES.representante.slice(2)}" (número do rep)`)
      await msg(FONES.comerciante, FONES.representante.slice(2)); await sleep(1000)

      // Verifica convite no banco
      const { data: convite } = await supabase.from('convites_pendentes')
        .select('*').eq('aceito', false).limit(1).single()
      if (!convite) {
        log.add('ERRO', 'Convite não encontrado no banco após envio')
        return { sucesso: false }
      }
      log.add('OK', `Convite criado para ${convite.telefone_fornecedor}`)

      // Rep clica Confirmar (button click)
      log.add('MSG', `[representante] "Confirmar" (botão template)`)
      await msg(FONES.representante, 'Confirmar', 'button'); await sleep(800)

      log.add('MSG', `[representante] "Eduardo Teste"`)
      await msg(FONES.representante, 'Eduardo Teste'); await sleep(800)

      log.add('MSG', `[representante] "Distribuidora Teste"`)
      await msg(FONES.representante, 'Distribuidora Teste'); await sleep(800)

      log.add('MSG', `[representante] "11.222.333/0001-81"`)
      await msg(FONES.representante, '11.222.333/0001-81'); await sleep(800)

      log.add('MSG', `[representante] "5" (prazo entrega)`)
      await msg(FONES.representante, '5'); await sleep(800)

      log.add('MSG', `[representante] "30" (prazo pagamento)`)
      await msg(FONES.representante, '30'); await sleep(800)

      log.add('MSG', `[representante] "1" (confirmar)`)
      await msg(FONES.representante, '1'); await sleep(1500)

      // Valida vínculo
      const { data: rep } = await supabase.from('representantes').select('*').eq('telefone', FONES.representante).single()
      const { data: com } = await supabase.from('comerciantes').select('id').eq('telefone', FONES.comerciante).single()
      const { data: vinculo } = com?.id && rep?.id
        ? await supabase.from('vinculos').select('*').eq('comerciante_id', com.id).eq('representante_id', rep.id).single()
        : { data: null }

      if (vinculo?.ativo) {
        log.add('OK', `Vínculo criado: ${rep.nome} ↔ comerciante`)
        return { sucesso: true, dados: { rep, vinculo } }
      } else {
        log.add('ERRO', `Vínculo não encontrado. Rep: ${rep ? 'existe' : 'não existe'}, Vínculo: ${vinculo ? JSON.stringify(vinculo) : 'null'}`)
        return { sucesso: false, dados: { rep, vinculo } }
      }
    },
  },

  // ── 3. Cotação com lista de texto ─────────────────────────────────
  cotacao_lista_texto: {
    descricao: 'Comerciante envia lista de produtos para cotar',
    esperado: 'Cotação criada, representante recebe pedido de preços ou comparativo gerado',
    depende_de: 'onboarding_representante_convite',
    passos: async (log) => {
      const lista = 'Café Torrado 500g\nLeite Integral 1L\nÓleo de Soja 900ml\nRefrigerante Cola 2L'
      log.add('MSG', `[comerciante] lista de produtos`)
      const resp = await msg(FONES.comerciante, lista); await sleep(2000)
      log.add('RESP', `HTTP ${resp.status} → ${JSON.stringify(resp.body).slice(0, 100)}`)

      // Confirma cotação se solicitado
      await sleep(500)
      log.add('MSG', `[comerciante] "1" (confirmar lista)`)
      await msg(FONES.comerciante, '1'); await sleep(2000)

      // Valida cotação no banco
      const { data: com } = await supabase.from('comerciantes').select('id').eq('telefone', FONES.comerciante).single()
      const { data: cotacao } = com?.id
        ? await supabase.from('cotacoes').select('*, cotacao_itens(*)').eq('comerciante_id', com.id).order('criado_em', { ascending: false }).limit(1).single()
        : { data: null }

      if (cotacao) {
        log.add('OK', `Cotação criada: status=${cotacao.status}, itens=${cotacao.cotacao_itens?.length ?? 0}`)
        return { sucesso: true, dados: cotacao }
      } else {
        log.add('ERRO', 'Nenhuma cotação encontrada no banco')
        return { sucesso: false }
      }
    },
  },

  // ── 4. Fluxo completo ────────────────────────────────────────────
  fluxo_completo: {
    descricao: 'Fluxo end-to-end: onboarding + vínculo + cotação',
    esperado: 'Todos os estágios concluídos com sucesso',
    passos: async (log) => {
      const r1 = await CENARIOS.onboarding_comerciante.passos(log)
      if (!r1.sucesso) return { sucesso: false, etapa: 'onboarding_comerciante' }

      const r2 = await CENARIOS.onboarding_representante_convite.passos(log)
      if (!r2.sucesso) return { sucesso: false, etapa: 'onboarding_representante_convite' }

      const r3 = await CENARIOS.cotacao_lista_texto.passos(log)
      return { sucesso: r3.sucesso, etapa: r3.sucesso ? 'completo' : 'cotacao_lista_texto' }
    },
  },
}

// ── Análise por IA ────────────────────────────────────────────────────

async function analisarComIA(cenario, logs, resultado) {
  if (!USE_AI) return

  console.log('\n  🤖 Analisando com IA...\n')

  const prompt = `Você é um especialista em debugging de aplicações Node.js/WhatsApp Business.

## Cenário testado
**Nome:** ${cenario.nome}
**Descrição:** ${cenario.descricao}
**Resultado esperado:** ${cenario.esperado}
**Resultado obtido:** ${resultado.sucesso ? '✅ PASSOU' : `❌ FALHOU${resultado.etapa ? ` na etapa: ${resultado.etapa}` : ''}`}

## Logs capturados
\`\`\`
${logs}
\`\`\`

${!resultado.sucesso ? `## Dados do banco no momento da falha
\`\`\`json
${JSON.stringify(resultado.dados ?? {}, null, 2)}
\`\`\`` : ''}

## Sua análise
${resultado.sucesso
  ? 'O teste passou. Confirme que o comportamento está correto e destaque qualquer ponto de atenção.'
  : `O teste falhou. Identifique:
1. **Causa raiz** — o que exatamente deu errado
2. **Arquivo e função** — onde está o bug no código
3. **Correção sugerida** — trecho de código específico para corrigir
4. **Como revalidar** — qual mensagem/ação reproduz o bug`
}

Seja direto e específico. Cite nomes de funções e arquivos reais do projeto (webhook.js, onboarding.js, etc.).`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  })

  const analise = response.content[0].text
  console.log('  ┌─ Análise da IA ' + '─'.repeat(50))
  analise.split('\n').forEach(l => console.log('  │ ' + l))
  console.log('  └' + '─'.repeat(66) + '\n')
}

// ── Runner principal ──────────────────────────────────────────────────

async function rodarCenario(nome, cenario) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  🧪 ${nome}`)
  console.log(`  ${cenario.descricao}`)
  console.log('═'.repeat(60))

  const log = new LogCollector()
  let resultado

  try {
    resultado = await cenario.passos(log)
  } catch (err) {
    log.add('ERRO', `Exceção: ${err.message}`)
    resultado = { sucesso: false, erro: err.message }
  }

  const icone = resultado.sucesso ? '✅' : '❌'
  console.log(`\n  ${icone} ${resultado.sucesso ? 'PASSOU' : 'FALHOU'}`)

  await analisarComIA({ nome, ...cenario }, log.resumo(), resultado)
  return resultado
}

async function main() {
  console.log('\n🚀 Kota Test Runner\n')

  // Verifica servidor
  try {
    await fetch(`${BASE_URL}/webhook`)
  } catch {
    console.error(`❌ Servidor não responde em ${BASE_URL}`)
    console.error('   Rode: npm run dev\n')
    process.exit(1)
  }

  // Limpa dados de teste
  console.log('🧹 Limpando dados de teste...')
  await limparDadosTeste()

  // Seleciona cenários
  const nomes = FILTRO
    ? Object.keys(CENARIOS).filter(n => n.includes(FILTRO))
    : Object.keys(CENARIOS).filter(n => n !== 'fluxo_completo') // fluxo_completo roda manualmente

  if (!nomes.length) {
    console.error(`❌ Nenhum cenário encontrado para: ${FILTRO}`)
    console.log(`   Disponíveis: ${Object.keys(CENARIOS).join(', ')}`)
    process.exit(1)
  }

  const resultados = {}
  for (const nome of nomes) {
    resultados[nome] = await rodarCenario(nome, CENARIOS[nome])
  }

  // Resumo final
  console.log(`\n${'═'.repeat(60)}`)
  console.log('  📊 Resumo\n')
  for (const [nome, r] of Object.entries(resultados)) {
    console.log(`  ${r.sucesso ? '✅' : '❌'} ${nome}`)
  }
  const total  = Object.keys(resultados).length
  const passou = Object.values(resultados).filter(r => r.sucesso).length
  console.log(`\n  ${passou}/${total} cenários passaram`)
  console.log('═'.repeat(60) + '\n')
}

main().catch(err => { console.error(err); process.exit(1) })
