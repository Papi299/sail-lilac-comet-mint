import { DatabaseSync } from "node:sqlite";


export interface OpenWorkerDatabaseOptions {
  path: string;
}

export function openWorkerDatabase({ path }: OpenWorkerDatabaseOptions): DatabaseSync {
  const db = new DatabaseSync(path, {
    timeout: 5000,
  });

  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }

  return db;
}
