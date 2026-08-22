import { redirect } from 'next/navigation'
import { currentActor } from '@/server/session'

export default async function Home() {
  redirect((await currentActor()) ? '/panel' : '/giris')
}
