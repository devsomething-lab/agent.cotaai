-- ============================================================
--  CotAI v2 — Schema completo com catálogo e cotação automática
--  Execute este arquivo inteiro no Supabase SQL Editor
-- ============================================================

-- ── EXTENSÕES ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- busca fuzzy por nome de produto

-- ============================================================
--  BLOCO 1 — USUÁRIOS
-- ============================================================

CREATE TABLE IF NOT EXISTS comerciantes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome        TEXT NOT NULL,
  telefone    TEXT NOT NULL UNIQUE,
  ativo       BOOLEAN DEFAULT TRUE,
  criado_em   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS representantes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome        TEXT NOT NULL,
  empresa     TEXT,
  telefone    TEXT NOT NULL UNIQUE,

  -- Condições comerciais padrão — fallback quando catálogo/proposta não informam
  prazo_entrega_padrao_dias   INT DEFAULT 3,
  prazo_pagamento_padrao_dias INT DEFAULT 30,

  -- Região de atendimento (ex: "SP Capital", "Grande SP", "Interior SP")
  regiao_atendimento TEXT,

  -- Observações gerais (política de entrega, pedido mínimo, etc.)
  obs TEXT,

  ativo       BOOLEAN DEFAULT TRUE,
  criado_em   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  BLOCO 2 — CATÁLOGO DE PREÇOS DOS REPRESENTANTES (NOVO)
-- ============================================================

-- Tabela principal do catálogo — preço atual por produto/representante
CREATE TABLE IF NOT EXISTS catalogo_representante (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  representante_id    UUID NOT NULL REFERENCES representantes(id) ON DELETE CASCADE,

  -- Identificação do produto
  produto             TEXT NOT NULL,
  marca               TEXT,
  unidade             TEXT,           -- caixa, fardo, pacote, kg, unidade...
  sku                 TEXT,           -- código interno do rep, se houver

  -- Preço e condições comerciais
  preco_unitario      NUMERIC NOT NULL,
  prazo_pagamento_dias INT,           -- prazo padrão do representante
  prazo_entrega_dias  INT,            -- prazo padrão de entrega

  -- Validade e controle
  valido_ate          DATE,           -- NULL = sem vencimento
  ativo               BOOLEAN DEFAULT TRUE,
  origem              TEXT DEFAULT 'manual',
  -- origem: manual | excel | pdf | whatsapp | api

  criado_em           TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (representante_id, produto, unidade) -- evita duplicatas por rep+produto+unidade
);

-- Histórico de alterações de preço — base para análise de tendências
CREATE TABLE IF NOT EXISTS catalogo_historico (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalogo_id         UUID NOT NULL REFERENCES catalogo_representante(id) ON DELETE CASCADE,
  representante_id    UUID NOT NULL REFERENCES representantes(id),

  produto             TEXT NOT NULL,
  preco_anterior      NUMERIC,
  preco_novo          NUMERIC NOT NULL,
  variacao_pct        NUMERIC, -- calculado: ((novo - anterior) / anterior) * 100

  origem              TEXT,    -- excel | pdf | whatsapp | api | manual
  arquivo_nome        TEXT,    -- nome do arquivo enviado, se houver

  alterado_em         TIMESTAMPTZ DEFAULT NOW()
);

-- Promoções temporárias — preço especial com validade
CREATE TABLE IF NOT EXISTS catalogo_promocoes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  representante_id    UUID NOT NULL REFERENCES representantes(id) ON DELETE CASCADE,

  produto             TEXT NOT NULL,
  marca               TEXT,
  unidade             TEXT,

  preco_normal        NUMERIC,        -- preço fora da promoção
  preco_promo         NUMERIC NOT NULL,
  desconto_pct        NUMERIC,        -- calculado automaticamente

  valida_de           DATE NOT NULL DEFAULT CURRENT_DATE,
  valida_ate          DATE NOT NULL,
  obs                 TEXT,           -- "fim de estoque", "lote especial"...

  ativo               BOOLEAN DEFAULT TRUE,
  criado_em           TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  BLOCO 3 — COTAÇÕES
-- ============================================================

CREATE TABLE IF NOT EXISTS cotacoes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comerciante_id      UUID NOT NULL REFERENCES comerciantes(id),

  status              TEXT NOT NULL DEFAULT 'extraindo',
  -- extraindo | aguardando_respostas | consolidando | aguardando_escolha | pedido_gerado | cancelada

  modo                TEXT NOT NULL DEFAULT 'misto',
  -- automatico  = todos os reps têm catálogo → responde sem perguntar
  -- manual      = nenhum rep tem catálogo → envia para todos responderem
  -- misto       = parte do catálogo, parte manual

  input_raw           TEXT,
  input_tipo          TEXT,           -- texto | foto | audio | pdf | planilha
  input_midia_url     TEXT,

  criado_em           TIMESTAMPTZ DEFAULT NOW(),
  fechado_em          TIMESTAMPTZ,
  timeout_em          TIMESTAMPTZ
);

-- Itens extraídos pela IA da lista do comerciante
CREATE TABLE IF NOT EXISTS cotacao_itens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cotacao_id      UUID NOT NULL REFERENCES cotacoes(id) ON DELETE CASCADE,
  produto         TEXT NOT NULL,
  marca           TEXT,
  unidade         TEXT,
  quantidade      NUMERIC,
  obs             TEXT,
  ordem           INT
);

-- Envios para cada representante — com campo modo_resposta
CREATE TABLE IF NOT EXISTS cotacao_envios (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cotacao_id          UUID NOT NULL REFERENCES cotacoes(id) ON DELETE CASCADE,
  representante_id    UUID NOT NULL REFERENCES representantes(id),

  modo_resposta       TEXT DEFAULT 'aguardando',
  -- aguardando | automatico | manual | ignorado
  -- automatico = respondido via catálogo sem interação humana
  -- manual     = representante respondeu manualmente pelo WhatsApp

  enviado_em          TIMESTAMPTZ DEFAULT NOW(),
  respondido_em       TIMESTAMPTZ,
  status              TEXT DEFAULT 'aguardando'
  -- aguardando | respondido | ignorado
);

-- ============================================================
--  BLOCO 4 — PROPOSTAS
-- ============================================================

CREATE TABLE IF NOT EXISTS propostas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cotacao_envio_id    UUID NOT NULL REFERENCES cotacao_envios(id) ON DELETE CASCADE,
  cotacao_id          UUID NOT NULL REFERENCES cotacoes(id),
  representante_id    UUID NOT NULL REFERENCES representantes(id),
  cotacao_item_id     UUID REFERENCES cotacao_itens(id),
  catalogo_item_id    UUID REFERENCES catalogo_representante(id),
  -- catalogo_item_id preenchido = veio do catálogo (automático)
  -- NULL = veio de resposta manual do representante

  produto             TEXT NOT NULL,
  preco_unitario      NUMERIC,
  preco_total         NUMERIC,
  prazo_pagamento_dias INT,
  prazo_entrega_dias  INT,
  obs                 TEXT,
  resposta_raw        TEXT,

  origem              TEXT DEFAULT 'manual',
  -- catalogo | promocao | manual
  -- catalogo  = buscado automaticamente do catalogo_representante
  -- promocao  = havia promoção ativa para este produto
  -- manual    = representante digitou a resposta

  score               NUMERIC,
  criado_em           TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  BLOCO 5 — PEDIDOS
-- ============================================================

CREATE TABLE IF NOT EXISTS pedidos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cotacao_id          UUID NOT NULL REFERENCES cotacoes(id),
  comerciante_id      UUID NOT NULL REFERENCES comerciantes(id),
  representante_id    UUID NOT NULL REFERENCES representantes(id),

  status              TEXT DEFAULT 'enviado',
  -- enviado | confirmado | cancelado

  valor_total         NUMERIC,
  prazo_pagamento_dias INT,
  prazo_entrega_dias  INT,

  gerado_em           TIMESTAMPTZ DEFAULT NOW(),
  confirmado_em       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pedido_itens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id       UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  produto         TEXT NOT NULL,
  marca           TEXT,
  unidade         TEXT,
  quantidade      NUMERIC,
  preco_unitario  NUMERIC,
  preco_total     NUMERIC
);

-- ============================================================
--  BLOCO 6 — ÍNDICES
-- ============================================================

-- Catálogo
CREATE INDEX IF NOT EXISTS idx_catalogo_rep       ON catalogo_representante(representante_id);
CREATE INDEX IF NOT EXISTS idx_catalogo_produto   ON catalogo_representante USING gin(produto gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_catalogo_ativo     ON catalogo_representante(ativo, valido_ate);
CREATE INDEX IF NOT EXISTS idx_historico_cat      ON catalogo_historico(catalogo_id);
CREATE INDEX IF NOT EXISTS idx_historico_rep      ON catalogo_historico(representante_id, alterado_em DESC);
CREATE INDEX IF NOT EXISTS idx_promocoes_rep      ON catalogo_promocoes(representante_id, valida_ate);
CREATE INDEX IF NOT EXISTS idx_promocoes_ativo    ON catalogo_promocoes(ativo, valida_de, valida_ate);

-- Cotações
CREATE INDEX IF NOT EXISTS idx_cotacoes_comerciante ON cotacoes(comerciante_id);
CREATE INDEX IF NOT EXISTS idx_cotacoes_status      ON cotacoes(status);
CREATE INDEX IF NOT EXISTS idx_cotacao_envios_rep   ON cotacao_envios(representante_id, status);
CREATE INDEX IF NOT EXISTS idx_propostas_cotacao    ON propostas(cotacao_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_comerciante  ON pedidos(comerciante_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_rep          ON pedidos(representante_id);

-- ============================================================
--  BLOCO 7 — TRIGGER: atualiza atualizado_em automaticamente
-- ============================================================

CREATE OR REPLACE FUNCTION set_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_catalogo_atualizado
  BEFORE UPDATE ON catalogo_representante
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- ============================================================
--  BLOCO 8 — TRIGGER: grava histórico ao atualizar preço
-- ============================================================

CREATE OR REPLACE FUNCTION registrar_historico_preco()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.preco_unitario IS DISTINCT FROM NEW.preco_unitario THEN
    INSERT INTO catalogo_historico (
      catalogo_id, representante_id, produto,
      preco_anterior, preco_novo, variacao_pct, origem
    ) VALUES (
      OLD.id, OLD.representante_id, OLD.produto,
      OLD.preco_unitario, NEW.preco_unitario,
      ROUND(((NEW.preco_unitario - OLD.preco_unitario) / OLD.preco_unitario * 100)::NUMERIC, 2),
      NEW.origem
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_historico_preco
  AFTER UPDATE ON catalogo_representante
  FOR EACH ROW EXECUTE FUNCTION registrar_historico_preco();

-- ============================================================
--  BLOCO 9 — VIEW: preço atual com promoção aplicada
-- ============================================================

CREATE OR REPLACE VIEW vw_catalogo_preco_efetivo AS
SELECT
  c.id,
  c.representante_id,
  c.produto,
  c.marca,
  c.unidade,
  c.sku,
  c.preco_unitario                          AS preco_normal,
  c.prazo_pagamento_dias,
  c.prazo_entrega_dias,
  c.valido_ate,

  -- Se há promoção ativa, usa o preço promocional
  COALESCE(p.preco_promo, c.preco_unitario) AS preco_efetivo,
  p.id IS NOT NULL                          AS tem_promocao,
  p.preco_promo                             AS preco_promo,
  p.valida_ate                              AS promo_valida_ate,
  p.obs                                     AS promo_obs

FROM catalogo_representante c
LEFT JOIN catalogo_promocoes p
  ON p.representante_id = c.representante_id
  AND LOWER(p.produto)  = LOWER(c.produto)
  AND p.ativo           = TRUE
  AND p.valida_de       <= CURRENT_DATE
  AND p.valida_ate      >= CURRENT_DATE
WHERE
  c.ativo = TRUE
  AND (c.valido_ate IS NULL OR c.valido_ate >= CURRENT_DATE);

COMMENT ON VIEW vw_catalogo_preco_efetivo IS
  'Preço atual do catálogo com promoção aplicada quando vigente. Use esta view para cotação automática.';
