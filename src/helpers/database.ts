import SwarmProto from "../protocols/swarm-proto.js";

import sqlite3, { Database, Statement } from "sqlite3";
import path from "path";
import fs from "fs";
import { Base64, Fragment, Metadata, DataFragment } from "../types/index.js";
import { hashFromData } from "../tools/cryptography.js";

const dbFilePath: string = "storage/database.db";
const dirName: string = path.dirname(dbFilePath);
if (!fs.existsSync(dirName)) {
  fs.mkdirSync(dirName, { recursive: true });
}

const db: Database = new sqlite3.Database(dbFilePath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err: unknown) => {
  if (err) throw err;
});

db.configure("busyTimeout", 5000);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS Metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hashKey TEXT NOT NULL,
    hash TEXT NOT NULL
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
    db.serialize(() => {
      db.run("BEGIN TRANSACTION", (err: unknown) => {
        if (err) return reject(err);

        const insertStmt: Statement = db.prepare("INSERT OR IGNORE INTO Metadata (hashKey, hash) VALUES (?, ?)");
        hashes.forEach((hash: Base64) => insertStmt.run(hashKey, hash));

        insertStmt.finalize((err) => {
          if (err) return reject(err);
          db.run("COMMIT", (err: unknown) => {
            if (err) return reject(err);
            resolve();
          });
        });
      });
    });
  });
}

export function getMetadataDb(hashKey: Base64): Promise<Base64[]> {
  return new Promise((resolve, reject) => {
    const query: string = `SELECT * FROM Metadata WHERE hashKey = ?`;
    db.all(query, [hashKey], (err: unknown, rows: Metadata[]) => {
      if (err) return reject(err);
      resolve(rows.map(({ hash }) => hash));
    });
  });
}

export function setFragmentsDb(fragments: Fragment[], timestamp: number = Date.now()): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("BEGIN TRANSACTION", (err: unknown) => {
        if (err) return reject(err);

        const insertStmt: Statement = db.prepare(
          "INSERT OR IGNORE INTO DataFragment (hashKey, data, timestamp) VALUES (?, ?, ?)"
        );

        fragments.forEach((frag: Fragment) => {
          const hashKey: Base64 = hashFromData(frag);
          insertStmt.run(hashKey, frag, timestamp);
        });

        insertStmt.finalize((err) => {
          if (err) return reject(err);
          db.run("COMMIT", (err: unknown) => {
            if (err) return reject(err);
            resolve();
          });
        });
      });
    });
  });
}

export function getDataFragmentsDb(hashKeys: Base64[]): Promise<Fragment[]> {
  if (hashKeys.length === 0) {
    return Promise.resolve([]);
  }

  return new Promise((resolve, reject) => {
    const placeholders: string = hashKeys.map(() => "?").join(",");
    const query: string = `SELECT * FROM DataFragment WHERE hashKey IN (${placeholders})`;

    db.all(query, hashKeys, (err: unknown, rows?: DataFragment[]) => {
      if (err) return reject(err);
      resolve(rows?.map(({ data }) => data) ?? []);
    });
  });
}
