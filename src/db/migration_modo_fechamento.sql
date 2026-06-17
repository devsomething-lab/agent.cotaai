-- ============================================================
--  CotAI — Migration: modo de fechamento da cotação
--  Execute no Supabase SQL Editor SE o banco já existia antes.
--  (Também aplicável via RPC exec_migration — ver CLAUDE.md.)
-- ============================================================

-- Como o comerciante decidiu fechar a cotação após o comparativo:
--   split_auto       = melhor fornecedor por item (vários pedidos)
--   fornecedor_unico = tudo com um único representante
--   manual           = comerciante escolheu fornecedor item a item
ALTER TABLE cotacoes
  ADD COLUMN IF NOT EXISTS modo_fechamento TEXT;

-- Novos valores possíveis de cotacoes.status (coluna TEXT, sem constraint):
--   aguardando_modo_fechamento = comparativo enviado, aguardando escolha do modo
--   escolha_item_a_item        = loop de escolha de fornecedor por item em andamento
--                                (progresso guardado em obs_interna como "itemaitem:{...}")

COMMENT ON COLUMN cotacoes.modo_fechamento IS
  'split_auto | fornecedor_unico | manual — como o comerciante fechou a cotação';
