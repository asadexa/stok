import { config } from 'dotenv'

// Kök dizindeki tek .env. globalSetup ana süreçte yüklüyor ama test
// çalışanları ayrı süreç; burada da yüklemek, çalışanın bağlantı
// dizesini "bazen bulamamasını" engelliyor.
config({ path: '../../.env' })
