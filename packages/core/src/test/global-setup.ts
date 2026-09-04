import { config } from 'dotenv'
import { resetTestDatabase } from '@stok/db/testing'
import { TEST_DB_NAME } from './db-name'

config({ path: '../../.env' })

export default async function setup() {
  await resetTestDatabase(TEST_DB_NAME)
}
