import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FolderOpen, FolderPlus, Pencil, RefreshCw, Trash2, MoveRight } from "lucide-react";
import { toast } from "sonner";

type Bridge = { invoke: <T>(channel: string, payload?: unknown) => Promise<T> };

type DriveFolder = {
  id?: string;
  name: string;
  folderId?: string;
  parentFolderId?: string | null;
  hash?: string;
  rootHash?: string;
  kind?: string;
  isFolder?: boolean;
  ownerWallet?: string;
};

type Props = {
  api: Bridge;
  busy?: boolean;
  enabled?: boolean;
  onRefresh?: () => Promise<void> | void;
  onSelectFolder?: (folder: DriveFolder | null) => void;
};

const ROOT_ID = "";

function idOf(folder?: DriveFolder | null) {
  return String(folder?.folderId || folder?.id || folder?.hash || "");
}

function parentOf(folder?: DriveFolder | null) {
  return String(folder?.parentFolderId || "");
}

function folderPath(folder: DriveFolder, byId: Map<string, DriveFolder>) {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: DriveFolder | undefined = folder;
  while (cursor) {
    const id = idOf(cursor) || cursor.name;
    if (seen.has(id)) break;
    seen.add(id);
    chain.unshift(cursor.name);
    cursor = byId.get(parentOf(cursor));
  }
  return chain.join(" / ");
}

function collectRemovedIds(root: DriveFolder, folders: DriveFolder[]) {
  const removed = new Set<string>([idOf(root)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      const id = idOf(folder);
      if (id && !removed.has(id) && removed.has(parentOf(folder))) {
        removed.add(id);
        changed = true;
      }
    }
  }
  return removed;
}

export default function ManifestFolderPanel({ api, busy = false, enabled = true, onRefresh, onSelectFolder }: Props) {
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState(ROOT_ID);
  const [newFolderName, setNewFolderName] = useState("");
  const [loading, setLoading] = useState(false);

  const byId = useMemo(() => {
    const map = new Map<string, DriveFolder>();
    for (const folder of folders) {
      const id = idOf(folder);
      if (id) map.set(id, folder);
    }
    return map;
  }, [folders]);

  const ordered = useMemo(() => {
    const byParent = new Map<string, DriveFolder[]>();
    for (const folder of folders) {
      const parentId = parentOf(folder);
      byParent.set(parentId, [...(byParent.get(parentId) || []), folder]);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    }
    const result: Array<{ folder: DriveFolder; depth: number }> = [];
    const seen = new Set<string>();
    const walk = (parentId: string, depth: number) => {
      for (const folder of byParent.get(parentId) || []) {
        const id = idOf(folder) || `${folder.name}:${depth}`;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({ folder, depth });
        walk(idOf(folder), depth + 1);
      }
    };
    walk(ROOT_ID, 0);
    for (const folder of folders) {
      const id = idOf(folder);
      if (id && !seen.has(id)) result.push({ folder, depth: 0 });
    }
    return result;
  }, [folders]);

  const activeFolder = activeFolderId ? byId.get(activeFolderId) || null : null;

  const refreshFolders = async () => {
    if (!enabled) {
      setFolders([]);
      return;
    }
    setLoading(true);
    try {
      const next = await api.invoke<DriveFolder[]>("p2p:listFolders");
      setFolders(Array.isArray(next) ? next : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load folders");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const syncRefresh = async () => {
    await refreshFolders();
    await onRefresh?.();
  };

  const selectFolder = (folder: DriveFolder | null) => {
    setActiveFolderId(folder ? idOf(folder) : ROOT_ID);
    onSelectFolder?.(folder);
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setLoading(true);
    try {
      const result = await api.invoke<{ folder?: DriveFolder; folders?: DriveFolder[] }>("p2p:createFolder", {
        name,
        parentFolderId: activeFolderId || "",
      });
      if (Array.isArray(result?.folders)) setFolders(result.folders);
      else if (result?.folder) setFolders((current) => [...current, result.folder as DriveFolder]);
      if (result?.folder) selectFolder(result.folder);
      setNewFolderName("");
      toast.success("Folder created");
      await onRefresh?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create folder");
    } finally {
      setLoading(false);
    }
  };

  const renameFolder = async (folder: DriveFolder) => {
    const name = window.prompt("Rename folder", folder.name)?.trim();
    if (!name || name === folder.name) return;
    setLoading(true);
    try {
      const item = await api.invoke<DriveFolder>("p2p:renameItem", { itemId: folder.id || folder.folderId || folder.hash, name });
      setFolders((current) => current.map((candidate) => idOf(candidate) === idOf(folder) ? { ...candidate, ...item, name: item?.name || name } : candidate));
      toast.success("Folder renamed");
      await onRefresh?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rename folder");
    } finally {
      setLoading(false);
    }
  };

  const moveFolder = async (folder: DriveFolder) => {
    const targetName = window.prompt("Move inside folder name. Leave empty for root", "")?.trim() || "";
    const target = targetName ? folders.find((candidate) => candidate.name === targetName) : null;
    if (targetName && !target) {
      toast.error("Target folder not found");
      return;
    }
    if (target && idOf(target) === idOf(folder)) {
      toast.error("Cannot move folder inside itself");
      return;
    }
    setLoading(true);
    try {
      await api.invoke("p2p:moveItem", {
        itemId: folder.id || folder.folderId || folder.hash,
        targetFolderId: target ? idOf(target) : null,
      });
      setFolders((current) => current.map((candidate) => idOf(candidate) === idOf(folder) ? { ...candidate, parentFolderId: target ? idOf(target) : "" } : candidate));
      toast.success("Folder moved");
      await onRefresh?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to move folder");
    } finally {
      setLoading(false);
    }
  };

  const deleteFolder = async (folder: DriveFolder) => {
    if (!window.confirm(`Delete folder ${folderPath(folder, byId)} from network manifests?`)) return;
    setLoading(true);
    try {
      await api.invoke("p2p:deleteItem", { itemId: folder.id || folder.folderId || folder.hash });
      const removed = collectRemovedIds(folder, folders);
      setFolders((current) => current.filter((candidate) => !removed.has(idOf(candidate))));
      if (activeFolderId && removed.has(activeFolderId)) selectFolder(null);
      toast.success("Folder deleted");
      await onRefresh?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete folder");
    } finally {
      setLoading(false);
    }
  };

  const disabled = busy || loading || !enabled;

  return (
    <Card className="rounded-2xl border-zinc-800 bg-zinc-900">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">Folders</CardTitle>
          <Button variant="outline" size="sm" onClick={syncRefresh} disabled={disabled}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3">
          <p className="mb-2 text-xs text-zinc-500">Create inside: {activeFolder ? folderPath(activeFolder, byId) : "Root"}</p>
          <div className="flex gap-2">
            <Input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="New folder" disabled={!enabled} />
            <Button onClick={createFolder} disabled={disabled || !newFolderName.trim()}>
              <FolderPlus className="size-4" />
            </Button>
          </div>
        </div>

        <button onClick={() => selectFolder(null)} className={`block w-full rounded-xl px-4 py-3 text-left text-sm ${!activeFolderId ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/60"}`}>
          <FolderOpen className="mr-2 inline size-4" />All files
        </button>

        {ordered.map(({ folder, depth }) => {
          const selected = activeFolderId === idOf(folder);
          return (
            <div key={idOf(folder) || folder.name} className={`rounded-2xl border ${selected ? "border-blue-500/40 bg-blue-950/20" : "border-zinc-800 bg-zinc-950/60"}`} style={{ marginLeft: depth * 14 }}>
              <button onClick={() => selectFolder(folder)} className={`block w-full px-4 py-3 text-left text-sm ${selected ? "text-blue-100" : "text-zinc-300"}`}>
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate"><FolderOpen className="mr-2 inline size-4" />{folder.name}</span>
                  <Badge variant="outline" className="text-[10px]">manifest</Badge>
                </span>
              </button>
              <div className="grid grid-cols-3 gap-1 px-3 pb-3">
                <Button variant="outline" size="sm" onClick={() => renameFolder(folder)} disabled={disabled}><Pencil className="size-3" />Rename</Button>
                <Button variant="outline" size="sm" onClick={() => moveFolder(folder)} disabled={disabled}><MoveRight className="size-3" />Move</Button>
                <Button variant="destructive" size="sm" onClick={() => deleteFolder(folder)} disabled={disabled}><Trash2 className="size-3" />Delete</Button>
              </div>
            </div>
          );
        })}

        {enabled && ordered.length === 0 && <p className="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">No network folders yet.</p>}
        {!enabled && <p className="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">Folders are available in My Drive.</p>}
      </CardContent>
    </Card>
  );
}
