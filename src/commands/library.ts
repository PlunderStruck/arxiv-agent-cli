import type { LibraryEntry, LibraryList, LibraryStore } from "../library/store.js";

export async function executeLibraryList(
  library: LibraryStore,
  options: { readonly limit?: number; readonly offset?: number },
): Promise<LibraryList> {
  return await library.list(options);
}

export async function executeLibraryRemove(
  library: LibraryStore,
  id: string,
): Promise<LibraryEntry> {
  return await library.remove(id);
}

export async function executeLibraryRestore(
  library: LibraryStore,
  id: string,
): Promise<LibraryEntry> {
  return await library.restore(id);
}

export async function executeLibraryRepair(
  library: LibraryStore,
): Promise<{ readonly backup: string | undefined; readonly recovered: number }> {
  return await library.repair();
}
