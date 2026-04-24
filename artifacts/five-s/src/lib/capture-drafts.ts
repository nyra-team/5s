const DB_NAME = "five-s-capture-drafts";
const STORE_NAME = "drafts";
const DB_VERSION = 1;

export const CAPTURE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface CaptureDraft {
  operatorId: number;
  areaId: number;
  media: Blob;
  mediaName: string;
  mediaType: string;
  machineTag: string;
  savedAt: number;
}

interface StoredDraft extends CaptureDraft {
  key: string;
}

function isIdbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function makeKey(operatorId: number, areaId: number): string {
  return `${operatorId}:${areaId}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

export async function loadCaptureDraft(
  operatorId: number,
  areaId: number,
  now: number = Date.now(),
): Promise<CaptureDraft | null> {
  if (!isIdbAvailable()) return null;
  try {
    const db = await openDb();
    return await new Promise<CaptureDraft | null>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(makeKey(operatorId, areaId));
      req.onsuccess = () => {
        const stored = req.result as StoredDraft | undefined;
        if (!stored) return resolve(null);
        if (now - stored.savedAt > CAPTURE_DRAFT_TTL_MS) return resolve(null);
        resolve({
          operatorId: stored.operatorId,
          areaId: stored.areaId,
          media: stored.media,
          mediaName: stored.mediaName,
          mediaType: stored.mediaType,
          machineTag: stored.machineTag,
          savedAt: stored.savedAt,
        });
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export interface CaptureDraftMeta {
  operatorId: number;
  areaId: number;
  savedAt: number;
}

export async function peekCaptureDraftMeta(
  operatorId: number,
  areaId: number,
  now: number = Date.now(),
): Promise<CaptureDraftMeta | null> {
  if (!isIdbAvailable()) return null;
  try {
    const db = await openDb();
    return await new Promise<CaptureDraftMeta | null>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(makeKey(operatorId, areaId));
      req.onsuccess = () => {
        const stored = req.result as StoredDraft | undefined;
        if (!stored) return resolve(null);
        if (now - stored.savedAt > CAPTURE_DRAFT_TTL_MS) return resolve(null);
        resolve({
          operatorId: stored.operatorId,
          areaId: stored.areaId,
          savedAt: stored.savedAt,
        });
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function saveCaptureDraft(draft: CaptureDraft): Promise<void> {
  if (!isIdbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const stored: StoredDraft = {
        ...draft,
        key: makeKey(draft.operatorId, draft.areaId),
      };
      tx.objectStore(STORE_NAME).put(stored);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // swallow — draft persistence is best-effort
  }
}

export async function deleteCaptureDraft(
  operatorId: number,
  areaId: number,
): Promise<void> {
  if (!isIdbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(makeKey(operatorId, areaId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // swallow
  }
}

export async function purgeStaleCaptureDrafts(
  now: number = Date.now(),
): Promise<void> {
  if (!isIdbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const value = cursor.value as StoredDraft;
        if (now - value.savedAt > CAPTURE_DRAFT_TTL_MS) {
          cursor.delete();
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // swallow
  }
}
