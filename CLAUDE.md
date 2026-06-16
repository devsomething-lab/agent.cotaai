# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CotAI / "Kota" — a WhatsApp-based intelligent quotation hub for Brazilian wholesale/retail commerce. A `comerciante` (merchant) sends a product list over WhatsApp; the backend extracts items with AI, gathers prices from `representantes` (supplier reps) either automatically (from their saved catalog) or by messaging them, consolidates and scores the proposals, then helps the merchant pick a supplier and generates a `pedido` (order).

- **CotAI** is the repo/package name; **Kota** is the user-facing brand. All end-user text is **Brazilian Portuguese** — match this when editing messages.
- Pure ESM (`"type": "module"`); use `import`, not `require`.

## Commands

```bash
npm run dev      # node --watch src/server.js — local dev server on PORT (default 3000)
npm start        # production server
npm test         # node test/runner.mjs — integration tests (REQUIRES dev server already running)
npm test onboarding   # run only scenarios whose name includes "onboarding"
npm test -- --no-ai   # skip the AI failure-analysis step
```

There is **no build step** for the backend. `npm run db:migrate` is declared but `src/db/migrate.js` does not exist — the schema is applied by hand in the Supabase SQL Editor (`src/db/schema.sql`, then `src/db/migration_prazo_entrega.sql`).

### Testing notes
- `test/runner.mjs` is a custom integration harness, not a unit-test framework. It POSTs fake Meta webhook payloads to a **running** local server and asserts against real Supabase state, then optionally asks Claude to diagnose failures.
- It hits the **real Supabase project** and cleans up rows for the hardcoded test phone numbers (`5500000000001-3`). There is no isolated test DB.
- It expects `SUPABASE_SERVICE_ROLE_KEY` (note: the app itself reads `SUPABASE_SERVICE_KEY` — different name).

## Environment

Copy `.env.example` to `.env`. Required: `META_*` (WhatsApp Cloud API), `ANTHROPIC_API_KEY`, `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`. `WEBHOOK_SECRET` is the Meta verify token. Scoring weights (`SCORE_PESO_*`) and `COTACAO_TIMEOUT_HORAS` tune consolidation. `.env` is gitignored but currently contains live-looking secrets — do not commit it.

## Architecture

### Request flow
`src/server.js` (Fastify) exposes `POST /webhook` (Meta inbound), `GET /webhook` (Meta handshake), and a read-mostly `/api/*` surface for the Next.js dashboard. A `node-cron` job every 30 min consolidates `cotacoes` whose `timeout_em` has passed.

Everything inbound funnels through **`src/handlers/webhook.js` → `handleWebhook()`**, the brain of the app (~1500 lines). It:
1. Normalizes the Meta payload (`normalizeMetaPayload` in `services/whatsapp.js`).
2. Dedupes (Meta redelivers the same `messageId`), then **routes by sender identity**: active onboarding session → pending invite → registered `representante` → merchant onboarding → known merchant → unknown number (starts profile selection).
3. Dispatches to `handleMensagemComerciante` or `handleMensagemRepresentante`, which are large command routers keyed off natural-language commands and the current `cotacao.status`.

### Conversational state lives in two places
- **Durable**: `cotacoes.status` (`aguardando_respostas` → `aguardando_escolha` → `pedido_gerado` / `consulta` / `cancelada`) plus `cotacoes.obs_interna`, which doubles as a scratch field for sub-states like `aguardando_confirmacao_lista` and `confirmando:comprar`. `onboarding_sessoes` holds multi-step signup state.
- **Transient, in-memory** (lost on restart, single-instance only): `_estadosVinculo` (5-min "awaiting phone number" flows), `_mensagensProcessadas` (60s webhook dedup), `_cotacoesEmProcessamento` (10s per-cotação lock to avoid double-processing parallel webhooks). Because of these maps, **this backend assumes a single process** — horizontal scaling would break dedup/locking.

### AI agents (`src/agents/`)
Each wraps the Anthropic SDK (`new Anthropic()`) for one extraction/reasoning job and returns structured JSON:
- `extractor.js` — extracts the merchant's product list from text/photo/PDF/audio/spreadsheet (multimodal). Also enriches with quantity suggestions from the merchant's 90-day order history.
- `catalogo_agent.js` — extracts a rep's price table from uploaded files; `classificarMensagemRep` decides whether a rep's text is a catalog, promo, or quote reply.
- `consolidator.js` — `consolidarPropostas` is **pure (no AI)**: scores reps by weighted price/payment-term/delivery-term. `gerarResumoNegociacao` adds an AI natural-language trade-off summary.
- `auto_quote.js` — `resolverCotacaoAutomatica` matches list items against rep catalogs to answer without messaging reps; falls back to manual WhatsApp requests for uncovered items.
- `interpretar.js` — **the design philosophy in code**: parse locally first (units, payment terms via regex/maps), call the AI only on failure, and batch AI calls to cut latency/cost. New parsing should follow this local-first pattern.

Models in use vary by call site (e.g. `claude-haiku-4-5-20251001` for cheap product-name normalization in `db/catalogo.js`); the test harness uses Sonnet for analysis. Check the specific file before assuming a model.

### Data layer (`src/db/`)
Supabase (Postgres) accessed via service-role key — **no row-level security in play**, the backend is fully trusted. `client.js` holds the shared client and core finders; `catalogo.js` and `vinculos.js` hold domain queries.

Schema highlights from `schema.sql`:
- `pg_trgm` GIN index on `catalogo_representante.produto` powers fuzzy product matching for auto-quoting.
- A trigger writes `catalogo_historico` on every price change; the `vw_catalogo_preco_efetivo` **view** is the canonical "current price with active promotion applied" — prefer it over raw `catalogo_representante` for quoting.
- **Not all tables are in `schema.sql`.** `vinculos`, `convites_pendentes`, and `onboarding_sessoes` are referenced throughout but defined elsewhere/manually in Supabase. If you touch those, confirm their actual columns in the dashboard rather than trusting a local migration file.

### WhatsApp service (`src/services/whatsapp.js`)
Wraps the Meta Graph API. `SIM_MODE=true` captures outgoing messages in-memory and logs them instead of calling Meta (useful for local manual testing). Senders gracefully fall back from interactive templates to plain text (`sendTextOrTemplate`). Brazilian phone numbers are normalized for the 8-vs-9-digit cell-number ambiguity (`telefoneCandidatos`, duplicated in `webhook.js` and `onboarding.js`) — when matching a phone against the DB, query against all candidates.

### Dashboard (`dashboard/`)
Separate Next.js 15 app (own `package.json`); read-only views over the backend's `/api/*` endpoints. Run with `cd dashboard && npm run dev`.

## Bugs corrigidos — não regredir

1. **Clique de botão de template**: o WhatsApp envia `type: "button"`, não `"interactive"`. Tratado em `normalizeMetaPayload()` em `src/services/whatsapp.js`.
2. **Normalização de telefone BR**: a Meta entrega o número com 12 dígitos, mas convites são salvos com 13. Fix: `telefoneCandidatos()` retorna ambas as variantes (8 vs 9 dígitos) e os lookups usam `.in()` em vez de `.eq()`.
3. **Onboarding do comerciante exige upsert**: a etapa `aguardando_cnpj` fazia `.update()` em `comerciantes`, mas o registro ainda não existia. Fix: `.upsert({ telefone, nome, empresa, cnpj }, { onConflict: 'telefone' })` em `src/handlers/onboarding.js`.
4. **Lista de produtos descartada no onboarding**: `handleOnboardingComerciantge` retornava `null` ao detectar uma lista e o `webhook.js` encerrava o fluxo. Fix: quando o retorno é `null`, o webhook continua para `handleMensagemComerciantge` e processa a mensagem normalmente.

## Padrões críticos

- **SEMPRE** usar `.upsert()` em onboarding, nunca `.update()` puro — o registro pode ainda não existir.
- Links markdown gerados automaticamente do tipo `[rep.id](http://rep.id)` corrompem o código — se aparecerem, regenerar o arquivo inteiro.
- O primeiro contato com um número desconhecido exige um template Meta aprovado (não é possível enviar texto livre antes de o usuário iniciar a conversa).
- O backend assume **processo único** (dedup/locks/estado em memória) — não escalar horizontalmente.
- Todo caminho de erro precisa de `try-catch` e feedback visível ao usuário — nunca falhar em silêncio.
