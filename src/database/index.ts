import sqlite3, { Database, Statement } from "sqlite3";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { isBase64 } from "../tools/typing.js";

const __filename: string = fileURLToPath(import.meta.url);
const __dirname: string = dirname(__filename);
const projectRoot: string = join(__dirname, "..");
const dbFilePath: string = join(projectRoot, "database.db");

const db: Database = new sqlite3.Database(dbFilePath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
db.configure("busyTimeout", 5000);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS Metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hashKey TEXT NOT NULL,
    hash TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS DataFragment (
    hashKey TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  )`);

  // Create a composite index on hashKey and hash
  db.run("CREATE INDEX IF NOT EXISTS idx_hashKey_hash ON Metadata(hashKey, hash);");
});

export function setMetadataDb(hashKey: Base64, hashes: Base64[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const now: number = Date.now();

    db.serialize(async () => {
      db.run("BEGIN TRANSACTION");

      const checkStmt: Statement = db.prepare(`SELECT COUNT(*) AS count FROM Metadata WHERE hashKey = ? AND hash = ?`);
      const insertStmt: Statement = db.prepare(`INSERT INTO Metadata (hashKey, hash, timestamp) VALUES (?, ?, ?)`);

      // Only add unique key, value pairs
      const insertPromises: Promise<void>[] = hashes.map(
        (hash: Base64) =>
          new Promise<void>((res) => {
            checkStmt.get([hashKey, hash], (err, row?: { count: number }) => {
              if (err === null && row?.count === 0) {
                insertStmt.run(hashKey, hash, now);
              }

              res();
            });
          })
      );

      await Promise.all(insertPromises).catch(reject);

      insertStmt.finalize(); // Finalize the insert statement
      checkStmt.finalize(); // Finalize the check statement
      db.run("COMMIT", (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

export function getMetadataDb(hashKey: Base64): Promise<Base64[]> {
  return new Promise((res: (val: Base64[]) => void) => {
    const query = `SELECT * FROM Metadata WHERE hashKey = ?`;
    db.all(query, [hashKey], (_err, rows: Metadata[]) => {
      res(rows.map((row: Metadata) => row.hash).filter(isBase64));
    });
  });
}
