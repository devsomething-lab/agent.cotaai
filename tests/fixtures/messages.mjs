// tests/fixtures/messages.mjs
// Simula payloads do webhook da Meta Cloud API

export function makePayload(from, text) {
  return {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from,
            type: 'text',
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            text: { body: text },
          }]
        }
      }]
    }]
  }
}

export function makeMediaPayload(from, type, mediaId, caption = null) {
  const mediaKey = type === 'image' ? 'image' : type === 'audio' ? 'audio' : 'document'
  return {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from,
            type,
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            [mediaKey]: { id: mediaId, mime_type: type === 'image' ? 'image/jpeg' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', caption },
          }]
        }
      }]
    }]
  }
}

// Números de teste fixos
export const PHONES = {
  comerciante:       '5511900000001',
  comerciante2:      '5511900000002',
  representante:     '5511900000003',
  representante2:    '5511900000004',
  desconhecido:      '5511900000099',
}

// CNPJs para teste
export const CNPJS = {
  valido_ativo:   '60500882000186', // PM Digital Solutions LTDA — ATIVA na Receita Federal
  formato_invalido: '00000000000000',
  digito_errado:  '11222333000199',
  inativo:        '11222333000200', // CNPJ existente mas baixado
}
