#!/usr/bin/env node
// tests/runner.mjs
// Runner principal — executa todos os 52 cenários de teste do Kota
//
// Uso:
//   node tests/runner.mjs              → todos os cenários
//   node tests/runner.mjs --only T01   → cenário específico
//   node tests/runner.mjs --skip T31   → pula cenário
//   node tests/runner.mjs --priority critico → só críticos
//   node tests/runner.mjs --fail-fast  → para no primeiro erro

import 'dotenv/config'

// ── SIM_MODE: intercepta sendText para capturar msgs sem chamar Meta ──
const _simMessages = []
global._simMessages = _simMessages

// Monkey-patch do whatsapp.js em modo teste
process.env.SIM_MODE = process.env.SIM_MODE ?? 'true'

// ── Importa cenários ──────────────────────────────────────────────────
import { scenarios as onboardingScenarios }    from './scenarios/onboarding.mjs'
import { scenarios as extracaoScenarios }      from './scenarios/extracao_catalogo.mjs'
import { scenarios as intencaoScenarios }      from './scenarios/intencao_edge.mjs'
import { scenarios as complementaresScenarios } from './scenarios/complementares.mjs'

// ── Importa handler principal ─────────────────────────────────────────
import { handleWebhook } from '../src/handlers/webhook.js'

const ALL_SCENARIOS = [
  ...onboardingScenarios,
  ...extracaoScenarios,
  ...intencaoScenarios,
  ...complementaresScenarios,
]

// ── Argumentos CLI ────────────────────────────────────────────────────
const args = process.argv.slice(2)
const onlyId       = args.find((_, i) => args[i-1] === '--only')
const skipId       = args.find((_, i) => args[i-1] === '--skip')
const priorityFilter = args.find((_, i) => args[i-1] === '--priority')
const failFast     = args.includes('--fail-fast')
const verbose      = args.includes('--verbose')

// ── Cores ─────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  white:  '\x1b[37m',
}

function badge(priority) {
  switch (priority) {
    case 'crítico': return `${C.red}[CRÍTICO]${C.reset}`
    case 'alto':    return `${C.yellow}[ALTO]${C.reset}`
    default:        return `${C.gray}[MÉDIO]${C.reset}`
  }
}

// ── Runner ────────────────────────────────────────────────────────────
async function run() {
  console.log(`\n${C.bold}${C.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`)
  console.log(`${C.bold}  Kota — Suite de Testes de Integração${C.reset}`)
  console.log(`${C.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}\n`)

  let scenarios = ALL_SCENARIOS

  // Filtros
  if (onlyId)         scenarios = scenarios.filter(s => s.id === onlyId)
  if (skipId)         scenarios = scenarios.filter(s => s.id !== skipId)
  if (priorityFilter) scenarios = scenarios.filter(s => s.priority === priorityFilter)

  console.log(`${C.gray}  Cenários: ${scenarios.length} | SIM_MODE: ${process.env.SIM_MODE}${C.reset}\n`)

  const results = { pass: 0, fail: 0, skip: 0, errors: [] }
  const startTotal = Date.now()

  for (const scenario of scenarios) {
    const start = Date.now()
    process.stdout.write(`  ${C.gray}${scenario.id}${C.reset} ${scenario.name} ${badge(scenario.priority)} `)

    try {
      if (scenario.setup) await scenario.setup()
      const result = await scenario.run(handleWebhook)
      const ms = Date.now() - start
      console.log(`${C.green}✓${C.reset} ${C.gray}(${ms}ms)${C.reset}`)
      if (verbose && result?.msg) console.log(`     ${C.gray}→ ${result.msg}${C.reset}`)
      results.pass++
    } catch (err) {
      const ms = Date.now() - start
      console.log(`${C.red}✗${C.reset} ${C.gray}(${ms}ms)${C.reset}`)
      console.log(`     ${C.red}${err.message}${C.reset}`)
      results.fail++
      results.errors.push({ id: scenario.id, name: scenario.name, error: err.message })
      if (failFast) {
        console.log(`\n${C.red}  ✗ Parando em fail-fast${C.reset}`)
        break
      }
    } finally {
      try { if (scenario.teardown) await scenario.teardown() } catch {}
    }
  }

  // ── Resumo ──────────────────────────────────────────────────────────
  const totalMs = Date.now() - startTotal
  console.log(`\n${C.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`)
  console.log(`  ${C.bold}Resultado${C.reset}   ${C.green}✓ ${results.pass} passou${C.reset}  ${results.fail > 0 ? C.red : C.gray}✗ ${results.fail} falhou${C.reset}  ${C.gray}${totalMs}ms${C.reset}`)

  if (results.errors.length) {
    console.log(`\n${C.red}  Falhas:${C.reset}`)
    results.errors.forEach(e => {
      console.log(`    ${C.gray}${e.id}${C.reset} ${e.name}`)
      console.log(`    ${C.red}→ ${e.error}${C.reset}`)
    })
  }

  console.log(`${C.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}\n`)

  process.exit(results.fail > 0 ? 1 : 0)
}

run().catch(err => {
  console.error(`\n${C.red}Erro fatal no runner:${C.reset}`, err)
  process.exit(1)
})
