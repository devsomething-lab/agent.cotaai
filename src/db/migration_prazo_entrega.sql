-- ============================================================
--  CotAI v2 — Migration: prazo de entrega no cadastro do rep.
--  Execute no Supabase SQL Editor SE o banco já existia antes.
--  Se for instalação nova, basta usar o schema.sql completo.
-- ============================================================

-- Adiciona os novos campos na tabela representantes
ALTER TABLE representantes
  ADD COLUMN IF NOT EXISTS prazo_entrega_padrao_dias   INT DEFAULT 3,
  ADD COLUMN IF NOT EXISTS prazo_pagamento_padrao_dias INT DEFAULT 30,
  ADD COLUMN IF NOT EXISTS regiao_atendimento          TEXT,
  ADD COLUMN IF NOT EXISTS obs                         TEXT;

-- Preenche os valores padrão nos registros já existentes
UPDATE representantes
SET
  prazo_entrega_padrao_dias   = 3,
  prazo_pagamento_padrao_dias = 30
WHERE prazo_entrega_padrao_dias IS NULL;

-- Confirma
SELECT
  id,
  nome,
  empresa,
  prazo_entrega_padrao_dias,
  prazo_pagamento_padrao_dias,
  regiao_atendimento
FROM representantes
ORDER BY nome;
