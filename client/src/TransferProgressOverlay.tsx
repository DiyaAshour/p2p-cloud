import { Download, Upload, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type TransferProgress = {
  active: boolean;
  phase: string;
  fileName: string;
  totalBytes: number;
  transferredBytes: number;
  percent: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  chunksDone: number;
  totalChunks: number;
  concurrency: number;
  error?: string | null;
};

type NetworkSummary = {
  transferProgress?: {
    upload?: TransferProgress | null;
    download?: TransferProgress | null;
  };
  transferSettings?: {
    uploadConcurrency: number;
    downloadConcurrency: number;
  };
};

type ElectronProgressBridge = {
  invoke: <T>(channel: 'p2p:networkSummary') => Promise<T>;
};

function getProgressBridge(): ElectronProgressBridge | null {
  const candidate = (window as unknown as { electron?: { invoke?: unknown } }).electron;
  return typeof candidate?.invoke === 'function' ? candidate as ElectronProgressBridge : null;
}

function applyChunknetBranding() {
  document.title = 'Chunknet';

  const replacements = new Map([
    ['p2p.cloud Drive', 'Chunknet'],
    ['p2p.cloud', 'Chunknet'],
    ['PeerCloud Drive', 'Chunknet'],
    ['PeerCloud', 'Chunknet'],
  ]);

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  for (const node of textNodes) {
    let next = node.nodeValue || '';
    for (const [from, to] of replacements.entries()) next = next.replaceAll(from, to);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
}

function formatBytes(bytes = 0) {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function formatEta(seconds?: number | null) {
  if (!seconds || seconds <= 0) return 'Almost done';
  if (seconds < 60) return `${Math.ceil(seconds)}s remaining`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.ceil(seconds % 60);
  return `${minutes}m ${rest}s remaining`;
}

function progressLabel(type: 'upload' | 'download') {
  return type === 'upload' ? 'Uploading' : 'Downloading';
}

function TransferItem({ type, progress }: { type: 'upload' | 'download'; progress: TransferProgress }) {
  const Icon = type === 'upload' ? Upload : Download;
  const percent = Math.min(100, Math.max(0, Number(progress.percent || 0)));
  const isError = progress.phase === 'error';

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 p-4 shadow-2xl backdrop-blur">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="shrink-0 rounded-xl bg-zinc-800 p-2 text-zinc-100">
            {isError ? <XCircle className="size-5 text-red-300" /> : <Icon className="size-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-semibold leading-snug text-zinc-50">
              {progressLabel(type)} {progress.fileName || 'file'}
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              {progress.chunksDone}/{progress.totalChunks} chunks · {progress.concurrency} parallel
            </p>
          </div>
        </div>
        <div className="shrink-0 rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-100">
          {isError ? 'Error' : `${percent.toFixed(0)}%`}
        </div>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full rounded-full bg-zinc-50 transition-all duration-500" style={{ width: `${percent}%` }} />
      </div>

      <div className="mt-3 grid gap-1 text-xs text-zinc-400 sm:flex sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
        <span className="whitespace-nowrap">{formatBytes(progress.transferredBytes)} / {formatBytes(progress.totalBytes)}</span>
        <span className="whitespace-nowrap">{formatBytes(progress.speedBytesPerSecond)}/s · {formatEta(progress.etaSeconds)}</span>
      </div>

      {progress.error && (
        <p className="mt-3 max-h-24 overflow-auto break-words rounded-xl bg-red-950/50 p-2 text-xs text-red-200">
          {progress.error}
        </p>
      )}
    </div>
  );
}

export default function TransferProgressOverlay() {
  const [summary, setSummary] = useState<NetworkSummary | null>(null);

  useEffect(() => {
    applyChunknetBranding();
    const observer = new MutationObserver(() => applyChunknetBranding());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (typeof window === 'undefined') return;
      const bridge = getProgressBridge();
      if (!bridge) return;
      try {
        const next = await bridge.invoke<NetworkSummary>('p2p:networkSummary');
        if (!cancelled) setSummary(next);
      } catch {
        // Keep this overlay silent; the main app handles visible operation errors.
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const transfers = useMemo(() => {
    const upload = summary?.transferProgress?.upload;
    const download = summary?.transferProgress?.download;
    return [
      upload && (upload.active || upload.phase === 'error') ? { type: 'upload' as const, progress: upload } : null,
      download && (download.active || download.phase === 'error') ? { type: 'download' as const, progress: download } : null,
    ].filter(Boolean) as Array<{ type: 'upload' | 'download'; progress: TransferProgress }>;
  }, [summary]);

  if (!transfers.length) return null;

  return (
    <div className="fixed inset-x-3 bottom-3 z-[80] grid max-h-[45vh] gap-3 overflow-y-auto sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[min(520px,calc(100vw-2.5rem))]">
      {transfers.map((transfer) => (
        <TransferItem key={transfer.type} type={transfer.type} progress={transfer.progress} />
      ))}
    </div>
  );
}
