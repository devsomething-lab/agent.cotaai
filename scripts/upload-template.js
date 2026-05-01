#!/usr/bin/env node
/**
 * upload-template.js — Faz upload do template Excel para o Supabase Storage
 * Rode UMA vez: node scripts/upload-template.js
 * A URL pública gerada deve ser salva em TEMPLATE_CATALOGO_URL no .env
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import 'dotenv/config'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

const BUCKET   = 'assets'
const PATH     = 'templates/catalogo_kota_template.xlsx'
const FILE     = resolve('./assets/catalogo_kota_template.xlsx')

async function main() {
  console.log('📤 Fazendo upload do template para o Supabase Storage...')

  // Cria bucket se não existir
  const { data: buckets } = await supabase.storage.listBuckets()
  const bucketExiste = buckets?.some(b => b.name === BUCKET)

  if (!bucketExiste) {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true })
    if (error) { console.error('Erro ao criar bucket:', error.message); process.exit(1) }
    console.log(`✓ Bucket "${BUCKET}" criado`)
  }

  // Faz o upload
  const buffer = readFileSync(FILE)
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(PATH, buffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: true,
    })

  if (error) { console.error('Erro no upload:', error.message); process.exit(1) }

  // Gera URL pública
  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(PATH)

  console.log('\n✅ Upload concluído!')
  console.log(`\nAdicione no .env:\nTEMPLATE_CATALOGO_URL=${publicUrl}\n`)
}

main()
