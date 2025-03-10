import sqlite3InitModule from './libsql-wasm-experimental';
import { LibsqlError } from '@libsql/core/api';
import { expandConfig } from '@libsql/core/config';
import { supportedUrlLink, transactionModeToBegin, ResultSetImpl } from '@libsql/core/util';
export * from '@libsql/core/api';

// We'll store the initialized module here
let sqlite3: any = null;

export async function initSqlite3(wasmPath: string) {
  if (sqlite3) return sqlite3; // Return if already initialized

  try {
    // Set a global variable to override the worker URL
    // This needs to be done before the module is initialized
    // self.sqlite3InitModuleConfig = {
    //   // This will be used by the module to create the worker
    //   proxyUri: opfsWorkerPath,
    // };

    sqlite3 = await sqlite3InitModule({
      print: console.log,
      printErr: console.error,
      locateFile: (path) => {
        console.log(`Locating file: ${path}`);
        if (path.includes('sqlite3.wasm')) {
          console.log(`Using provided WASM path: ${wasmPath}`);
          return wasmPath;
        }
        return path;
      },
    });
    console.log(sqlite3);

    console.log('SQLite3 module initialized successfully');
    return sqlite3;
  } catch (error) {
    console.error('Failed to initialize SQLite3:', error);
    throw error;
  }
}

// Custom createClient that ensures SQLite is initialized first
export async function createClient(config: any) {
  if (!sqlite3) {
    throw new Error('SQLite3 module not initialized. Call initSqlite3 first.');
  }

  return _createClient(expandConfig(config, true));
}

/** @private */
export function _createClient(config: any) {
  if (!sqlite3) {
    throw new Error('SQLite3 module not initialized. Call initSqlite3 first.');
  }

  if (config.scheme !== 'file') {
    throw new LibsqlError(
      `URL scheme ${JSON.stringify(config.scheme + ':')} is not supported by the local sqlite3 client. ` +
        `For more information, please read ${supportedUrlLink}`,
      'URL_SCHEME_NOT_SUPPORTED'
    );
  }

  if (config.encryptionKey !== undefined) {
    throw new LibsqlError(
      'Encryption key is not supported by the Wasm client.',
      'ENCRYPTION_KEY_NOT_SUPPORTED'
    );
  }

  const authority = config.authority;
  if (authority !== undefined) {
    const host = authority.host.toLowerCase();
    if (host !== '' && host !== 'localhost') {
      throw new LibsqlError(
        `Invalid host in file URL: ${JSON.stringify(authority.host)}. ` +
          'A "file:" URL with an absolute path should start with one slash ("file:/absolute/path.db") ' +
          'or with three slashes ("file:///absolute/path.db"). ' +
          `For more information, please read ${supportedUrlLink}`,
        'URL_INVALID'
      );
    }
    if (authority.port !== undefined) {
      throw new LibsqlError('File URL cannot have a port', 'URL_INVALID');
    }
    if (authority.userinfo !== undefined) {
      throw new LibsqlError('File URL cannot have username and password', 'URL_INVALID');
    }
  }

  const path = config.path;
  const options = {
    authToken: config.authToken,
    syncUrl: config.syncUrl,
  };

  const db = new sqlite3.oo1.OpfsDb(path);
  executeStmt(db, 'SELECT 1 AS checkThatTheDatabaseCanBeOpened', config.intMode);
  return new Sqlite3Client(sqlite3, path, db, config.intMode);
}

function inTransaction(db: any) {
  return db.getAutocommit() == 0;
}

export class Sqlite3Client {
  #sqlite3: any;
  #path: string;
  #db: any;
  #intMode: string;
  closed: boolean;
  protocol: string;

  /** @private */
  constructor(sqlite3: any, path: string, db: any, intMode: string) {
    this.#sqlite3 = sqlite3;
    this.#path = path;
    this.#db = db;
    this.#intMode = intMode;
    this.closed = false;
    this.protocol = 'file';
  }

  async execute(stmtOrSql: any, args?: any) {
    let stmt;
    if (typeof stmtOrSql === 'string') {
      stmt = {
        sql: stmtOrSql,
        args: args || [],
      };
    } else {
      stmt = stmtOrSql;
    }
    this.#checkNotClosed();
    return executeStmt(this.#getDb(), stmt, this.#intMode);
  }

  async batch(stmts: any[], mode = 'deferred') {
    this.#checkNotClosed();
    const db = this.#getDb();
    try {
      executeStmt(db, transactionModeToBegin(mode), this.#intMode);
      const resultSets = stmts.map((stmt) => {
        if (!inTransaction(db)) {
          throw new LibsqlError('The transaction has been rolled back', 'TRANSACTION_CLOSED');
        }
        return executeStmt(db, stmt, this.#intMode);
      });
      executeStmt(db, 'COMMIT', this.#intMode);
      return resultSets;
    } finally {
      if (inTransaction(db)) {
        executeStmt(db, 'ROLLBACK', this.#intMode);
      }
    }
  }

  async migrate(stmts: any[]) {
    this.#checkNotClosed();
    const db = this.#getDb();
    try {
      executeStmt(db, 'PRAGMA foreign_keys=off', this.#intMode);
      executeStmt(db, transactionModeToBegin('deferred'), this.#intMode);
      const resultSets = stmts.map((stmt) => {
        if (!inTransaction(db)) {
          throw new LibsqlError('The transaction has been rolled back', 'TRANSACTION_CLOSED');
        }
        return executeStmt(db, stmt, this.#intMode);
      });
      executeStmt(db, 'COMMIT', this.#intMode);
      return resultSets;
    } finally {
      if (inTransaction(db)) {
        executeStmt(db, 'ROLLBACK', this.#intMode);
      }
      executeStmt(db, 'PRAGMA foreign_keys=on', this.#intMode);
    }
  }

  async transaction(mode = 'write') {
    const db = this.#getDb();
    executeStmt(db, transactionModeToBegin(mode), this.#intMode);
    this.#db = null; // A new connection will be lazily created on next use
    return new Sqlite3Transaction(db, this.#intMode);
  }

  async executeMultiple(sql: string) {
    this.#checkNotClosed();
    const db = this.#getDb();
    try {
      return executeMultiple(db, sql);
    } finally {
      if (inTransaction(db)) {
        executeStmt(db, 'ROLLBACK', this.#intMode);
      }
    }
  }

  async sync() {
    throw new LibsqlError('sync not supported in wasm mode', 'SYNC_NOT_SUPPORTED');
  }

  close() {
    this.closed = true;
    if (this.#db !== null) {
      this.#db.close();
    }
  }

  #checkNotClosed() {
    if (this.closed) {
      throw new LibsqlError('The client is closed', 'CLIENT_CLOSED');
    }
  }

  // Lazily creates the database connection and returns it
  #getDb() {
    if (this.#db === null) {
      this.#db = new this.#sqlite3.oo1.OpfsDb(this.#path);
    }
    return this.#db;
  }
}

export class Sqlite3Transaction {
  #database: any;
  #intMode: string;

  /** @private */
  constructor(database: any, intMode: string) {
    this.#database = database;
    this.#intMode = intMode;
  }

  async execute(stmt: any) {
    this.#checkNotClosed();
    return executeStmt(this.#database, stmt, this.#intMode);
  }

  async batch(stmts: any[]) {
    return stmts.map((stmt) => {
      this.#checkNotClosed();
      return executeStmt(this.#database, stmt, this.#intMode);
    });
  }

  async executeMultiple(sql: string) {
    this.#checkNotClosed();
    return executeMultiple(this.#database, sql);
  }

  async rollback() {
    if (!this.#database.isOpen()) {
      return;
    }
    this.#checkNotClosed();
    executeStmt(this.#database, 'ROLLBACK', this.#intMode);
  }

  async commit() {
    this.#checkNotClosed();
    executeStmt(this.#database, 'COMMIT', this.#intMode);
  }

  close() {
    if (inTransaction(this.#database)) {
      executeStmt(this.#database, 'ROLLBACK', this.#intMode);
    }
  }

  get closed() {
    return !inTransaction(this.#database);
  }

  #checkNotClosed() {
    if (this.closed) {
      throw new LibsqlError('The transaction is closed', 'TRANSACTION_CLOSED');
    }
  }
}

function executeStmt(db: any, stmt: any, intMode: string) {
  let sql;
  let args;
  if (typeof stmt === 'string') {
    sql = stmt;
    args = [];
  } else {
    sql = stmt.sql;
    if (Array.isArray(stmt.args)) {
      args = stmt.args.map((value: any) => valueToSql(value, intMode));
    } else {
      args = {};
      for (const name in stmt.args) {
        const argName =
          name[0] === '@' || name[0] === '$' || name[0] === ':' ? name.substring(1) : name;
        args[argName] = valueToSql(stmt.args[name], intMode);
      }
    }
  }

  try {
    const sqlStmt = db.prepare(sql);
    // TODO: sqlStmt.safeIntegers(true);
    let returnsData = sqlStmt.columnCount > 0;
    if (Array.isArray(args)) {
      for (let i = 0; i < args.length; ++i) {
        const value = args[i];
        sqlStmt.bind(i + 1, value);
      }
    } else {
      for (const argName in args) {
        const idx = sqlStmt.getParamIndex(argName);
        const value = args[argName];
        sqlStmt.bind(idx, value);
      }
    }

    if (returnsData) {
      let columns = sqlStmt.getColumnNames();
      let columnTypes: any[] = [];
      let rows = [];
      for (;;) {
        if (!sqlStmt.step()) {
          break;
        }
        const values = sqlStmt.get([]);
        rows.push(rowFromSql(values, columns, intMode));
      }
      const rowsAffected = 0;
      const lastInsertRowid = undefined;
      return new ResultSetImpl(columns, columnTypes, rows, rowsAffected, lastInsertRowid);
    } else {
      sqlStmt.step(); // TODO: check return value
      const rowsAffected = db.changes();
      const lastInsertRowid = BigInt(db.lastInsertRowid());
      return new ResultSetImpl([], [], [], rowsAffected, lastInsertRowid);
    }
  } catch (e) {
    throw mapSqliteError(e);
  }
}

function rowFromSql(sqlRow: any[], columns: string[], intMode: string) {
  const row: any = {};
  // make sure that the "length" property is not enumerable
  Object.defineProperty(row, 'length', { value: sqlRow.length });
  for (let i = 0; i < sqlRow.length; ++i) {
    const value = valueFromSql(sqlRow[i], intMode);
    Object.defineProperty(row, i, { value });
    const column = columns[i];
    if (!Object.hasOwn(row, column)) {
      Object.defineProperty(row, column, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return row;
}

function valueFromSql(sqlValue: any, intMode: string) {
  if (typeof sqlValue === 'bigint') {
    if (intMode === 'number') {
      if (sqlValue < minSafeBigint || sqlValue > maxSafeBigint) {
        throw new RangeError(
          'Received integer which cannot be safely represented as a JavaScript number'
        );
      }
      return Number(sqlValue);
    } else if (intMode === 'bigint') {
      return sqlValue;
    } else if (intMode === 'string') {
      return '' + sqlValue;
    } else {
      throw new Error('Invalid value for IntMode');
    }
  }
  return sqlValue;
}

const minSafeBigint = -9007199254740991n;
const maxSafeBigint = 9007199254740991n;

function valueToSql(value: any, intMode: string) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError('Only finite numbers (not Infinity or NaN) can be passed as arguments');
    }
    return value;
  } else if (typeof value === 'bigint') {
    if (value < minInteger || value > maxInteger) {
      throw new RangeError(
        'bigint is too large to be represented as a 64-bit integer and passed as argument'
      );
    }
    return value;
  } else if (typeof value === 'boolean') {
    switch (intMode) {
      case 'bigint':
        return value ? 1n : 0n;
      case 'string':
        return value ? '1' : '0';
      default:
        return value ? 1 : 0;
    }
  } else if (value instanceof Date) {
    return value.valueOf();
  } else if (value === undefined) {
    throw new TypeError('undefined cannot be passed as argument to the database');
  } else {
    return value;
  }
}

const minInteger = -9223372036854775808n;
const maxInteger = 9223372036854775807n;

function executeMultiple(db: any, sql: string) {
  try {
    db.exec(sql);
  } catch (e) {
    throw mapSqliteError(e);
  }
}

function mapSqliteError(e: any) {
  // TODO: Map to LibsqlError
  return e;
}
