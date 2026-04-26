'use client'
import { useEffect, useState } from 'react'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'

const STATUS_LABEL = {
  extraindo: { label: 'Extraindo', color: '#888' },
  aguardando_respostas: { label: 'Aguardando respostas', color: '#d97706' },
  consolidando: { label: 'Consolidando', color: '#7c3aed' },
  aguardando_escolha: { label: 'Aguardando escolha', color: '#2563eb' },
  pedido_gerado: { label: 'Pedido gerado', color: '#059669' },
  cancelada: { label: 'Cancelada', color: '#dc2626' },
}

export default function Dashboard() {
  const [stats, setStats] = useState(null)
  const [cotacoes, setCotacoes] = useState([])
  const [selected, setSelected] = useState(null)
  const [detalhe, setDetalhe] = useState(null)
  const [loadingDetalhe, setLoadingDetalhe] = useState(false)
  const [abaDetalhe, setAbaDetalhe] = useState('itens')

  useEffect(() => {
    fetch(`${API}/api/stats`).then(r => r.json()).then(setStats)
    fetch(`${API}/api/cotacoes?limit=30`).then(r => r.json()).then(d => setCotacoes(d.data ?? []))
  }, [])

  async function abrirDetalhe(id) {
    setSelected(id)
    setLoadingDetalhe(true)
    setAbaDetalhe('itens')
    const d = await fetch(`${API}/api/cotacoes/${id}`).then(r => r.json())
    setDetalhe(d)
    setLoadingDetalhe(false)
  }

  async function forcarConsolidacao(id) {
    await fetch(`${API}/api/cotacoes/${id}/consolidar`, { method: 'POST' })
    alert('Consolidação disparada! O comparativo será enviado ao comerciante.')
    abrirDetalhe(id)
  }

  return (
    <div style={{ fontFamily: "'DM Mono', 'Courier New', monospace", background: '#0a0a0a', minHeight: '100vh', color: '#e8e8e8' }}>

      {/* Header */}
      <div style={{ borderBottom: '1px solid #222', padding: '20px 32px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: -1, color: '#fff' }}>CotAI</span>
        <span style={{ fontSize: 12, color: '#555', letterSpacing: 2, textTransform: 'uppercase', marginTop: 2 }}>Hub de Cotações</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', minHeight: 'calc(100vh - 65px)' }}>

        {/* Sidebar */}
        <div style={{ borderRight: '1px solid #1a1a1a', padding: '24px 0' }}>

          {/* Stats */}
          {stats && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, marginBottom: 24, borderBottom: '1px solid #1a1a1a', paddingBottom: 24 }}>
              {[
                { label: 'Total cotações', val: stats.totalCotacoes },
                { label: 'Em aberto', val: stats.cotacoesAbertas },
                { label: 'Pedidos gerados', val: stats.pedidosGerados },
                { label: 'Tempo médio resp.', val: stats.tempoMedioRespostaHoras ? `${stats.tempoMedioRespostaHoras}h` : '—' },
              ].map(s => (
                <div key={s.label} style={{ padding: '12px 24px', borderRight: '1px solid #1a1a1a' }}>
                  <div style={{ fontSize: 11, color: '#555', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>{s.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>{s.val ?? '—'}</div>
                </div>
              ))}
            </div>
          )}

          {/* Lista cotações */}
          <div style={{ padding: '0 16px' }}>
            <div style={{ fontSize: 11, color: '#444', letterSpacing: 2, textTransform: 'uppercase', padding: '0 8px', marginBottom: 8 }}>Cotações recentes</div>
            {cotacoes.map(c => {
              const st = STATUS_LABEL[c.status] ?? { label: c.status, color: '#888' }
              const isSelected = selected === c.id
              return (
                <div
                  key={c.id}
                  onClick={() => abrirDetalhe(c.id)}
                  style={{
                    padding: '12px 12px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: isSelected ? '#1a1a1a' : 'transparent',
                    borderLeft: isSelected ? `2px solid #4ade80` : '2px solid transparent',
                    marginBottom: 2,
                    transition: 'all 0.1s',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: isSelected ? '#fff' : '#ccc' }}>
                        {c.comerciantes?.nome ?? c.comerciantes?.telefone ?? '—'}
                      </div>
                      <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
                        #{c.id.slice(-6).toUpperCase()} · {new Date(c.criado_em).toLocaleDateString('pt-BR')}
                      </div>
                    </div>
                    <span style={{
                      fontSize: 10,
                      padding: '2px 8px',
                      borderRadius: 100,
                      background: st.color + '22',
                      color: st.color,
                      whiteSpace: 'nowrap',
                      marginLeft: 8,
                    }}>
                      {st.label}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Painel detalhe */}
        <div style={{ padding: 32 }}>
          {!selected && (
            <div style={{ color: '#333', fontSize: 14, marginTop: 40, textAlign: 'center' }}>
              Selecione uma cotação para ver os detalhes
            </div>
          )}

          {loadingDetalhe && <div style={{ color: '#555' }}>Carregando...</div>}

          {detalhe && !loadingDetalhe && (
            <div>
              {/* Header detalhe */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#444', letterSpacing: 2, textTransform: 'uppercase' }}>Cotação</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', marginTop: 4 }}>
                    #{detalhe.cotacao?.id.slice(-6).toUpperCase()} · {detalhe.cotacao?.comerciantes?.nome}
                  </div>
                  <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
                    {detalhe.cotacao?.comerciantes?.telefone} · {new Date(detalhe.cotacao?.criado_em).toLocaleString('pt-BR')}
                  </div>
                </div>

                {detalhe.cotacao?.status === 'aguardando_respostas' && (
                  <button
                    onClick={() => forcarConsolidacao(detalhe.cotacao.id)}
                    style={{ padding: '8px 16px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, color: '#4ade80', cursor: 'pointer', fontSize: 12 }}
                  >
                    ⚡ Forçar consolidação
                  </button>
                )}
              </div>

              {/* Abas */}
              <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid #1a1a1a' }}>
                {['itens', 'propostas', 'pedido'].map(aba => (
                  <button
                    key={aba}
                    onClick={() => setAbaDetalhe(aba)}
                    style={{
                      padding: '8px 20px',
                      background: 'transparent',
                      border: 'none',
                      borderBottom: abaDetalhe === aba ? '2px solid #4ade80' : '2px solid transparent',
                      color: abaDetalhe === aba ? '#fff' : '#555',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontFamily: 'inherit',
                      textTransform: 'capitalize',
                    }}
                  >
                    {aba}
                  </button>
                ))}
              </div>

              {/* Aba Itens */}
              {abaDetalhe === 'itens' && (
                <div>
                  <Table
                    cols={['#', 'Produto', 'Marca', 'Unidade', 'Qtd', 'Obs']}
                    rows={(detalhe.itens ?? []).map((it, i) => [
                      i + 1, it.produto, it.marca ?? '—', it.unidade ?? '—', it.quantidade, it.obs ?? '—'
                    ])}
                  />
                </div>
              )}

              {/* Aba Propostas */}
              {abaDetalhe === 'propostas' && (
                <div>
                  {!detalhe.propostas?.length && <div style={{ color: '#555' }}>Nenhuma proposta recebida ainda.</div>}
                  {detalhe.propostas?.length > 0 && (
                    <Table
                      cols={['Representante', 'Produto', 'Preço unit.', 'Total', 'Pgto', 'Entrega', 'Score']}
                      rows={detalhe.propostas.map(p => [
                        p.representantes?.nome ?? '—',
                        p.produto,
                        p.preco_unitario != null ? `R$ ${p.preco_unitario.toFixed(2)}` : '—',
                        p.preco_total != null ? `R$ ${p.preco_total.toFixed(2)}` : '—',
                        p.prazo_pagamento_dias != null ? `${p.prazo_pagamento_dias}d` : '—',
                        p.prazo_entrega_dias != null ? `${p.prazo_entrega_dias}d` : '—',
                        p.score != null ? (
                          <span style={{ color: scoreColor(p.score) }}>{(p.score * 100).toFixed(0)}pts</span>
                        ) : '—',
                      ])}
                    />
                  )}
                </div>
              )}

              {/* Aba Pedido */}
              {abaDetalhe === 'pedido' && (
                <div>
                  {!detalhe.pedido && <div style={{ color: '#555' }}>Nenhum pedido gerado ainda.</div>}
                  {detalhe.pedido && (
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
                        {[
                          { label: 'Pedido', val: `#${detalhe.pedido.id.slice(-6).toUpperCase()}` },
                          { label: 'Representante', val: detalhe.pedido.representantes?.nome },
                          { label: 'Total', val: `R$ ${detalhe.pedido.valor_total?.toFixed(2)}` },
                          { label: 'Status', val: detalhe.pedido.status },
                        ].map(s => (
                          <div key={s.label} style={{ background: '#111', border: '1px solid #1a1a1a', borderRadius: 8, padding: '12px 16px' }}>
                            <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{s.label}</div>
                            <div style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>{s.val}</div>
                          </div>
                        ))}
                      </div>
                      <Table
                        cols={['Produto', 'Qtd', 'Preço unit.', 'Total']}
                        rows={(detalhe.pedido.pedido_itens ?? []).map(it => [
                          it.produto, it.quantidade,
                          it.preco_unitario != null ? `R$ ${it.preco_unitario.toFixed(2)}` : '—',
                          it.preco_total != null ? `R$ ${it.preco_total.toFixed(2)}` : '—',
                        ])}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Table({ cols, rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c} style={{ textAlign: 'left', padding: '8px 12px', color: '#444', fontWeight: 500, borderBottom: '1px solid #1a1a1a', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #111' }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '10px 12px', color: '#ccc' }}>{cell}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={cols.length} style={{ padding: 24, color: '#444', textAlign: 'center' }}>Nenhum registro</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function scoreColor(score) {
  if (score >= 0.7) return '#4ade80'
  if (score >= 0.4) return '#facc15'
  return '#f87171'
}
