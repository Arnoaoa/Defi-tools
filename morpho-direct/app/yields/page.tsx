import { Header } from '@/components/Header'
import { YieldsBrowser } from '@/components/YieldsBrowser'

export default function YieldsPage() {
  return (
    <div className="flex flex-col min-h-full" style={{ background: 'var(--background)' }}>
      <Header />
      <YieldsBrowser />
    </div>
  )
}
