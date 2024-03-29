import {
  CacheKey,
  CacheOptions,
  LoggerFactory,
  PruneStats,
  SortKeyCacheResult,
  BasicSortKeyCache,
} from "warp-contracts";

import Database from "better-sqlite3";
import { SqliteCacheOptions } from "./SqliteCacheOptions";
import fs from "fs";
import safeStringify from "safe-stable-stringify";
import crypto from "crypto";

export class SqliteContractCache<V> implements BasicSortKeyCache<V> {
  private readonly logger = LoggerFactory.INST.create(SqliteContractCache.name);

  private _db: Database;

  constructor(
    private readonly cacheOptions: CacheOptions,
    private readonly sqliteCacheOptions?: SqliteCacheOptions
  ) {
    if (!this.cacheOptions.dbLocation) {
      throw new Error(
        "Sqlite cache configuration error - no db location specified"
      );
    }
    this.logger.info(`Using location ${cacheOptions.dbLocation}`);

    if (!sqliteCacheOptions) {
      this.sqliteCacheOptions = {
        maxEntriesPerContract: 10,
      };
    }
  }

  // Lazy initialization upon first access
  private get db() {
    if (!this._db) {
      if (this.cacheOptions.inMemory) {
        this._db = new Database(":memory:");
      } else {
        const dbLocation = this.cacheOptions.dbLocation;

        if (!fs.existsSync(dbLocation)) {
          fs.mkdirSync(dbLocation, { recursive: true });
        }
        this._db = new Database(dbLocation + ".db");
      }
      this._db.pragma("journal_mode = WAL");
      if (this.firstRun()) {
        // Incremental auto-vacuum. Reuses space marked as deleted.
        this._db.pragma("auto_vacuum = 2");
        this._db.exec("VACUUM");
      }
      this.sortKeyTable();
    }
    return this._db;
  }

  private firstRun(): boolean {
    const result = this._db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND tbl_name = 'sort_key_cache';`
      )
      .pluck()
      .get();
    return !result;
  }

  private sortKeyTable() {
    this._db.exec(
      `CREATE TABLE IF NOT EXISTS sort_key_cache
       (
           id       INTEGER PRIMARY KEY,
           key      TEXT,
           sort_key TEXT,
           value    TEXT,
           hash     TEXT,
           UNIQUE (key, sort_key)
       )
      `
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async get(
    cacheKey: CacheKey,
    returnDeepCopy?: boolean
  ): Promise<SortKeyCacheResult<V> | null> {
    const result = this.db
      .prepare(
        `SELECT value
         FROM sort_key_cache
         WHERE key = ?
           AND sort_key = ?;`
      )
      .pluck()
      .get(cacheKey.key, cacheKey.sortKey);

    if (result) {
      return new SortKeyCacheResult<V>(cacheKey.sortKey, JSON.parse(result));
    }
    return null;
  }

  async getLast(key: string): Promise<SortKeyCacheResult<V> | null> {
    const result = this.db
      .prepare(
        "SELECT sort_key, value FROM sort_key_cache WHERE key = ? ORDER BY sort_key DESC LIMIT 1"
      )
      .get(key);

    if (result && result.value) {
      return new SortKeyCacheResult<V>(
        result.sort_key,
        JSON.parse(result.value)
      );
    }
    return null;
  }

  async getLessOrEqual(
    key: string,
    sortKey: string
  ): Promise<SortKeyCacheResult<V> | null> {
    const result = this.db
      .prepare(
        "SELECT sort_key, value FROM sort_key_cache WHERE key = ? AND sort_key <= ? ORDER BY sort_key DESC LIMIT 1"
      )
      .get(key, sortKey);

    if (result && result.value) {
      return new SortKeyCacheResult<V>(
        result.sort_key,
        JSON.parse(result.value)
      );
    }
    return null;
  }

  async put(stateCacheKey: CacheKey, value: V): Promise<void> {
    this.removeOldestEntries(stateCacheKey.key);
    const strVal = safeStringify(value);
    const hash = this.generateHash(strVal);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO sort_key_cache (key, sort_key, value, hash) VALUES (@key, @sort_key, @value, @hash)"
      )
      .run({
        key: stateCacheKey.key,
        sort_key: stateCacheKey.sortKey,
        value: strVal,
        hash: hash,
      });
  }

  private generateHash(value: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(value);
    return hash.digest("hex");
  }

  private removeOldestEntries(key: string) {
    this.db
      .prepare(
        `
            WITH sorted_cache AS
                     (SELECT id, row_number() over (ORDER BY sort_key DESC) AS rw
                      FROM sort_key_cache
                      WHERE key = ?)
            DELETE
            FROM sort_key_cache
            WHERE id IN (SELECT id FROM sorted_cache WHERE rw >= ?);
        `
      )
      .run(key, this.sqliteCacheOptions.maxEntriesPerContract);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM sort_key_cache WHERE key = ?").run(key);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async open(): Promise<void> {}

  async close(): Promise<void> {
    if (this._db) {
      this._db.close();
    }
  }

  async begin(): Promise<void> {
    this.db.prepare("BEGIN;");
  }

  async rollback() {
    this.db.prepare("ROLLBACK;");
  }

  async commit() {
    this.db.prepare("COMMIT;");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async dump(): Promise<any> {
    throw new Error("Not implemented");
  }

  async getLastSortKey(): Promise<string | null> {
    const lastSortKey = this.db
      .prepare("SELECT max(sort_key) FROM sort_key_cache")
      .pluck()
      .get();
    return lastSortKey == "" ? null : lastSortKey;
  }

  storage<S>(): S {
    return this.db as S;
  }

  /**
   Let's assume that given contract cache contains these sortKeys: [a, b, c, d, e, f]
   Let's assume entriesStored = 2
   After pruning, the cache should be left with these keys: [e,f].

   const entries = await contractCache.keys({ reverse: true, limit: entriesStored }).all();
   This would return in this case entries [f, e] (notice the "reverse: true").

   await contractCache.clear({ lt: entries[entries.length - 1] });
   This effectively means: await contractCache.clear({ lt: e });
   -> hence the entries [a,b,c,d] are removed and left are the [e,f]
   */
  async prune(entriesStored = 5): Promise<PruneStats> {
    if (!entriesStored || entriesStored <= 0) {
      entriesStored = 1;
    }

    const allItems = this.db
      .prepare(
        `SELECT count(*)
         FROM sort_key_cache`
      )
      .pluck()
      .get();
    const result = this.db
      .prepare(
        `
            WITH sorted_cache AS
                     (SELECT id, key, sort_key, row_number() over (PARTITION BY "key" ORDER BY sort_key DESC) AS rw
                      FROM sort_key_cache)
            DELETE
            FROM sort_key_cache
            WHERE id IN (SELECT id FROM sorted_cache WHERE rw > ?);
        `
      )
      .run(entriesStored);
    return {
      entriesBefore: allItems,
      entriesAfter: allItems - result.changes,
      sizeBefore: -1,
      sizeAfter: -1,
    };
  }
}
