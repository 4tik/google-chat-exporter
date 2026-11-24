/**
 * @file idbStore.js
 * @description IndexedDB-based temporary storage utility for the Google Chat Exporter
 *              Chrome Extension. Provides a clean, promise-based API over the raw
 *              IndexedDB interface for persisting large export datasets (messages,
 *              threads, replies, attachments) during an active export session.
 *
 * @module IDBStore
 * @author  Google Chat Exporter
 * @license MIT
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Names of the object stores managed by this database.
 * Each store uses an `out-of-line` key (keyPath is not embedded in the value)
 * so callers supply the key explicitly on every put/get call.
 *
 * @constant {string[]}
 */
const STORE_NAMES = ['messages', 'threads', 'replies', 'attachments'];

/**
 * Schema migration definitions, keyed by the version they introduce.
 * Each entry is a function that receives the `IDBDatabase` upgrade event's
 * `db` and `transaction` objects and applies the structural changes needed
 * to reach that version.
 *
 * To add a new schema version in the future:
 *   1. Bump `version` in the `IDBStore` constructor call.
 *   2. Add a new entry here with the next integer key.
 *
 * @constant {Object.<number, function(IDBDatabase, IDBTransaction): void>}
 */
const MIGRATIONS = {
  /**
   * Version 1 — initial schema.
   * Creates the four core object stores with simple `out-of-line` keys and
   * a `createdAt` index on each store for time-range queries.
   *
   * @param {IDBDatabase}    db  - The database being upgraded.
   * @param {IDBTransaction} _tx - The upgrade transaction (unused at v1).
   */
  1: (db, _tx) => {
    for (const name of STORE_NAMES) {
      if (!db.objectStoreNames.contains(name)) {
        const store = db.createObjectStore(name); // out-of-line key
        // Index to allow efficient time-based iteration / pruning
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wraps an `IDBRequest` in a `Promise`.
 *
 * @template T
 * @param {IDBRequest} request - Any IndexedDB request object.
 * @returns {Promise<T>} Resolves with `request.result` on success.
 */
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new IDBStoreError(
          `IDB request failed: ${request.error?.message ?? 'unknown error'}`,
          request.error
        )
      );
  });
}

/**
 * Wraps an `IDBTransaction` in a `Promise` that resolves when the transaction
 * has committed and rejects on any error or abort.
 *
 * @param {IDBTransaction} tx - The transaction to observe.
 * @returns {Promise<void>}
 */
function promisifyTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(
        new IDBStoreError(
          `IDB transaction failed: ${tx.error?.message ?? 'unknown error'}`,
          tx.error
        )
      );
    tx.onabort = () =>
      reject(
        new IDBStoreError(
          `IDB transaction aborted: ${tx.error?.message ?? 'aborted'}`,
          tx.error
        )
      );
  });
}

// ---------------------------------------------------------------------------
// Custom Error
// ---------------------------------------------------------------------------

/**
 * Custom error class for IDBStore-related failures.
 * Preserves the original `DOMException` from IndexedDB for diagnostics.
 *
 * @extends Error
 */
class IDBStoreError extends Error {
  /**
   * @param {string}        message     - Human-readable description.
   * @param {DOMException|null} [cause] - The underlying IDB error, if any.
   */
  constructor(message, cause = null) {
    super(message);
    this.name = 'IDBStoreError';
    /** @type {DOMException|null} */
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// IDBStore
// ---------------------------------------------------------------------------

/**
 * A promise-based IndexedDB wrapper designed for the Google Chat Exporter
 * extension. Manages four object stores (`messages`, `threads`, `replies`,
 * `attachments`) and exposes a clean CRUD + batch API.
 *
 * ### Lifecycle
 * ```js
 * const store = new IDBStore('chat-export-db', 1);
 * await store.open();
 *
 * await store.put('messages', 'msg-001', { text: 'Hello', createdAt: Date.now() });
 * const msg = await store.get('messages', 'msg-001');
 *
 * await store.close();
 * // --- or, to wipe everything ---
 * await store.destroy();
 * ```
 *
 * ### Thread safety
 * IndexedDB is inherently single-process within a browser tab, but each call
 * opens its own short-lived transaction so concurrent async calls are safe.
 */
export class IDBStore {
  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Creates an `IDBStore` instance. Does **not** open the database; call
   * `open()` before using any other method.
   *
   * @param {string} [dbName='google-chat-exporter']  - IndexedDB database name.
   * @param {number} [version=1]                      - Schema version number.
   *   Increase this integer when adding new object stores or indexes, and add
   *   a corresponding entry to the {@link MIGRATIONS} map.
   */
  constructor(dbName = 'google-chat-exporter', version = 1) {
    /** @type {string} */
    this.dbName = dbName;

    /** @type {number} */
    this.version = version;

    /**
     * The underlying `IDBDatabase` instance. `null` until `open()` resolves.
     * @type {IDBDatabase|null}
     */
    this._db = null;

    /**
     * Whether the database connection has been explicitly closed or destroyed.
     * @type {boolean}
     */
    this._closed = false;
  }

  // -------------------------------------------------------------------------
  // Open / Close / Destroy
  // -------------------------------------------------------------------------

  /**
   * Opens (or creates) the IndexedDB database and runs any pending schema
   * migrations. Safe to call multiple times — subsequent calls return the
   * already-open connection immediately.
   *
   * @returns {Promise<IDBStore>} Resolves with `this` for chaining.
   * @throws  {IDBStoreError}    If the database cannot be opened.
   *
   * @example
   * const store = await new IDBStore('my-db', 1).open();
   */
  open() {
    // Idempotent: return immediately if already open
    if (this._db) return Promise.resolve(this);

    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        return reject(
          new IDBStoreError(
            'IndexedDB is not available in this environment. ' +
              'The extension must run in a browser context.'
          )
        );
      }

      const request = indexedDB.open(this.dbName, this.version);

      // ---- Schema upgrade / creation ----
      request.onupgradeneeded = (event) => {
        const db = /** @type {IDBDatabase} */ (event.target.result);
        const tx = /** @type {IDBTransaction} */ (event.target.transaction);
        const oldVersion = event.oldVersion; // 0 when brand-new

        // Run every migration from (oldVersion + 1) up to this.version
        for (let v = oldVersion + 1; v <= this.version; v++) {
          if (typeof MIGRATIONS[v] === 'function') {
            try {
              MIGRATIONS[v](db, tx);
            } catch (err) {
              // Abort the upgrade so the DB is not left in a half-migrated state
              tx.abort();
              return reject(
                new IDBStoreError(
                  `Migration to version ${v} failed: ${err.message}`,
                  err
                )
              );
            }
          }
        }
      };

      // ---- Success ----
      request.onsuccess = (event) => {
        this._db = /** @type {IDBDatabase} */ (event.target.result);
        this._closed = false;

        // Surface any unexpected version-change events (e.g. another tab
        // requested a higher version while we were open)
        this._db.onversionchange = () => {
          console.warn(
            '[IDBStore] Version change detected — closing database to allow upgrade.'
          );
          this.close();
        };

        resolve(this);
      };

      // ---- Error ----
      request.onerror = (event) => {
        reject(
          new IDBStoreError(
            `Failed to open IndexedDB "${this.dbName}": ` +
              `${event.target.error?.message ?? 'unknown error'}`,
            event.target.error
          )
        );
      };

      // ---- Blocked ----
      // Fired when another tab holds an older version open and prevents
      // the upgrade from starting. We warn but keep waiting.
      request.onblocked = () => {
        console.warn(
          '[IDBStore] Database upgrade is blocked by another tab. ' +
            'Please close other tabs using this extension and try again.'
        );
      };
    });
  }

  /**
   * Closes the database connection. Subsequent method calls will throw unless
   * `open()` is called again.
   *
   * Closing is a synchronous IDB operation; this method returns a resolved
   * Promise for API consistency.
   *
   * @returns {Promise<void>}
   */
  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
    this._closed = true;
    return Promise.resolve();
  }

  /**
   * Closes the connection **and** permanently deletes the database from
   * IndexedDB. Use at the end of an export session to free storage.
   *
   * @returns {Promise<void>}
   * @throws  {IDBStoreError} If the deletion fails.
   */
  async destroy() {
    await this.close();

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.dbName);

      request.onsuccess = () => resolve();
      request.onerror = (event) => {
        reject(
          new IDBStoreError(
            `Failed to delete IndexedDB "${this.dbName}": ` +
              `${event.target.error?.message ?? 'unknown error'}`,
            event.target.error
          )
        );
      };
      request.onblocked = () => {
        console.warn(
          '[IDBStore] Database deletion is blocked — another tab may be using it.'
        );
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Asserts the database is open, then returns the underlying `IDBDatabase`.
   *
   * @returns {IDBDatabase}
   * @throws  {IDBStoreError} If `open()` has not been called yet.
   * @private
   */
  _assertOpen() {
    if (!this._db) {
      throw new IDBStoreError(
        'IDBStore is not open. Call open() before using this method.'
      );
    }
    return this._db;
  }

  /**
   * Validates that `storeName` is one of the recognised object stores.
   *
   * @param {string} storeName
   * @throws {IDBStoreError} If the store name is not recognised.
   * @private
   */
  _assertStoreName(storeName) {
    if (!STORE_NAMES.includes(storeName)) {
      throw new IDBStoreError(
        `Unknown object store "${storeName}". ` +
          `Valid stores are: ${STORE_NAMES.join(', ')}.`
      );
    }
  }

  /**
   * Opens a short-lived `IDBTransaction` and returns the requested object
   * store from it.
   *
   * @param {string}                       storeName - Object store name.
   * @param {'readonly'|'readwrite'}       mode      - Transaction mode.
   * @returns {{ store: IDBObjectStore, tx: IDBTransaction }}
   * @private
   */
  _getStore(storeName, mode) {
    const db = this._assertOpen();
    this._assertStoreName(storeName);
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    return { store, tx };
  }

  // -------------------------------------------------------------------------
  // CRUD — single record
  // -------------------------------------------------------------------------

  /**
   * Inserts or updates a single record in the given object store (upsert).
   *
   * @param {string} storeName - Target object store.
   * @param {string|number} key - Record key.
   * @param {*} value           - Serialisable value to store.
   * @returns {Promise<void>}
   * @throws  {IDBStoreError}
   *
   * @example
   * await store.put('messages', 'msg-001', { text: 'Hi', createdAt: Date.now() });
   */
  async put(storeName, key, value) {
    const { store, tx } = this._getStore(storeName, 'readwrite');
    store.put(value, key);
    await promisifyTransaction(tx);
  }

  /**
   * Retrieves a single record by key.
   *
   * @param {string}        storeName - Object store to query.
   * @param {string|number} key       - Key of the record to retrieve.
   * @returns {Promise<*>} Resolves with the value, or `undefined` if not found.
   * @throws  {IDBStoreError}
   *
   * @example
   * const msg = await store.get('messages', 'msg-001');
   */
  async get(storeName, key) {
    const { store } = this._getStore(storeName, 'readonly');
    return promisifyRequest(store.get(key));
  }

  /**
   * Returns **all** records in the given object store as an array.
   * Records are returned in key-insertion order (IDB default).
   *
   * @param {string} storeName - Object store to query.
   * @returns {Promise<Array<*>>}
   * @throws  {IDBStoreError}
   *
   * @example
   * const allMessages = await store.getAll('messages');
   */
  async getAll(storeName) {
    const { store } = this._getStore(storeName, 'readonly');
    return promisifyRequest(store.getAll());
  }

  /**
   * Removes a single record by key. Silently succeeds if the key does not
   * exist (IDB `delete` is a no-op for missing keys).
   *
   * @param {string}        storeName - Object store.
   * @param {string|number} key       - Key of the record to remove.
   * @returns {Promise<void>}
   * @throws  {IDBStoreError}
   */
  async delete(storeName, key) {
    const { store, tx } = this._getStore(storeName, 'readwrite');
    store.delete(key);
    await promisifyTransaction(tx);
  }

  // -------------------------------------------------------------------------
  // Batch operations
  // -------------------------------------------------------------------------

  /**
   * Inserts or updates **multiple** records in a single transaction.
   * This is significantly more efficient than calling `put()` in a loop
   * because all writes share one round-trip to the IDB backend.
   *
   * @param {string} storeName - Target object store.
   * @param {Array<{ key: string|number, value: * }>} records
   *   An array of `{ key, value }` pairs to upsert.
   * @returns {Promise<void>}
   * @throws  {IDBStoreError}
   *
   * @example
   * await store.putMany('messages', [
   *   { key: 'msg-001', value: { text: 'Hello', createdAt: Date.now() } },
   *   { key: 'msg-002', value: { text: 'World', createdAt: Date.now() } },
   * ]);
   */
  async putMany(storeName, records) {
    if (!Array.isArray(records) || records.length === 0) return;

    const db = this._assertOpen();
    this._assertStoreName(storeName);

    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);

    for (const { key, value } of records) {
      if (key === undefined || key === null) {
        throw new IDBStoreError(
          'putMany: each record must have a non-null `key` property.'
        );
      }
      store.put(value, key);
    }

    await promisifyTransaction(tx);
  }

  // -------------------------------------------------------------------------
  // Clear operations
  // -------------------------------------------------------------------------

  /**
   * Removes **all** records from the specified object store without deleting
   * the store structure itself.
   *
   * @param {string} storeName - Object store to clear.
   * @returns {Promise<void>}
   * @throws  {IDBStoreError}
   *
   * @example
   * await store.clear('attachments');
   */
  async clear(storeName) {
    const { store, tx } = this._getStore(storeName, 'readwrite');
    store.clear();
    await promisifyTransaction(tx);
  }

  /**
   * Clears **all** four object stores in a single multi-store transaction.
   * Useful for resetting the export session without destroying the database.
   *
   * @returns {Promise<void>}
   * @throws  {IDBStoreError}
   */
  async clearAll() {
    const db = this._assertOpen();

    // Open one transaction spanning all four stores for atomicity
    const tx = db.transaction(STORE_NAMES, 'readwrite');

    for (const name of STORE_NAMES) {
      tx.objectStore(name).clear();
    }

    await promisifyTransaction(tx);
  }

  // -------------------------------------------------------------------------
  // Utility / introspection
  // -------------------------------------------------------------------------

  /**
   * Returns the number of records currently in the given object store.
   *
   * @param {string} storeName - Object store to count.
   * @returns {Promise<number>}
   * @throws  {IDBStoreError}
   *
   * @example
   * const total = await store.count('messages');
   * console.log(`${total} messages cached`);
   */
  async count(storeName) {
    const { store } = this._getStore(storeName, 'readonly');
    return promisifyRequest(store.count());
  }

  /**
   * Returns `true` if a record with the given key exists in the store.
   *
   * @param {string}        storeName - Object store to query.
   * @param {string|number} key       - Key to look up.
   * @returns {Promise<boolean>}
   * @throws  {IDBStoreError}
   */
  async has(storeName, key) {
    // `getKey` is lighter than `get` — it does not deserialise the value
    const { store } = this._getStore(storeName, 'readonly');
    const result = await promisifyRequest(store.getKey(key));
    return result !== undefined;
  }

  /**
   * Returns all **keys** in the given object store (without fetching values).
   *
   * @param {string} storeName - Object store to query.
   * @returns {Promise<Array<string|number>>}
   * @throws  {IDBStoreError}
   */
  async getAllKeys(storeName) {
    const { store } = this._getStore(storeName, 'readonly');
    return promisifyRequest(store.getAllKeys());
  }

  /**
   * Returns a snapshot summary of record counts across all stores.
   * Useful for diagnostics and progress reporting.
   *
   * @returns {Promise<Object.<string, number>>}
   *   An object mapping each store name to its record count.
   *
   * @example
   * const stats = await store.stats();
   * // { messages: 142, threads: 7, replies: 98, attachments: 23 }
   */
  async stats() {
    const db = this._assertOpen();
    const tx = db.transaction(STORE_NAMES, 'readonly');

    const counts = await Promise.all(
      STORE_NAMES.map((name) =>
        promisifyRequest(tx.objectStore(name).count())
      )
    );

    return Object.fromEntries(
      STORE_NAMES.map((name, i) => [name, counts[i]])
    );
  }

  /**
   * Whether the database is currently open and ready for operations.
   *
   * @type {boolean}
   */
  get isOpen() {
    return this._db !== null && !this._closed;
  }

  /**
   * The list of object store names managed by this instance.
   * @type {string[]}
   */
  get storeNames() {
    return [...STORE_NAMES];
  }
}

// ---------------------------------------------------------------------------
// Named exports
// ---------------------------------------------------------------------------

export { IDBStoreError, STORE_NAMES };
