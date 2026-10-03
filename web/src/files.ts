// Local files: collecting a drop or a picked folder, and choosing the root layer.

export interface LocalFile {
  path: string; // relative, forward slashes
  file: File;
}

const USD = /\.(usd|usda|usdc|usdz)$/i;

/** Every file in a drop, walking directories. */
export async function collectDrop(transfer: DataTransfer): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns batches; an empty batch ends the listing.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = [...transfer.items].map((item) => item.webkitGetAsEntry()).filter((e) => e !== null);
  for (const entry of entries) await walk(entry, '');
  return out;
}

/** Files from an <input type=file>, with folder structure when `webkitdirectory` was used. */
export function fromInput(list: FileList): LocalFile[] {
  return [...list].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
}

/** A picked directory (File System Access API): its files plus the handles to write them back. */
export async function collectHandle(dir: FileSystemDirectoryHandle): Promise<{ files: LocalFile[]; handles: Map<string, FileSystemFileHandle> }> {
  const files: LocalFile[] = [];
  const handles = new Map<string, FileSystemFileHandle>();
  const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    // entries() is missing from TypeScript's DOM library; the browsers that have the API have it.
    for await (const [name, entry] of (handle as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (entry.kind === 'file') {
        const path = prefix + name;
        files.push({ path, file: await (entry as FileSystemFileHandle).getFile() });
        handles.set(path, entry as FileSystemFileHandle);
      } else await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
    }
  };
  await walk(dir, `${dir.name}/`);
  return { files, handles };
}

/** Hands the user a file to save. */
export function download(name: string, bytes: BlobPart): void {
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const isUsdFile = (path: string): boolean => USD.test(path);

/** USD files that could be the root layer: the shallowest ones, by name. */
export function rootCandidates(files: LocalFile[]): string[] {
  const usd = files.map((f) => f.path).filter((path) => USD.test(path));
  const depth = (path: string) => path.split('/').length;
  const shallowest = Math.min(...usd.map(depth));
  return usd.filter((path) => depth(path) === shallowest).sort();
}
