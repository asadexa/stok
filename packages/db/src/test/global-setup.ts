import { config } from 'dotenv'
import { resetTestDatabase } from '../testing.js'
import { TEST_DB_NAME } from './db-name.js'

config({ path: '../../.env' })

export default async function setup() {
  await resetTestDatabase(TEST_DB_NAME)
}
