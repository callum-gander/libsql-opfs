import { createClient, initSqlite3 } from '../lib/custom-libsql-client';
// import { createClient } from '@libsql/client-wasm';
// import { drizzle } from 'drizzle-orm/libsql/wasm';
// import { drizzle } from '../lib/drizzle-orm/libsql/wasm';
// import opfsWorkerScript from 'node_modules/@libsql/libsql-wasm-experimental/sqlite-wasm/jswasm/sqlite3-opfs-async-proxy.js?raw';

let db: any = null;

// Add a delay function to ensure OPFS has time to initialize
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initializeDb(dbName: string, wasmPath: string) {
  try {
    console.log(`[LibSQL Worker] Initializing database: ${dbName} with WASM at ${wasmPath}`);

    // First initialize SQLite with the correct path
    await initSqlite3(wasmPath);

    // Add a small delay to ensure OPFS is fully initialized
    await delay(500);

    // Use a specific path for OPFS
    const config = {
      url: `file:${dbName}`,
    };

    console.log('[LibSQL Worker] Creating client with config:', config);
    db = await createClient(config);

    console.log('[LibSQL Worker] Database initialized successfully');
    return { success: true };
  } catch (error) {
    console.error('[LibSQL Worker] Initialization error:', error);
    return {
      success: false,
      error: error.message,
      stack: error.stack,
    };
  }
}

async function executeQuery(sql: string, params: any[] = []) {
  try {
    if (!db) {
      throw new Error('Database not initialized');
    }
    console.log(`[LibSQL Worker] Executing query: ${sql}`, params);
    const result = await db.execute({
      sql,
      args: params,
    });
    console.log('[LibSQL Worker] Query result:', result);
    return { success: true, result };
  } catch (error) {
    console.error('[LibSQL Worker] Query error:', error);
    return {
      success: false,
      error: error.message,
      stack: error.stack,
    };
  }
}

self.onmessage = async (event) => {
  const { type, data } = event.data;
  console.log(`[LibSQL Worker] Received message: ${type}`, data);

  let response;

  try {
    switch (type) {
      case 'INIT':
        if (!data.wasmPath) {
          response = {
            success: false,
            error: 'WASM path is required for initialization',
          };
        } else {
          response = await initializeDb(data.dbName, data.wasmPath);
        }
        break;
      case 'EXECUTE':
        response = await executeQuery(data.sql, data.params);
        break;
      default:
        response = {
          success: false,
          error: `Unknown message type: ${type}`,
        };
    }
  } catch (error) {
    response = {
      success: false,
      error: error.message,
      stack: error.stack,
    };
  }

  self.postMessage({
    type: `${type}_RESULT`,
    data: response,
  });
};

// Signal that we're ready
self.postMessage({ type: 'READY' });
