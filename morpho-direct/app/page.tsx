import { Header } from '@/components/Header'
import { MarketBrowser } from '@/components/MarketBrowser'

export default function Home() {
  return (
    <div className="flex flex-col min-h-full" style={{ background: 'var(--background)' }}>
      <Header />
      <MarketBrowser />
    </div>
  )
}
