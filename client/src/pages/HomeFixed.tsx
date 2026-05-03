import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useWallet } from '@/hooks/useWallet';
import {
  ArrowRight,
  CheckCircle2,
  CreditCard,
  Database,
  Lock,
  Network,
  ShieldCheck,
  UploadCloud,
  Wallet,
} from 'lucide-react';

const features = [
  {
    title: 'End-to-End Encryption',
    description: 'Files are encrypted before storage so private data stays private.',
    icon: Lock,
  },
  {
    title: 'P2P Storage',
    description: 'Store data across a peer network without relying on one central server.',
    icon: Network,
  },
  {
    title: 'Pay with Crypto',
    description: 'Use wallet-based payments and pay only for the storage you need.',
    icon: CreditCard,
  },
];

const steps = [
  {
    title: 'Connect wallet',
    description: 'Link your wallet to unlock encrypted cloud storage.',
    icon: Wallet,
  },
  {
    title: 'Upload and encrypt files',
    description: 'Choose files, encrypt metadata, and prepare chunks for the network.',
    icon: UploadCloud,
  },
  {
    title: 'Store across network',
    description: 'Distribute files across connected peers for resilient access.',
    icon: Database,
  },
];

const plans = [
  { name: 'Free', storage: '5GB', price: '$0' },
  { name: 'Basic', storage: '1TB', price: '$1' },
  { name: 'Pro', storage: '3TB', price: '$2.5' },
  { name: 'Max', storage: '10TB', price: '$7.99' },
];

function Hero() {
  const wallet = useWallet();

  return (
    <section className="relative overflow-hidden border-b border-white/10 bg-[#08111f] text-white">
      <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(14,165,233,0.18),transparent_35%,rgba(20,184,166,0.16)_70%,transparent)]" />
      <div className="container relative grid min-h-[92vh] items-center gap-12 py-20 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="max-w-3xl space-y-8">
          <div className="inline-flex items-center gap-2 rounded-md border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-sm text-cyan-100">
            <ShieldCheck className="h-4 w-4" />
            Private storage for a decentralized web
          </div>

          <div className="space-y-5">
            <h1 className="text-5xl font-bold leading-tight tracking-normal text-white md:text-7xl">
              Decentralized Cloud Storage
            </h1>
            <p className="text-2xl font-semibold text-cyan-100 md:text-3xl">
              Secure. Private. Unstoppable.
            </p>
            <p className="max-w-2xl text-lg leading-8 text-slate-300">
              Store your files with end-to-end encryption and pay only for what you use.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              size="lg"
              onClick={wallet.connect}
              disabled={wallet.isLoading}
              className="h-12 bg-cyan-400 px-6 text-slate-950 hover:bg-cyan-300"
            >
              <Wallet className="h-5 w-5" />
              {wallet.isLoading ? 'Connecting...' : 'Connect Wallet'}
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 border-white/20 px-6 text-white hover:bg-white/10 hover:text-white"
            >
              <a href="/dashboard">
                Get Started
                <ArrowRight className="h-5 w-5" />
              </a>
            </Button>
          </div>
        </div>

        <div className="relative min-h-[460px] rounded-md border border-white/10 bg-slate-950/70 p-5 shadow-2xl shadow-cyan-950/40 backdrop-blur">
          <div className="mb-5 flex items-center justify-between border-b border-white/10 pb-4">
            <div>
              <p className="text-sm text-slate-400">Network dashboard</p>
              <p className="text-xl font-semibold text-white">P2P Cloud Node</p>
            </div>
            <span className="rounded-md bg-emerald-400/15 px-3 py-1 text-sm font-medium text-emerald-200">
              Online
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ['Files', '128'],
              ['Peers', '24'],
              ['Encrypted', '100%'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-white/10 bg-white/[0.04] p-4">
                <p className="text-sm text-slate-400">{label}</p>
                <p className="mt-2 text-2xl font-bold text-white">{value}</p>
              </div>
            ))}
          </div>

          <div className="mt-5 space-y-3">
            {[
              ['contract-vault.pdf', '2.4 MB', 'Encrypted', '3 replicas'],
              ['identity-backup.zip', '890 MB', 'Encrypted', '5 replicas'],
              ['design-system.fig', '48 MB', 'Encrypted', '4 replicas'],
            ].map(([name, size, status, replicas]) => (
              <div key={name} className="flex items-center justify-between rounded-md border border-white/10 bg-slate-900 p-4">
                <div className="min-w-0">
                  <p className="truncate font-medium text-white">{name}</p>
                  <p className="mt-1 text-sm text-slate-400">{size} / {status}</p>
                </div>
                <span className="shrink-0 rounded-md bg-cyan-300/10 px-3 py-1 text-sm text-cyan-100">
                  {replicas}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-5 rounded-md border border-emerald-300/20 bg-emerald-300/10 p-4 text-sm text-emerald-100">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="h-4 w-4" />
              All files replicated and available
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section className="bg-slate-950 py-20 text-white">
      <div className="container">
        <div className="mb-10 max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">Why P2P Cloud</p>
          <h2 className="mt-3 text-3xl font-bold md:text-4xl">Built for private, resilient storage.</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <Card key={feature.title} className="rounded-md border-white/10 bg-slate-900 p-6 text-white shadow-none">
                <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-md bg-cyan-300/10 text-cyan-200">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="text-xl font-semibold">{feature.title}</h3>
                <p className="mt-3 leading-7 text-slate-400">{feature.description}</p>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="border-y border-white/10 bg-[#0c1726] py-20 text-white">
      <div className="container">
        <div className="mb-12 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">How it works</p>
            <h2 className="mt-3 text-3xl font-bold md:text-4xl">From wallet to encrypted storage in three steps.</h2>
          </div>
          <Button asChild variant="outline" className="w-fit border-white/20 text-white hover:bg-white/10 hover:text-white">
            <a href="/dashboard">Open Dashboard</a>
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <div key={step.title} className="rounded-md border border-white/10 bg-white/[0.04] p-6">
                <div className="mb-8 flex items-center justify-between">
                  <div className="flex h-12 w-12 items-center justify-center rounded-md bg-emerald-300/10 text-emerald-200">
                    <Icon className="h-5 w-5" />
                  </div>
                  <span className="font-mono text-sm text-slate-500">0{index + 1}</span>
                </div>
                <h3 className="text-xl font-semibold">{step.title}</h3>
                <p className="mt-3 leading-7 text-slate-400">{step.description}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section className="bg-slate-950 py-20 text-white">
      <div className="container">
        <div className="mb-10 max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">Pricing</p>
          <h2 className="mt-3 text-3xl font-bold md:text-4xl">Simple storage plans that scale with you.</h2>
        </div>

        <div className="overflow-hidden rounded-md border border-white/10 bg-slate-900">
          <div className="grid grid-cols-3 border-b border-white/10 bg-white/[0.03] px-4 py-4 text-sm font-semibold uppercase tracking-[0.15em] text-slate-400 sm:px-6">
            <span>Plan</span>
            <span>Storage</span>
            <span>Price</span>
          </div>
          {plans.map((plan) => (
            <div key={plan.name} className="grid grid-cols-3 items-center border-b border-white/10 px-4 py-5 last:border-b-0 sm:px-6">
              <span className="font-semibold text-white">{plan.name}</span>
              <span className="text-slate-300">{plan.storage}</span>
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-cyan-200">{plan.price}</span>
                <Button asChild size="sm" className="hidden bg-white text-slate-950 hover:bg-slate-200 sm:inline-flex">
                  <a href="/dashboard">Upgrade</a>
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="bg-[#0f1f2c] py-20 text-white">
      <div className="container text-center">
        <h2 className="text-3xl font-bold md:text-5xl">Start storing securely today</h2>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-slate-300">
          Connect your wallet, upload encrypted files, and manage storage from one focused dashboard.
        </p>
        <div className="mt-8 flex justify-center">
          <Button asChild size="lg" className="h-12 bg-cyan-400 px-6 text-slate-950 hover:bg-cyan-300">
            <a href="/dashboard">
              Get Started
              <ArrowRight className="h-5 w-5" />
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}

export default function HomeFixed() {
  return (
    <main className="min-h-screen bg-slate-950">
      <Hero />
      <Features />
      <HowItWorks />
      <Pricing />
      <CTA />
    </main>
  );
}
