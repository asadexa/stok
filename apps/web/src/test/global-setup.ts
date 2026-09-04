import { resetTestDatabase } from '@stok/db/testing'
import { config } from 'dotenv'
import { TEST_DB_NAME } from './db-name.js'

config({ path: '../../.env' })

export default async function setup() {
  await resetTestDatabase(TEST_DB_NAME)
}
