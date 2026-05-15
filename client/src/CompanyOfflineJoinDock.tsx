import { useEffect, useState } from "react";
import CompanyOfflineJoinPanel from "./CompanyOfflineJoinPanel";

type Bridge = { invoke: <T>(channel: string, payload?: unknown) => Promise<T> };
type Workspace = { workspaceId: string; name: string };
type CompanyState = { workspaces?: Workspace[] };

declare global { interface Window { electron?: Bridge } }

export default function CompanyOfflineJoinDock() {
  const [company, setCompany] = useState<CompanyState | null>(null);
  const api = typeof window !== "undefined" ? window.electron : undefined;

  const refresh = async () => {
    if (!api) return;
    const state = await api.invoke<CompanyState>("company:state");
    setCompany(state);
  };

  useEffect(() => { void refresh(); }, []);

  if (!api) return null;

  return (
    <section className="bg-zinc-950 px-4 pb-8 text-zinc-50">
      <div className="container">
        <CompanyOfflineJoinPanel
          api={api as never}
          activeWorkspace={company?.workspaces?.[0] || null}
          onDone={refresh}
        />
      </div>
    </section>
  );
}
