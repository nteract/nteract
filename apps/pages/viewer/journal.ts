export interface PendingReplica {
  key: string;
  scope: string;
  revision: number;
  bytes: Uint8Array;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("nteract-pages-replicas", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("pending", { keyPath: "key" }).createIndex("scope", "scope");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function pendingReplicas(scope: string): Promise<PendingReplica[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("pending").objectStore("pending").index("scope").getAll(scope);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
export async function savePending(replica: PendingReplica): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite");
      tx.objectStore("pending").put(replica);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
// A different tab may still be writing a recovered journal. Only remove the
// exact revision this replica incorporated and the server acknowledged.
export async function clearPending(
  records: Pick<PendingReplica, "key" | "revision">[],
): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite"),
        store = tx.objectStore("pending");
      for (const record of records) {
        const request = store.get(record.key);
        request.onsuccess = () => {
          if (request.result?.revision === record.revision) store.delete(record.key);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
