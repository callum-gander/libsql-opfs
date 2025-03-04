import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
// import '@/styles/main.css';
import { browser } from 'wxt/browser';
import LibSQLWorker from '../../workers/libsql.worker?worker';
// import OpfsWorker from '../../workers/sqlite3-opfs-async-proxy.worker?worker';

// List of random grocery items to add
const RANDOM_GROCERIES = [
  'Apples',
  'Bananas',
  'Bread',
  'Milk',
  'Eggs',
  'Cheese',
  'Yogurt',
  'Chicken',
  'Beef',
  'Pasta',
  'Rice',
  'Cereal',
  'Coffee',
  'Tea',
  'Sugar',
  'Salt',
  'Pepper',
  'Olive Oil',
  'Butter',
  'Ice Cream',
  'Tomatoes',
  'Potatoes',
  'Onions',
  'Garlic',
  'Lettuce',
  'Carrots',
  'Broccoli',
  'Spinach',
  'Avocados',
  'Lemons',
  'Oranges',
  'Strawberries',
];

function ManagerApp() {
  const [db, setDb] = useState<SQLocal | null>(null);
  const [workerStatus, setWorkerStatus] = useState<string>('Not initialized');
  const [groceryItems, setGroceryItems] = useState<any[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const bridgeRef = useRef<any>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Function to add a random grocery item
  const addRandomGrocery = () => {
    if (!workerRef.current) return;

    // Pick a random grocery item
    const randomIndex = Math.floor(Math.random() * RANDOM_GROCERIES.length);
    const randomItem = RANDOM_GROCERIES[randomIndex];

    console.log(`[Manager] Adding random grocery: ${randomItem}`);
    setWorkerStatus(`Adding random grocery: ${randomItem}`);

    // Send to worker
    workerRef.current.postMessage({
      type: 'EXECUTE',
      data: {
        sql: 'INSERT INTO groceries (name) VALUES (?)',
        params: [randomItem],
      },
    });

    // Fetch updated list after insertion
    setTimeout(() => {
      if (workerRef.current) {
        workerRef.current.postMessage({
          type: 'EXECUTE',
          data: {
            sql: 'SELECT * FROM groceries',
          },
        });
      }
    }, 100);
  };

  useEffect(() => {
    const initDb = async () => {
      try {
        setWorkerStatus('Initializing worker...');
        const wasmPath = browser.runtime.getURL('assets/sqlite3.wasm');

        const worker = new LibSQLWorker();
        workerRef.current = worker;

        worker.onmessage = async (event) => {
          const { type, data } = event.data;
          console.log('[Manager] Received worker message:', type, data);

          switch (type) {
            case 'READY':
              setWorkerStatus('Worker ready, initializing database...');
              console.log('[Manager] Using WASM path:', wasmPath);

              worker.postMessage({
                type: 'INIT',
                data: {
                  dbName: 'my-database',
                  wasmPath: wasmPath,
                },
              });
              break;

            case 'INIT_RESULT':
              if (data.success) {
                setWorkerStatus('Database initialized, creating table...');
                worker.postMessage({
                  type: 'EXECUTE',
                  data: {
                    sql: 'CREATE TABLE IF NOT EXISTS groceries (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)',
                  },
                });
              } else {
                setWorkerStatus(`Database initialization error: ${data.error}`);
                console.error('[Manager] Database initialization error:', data.error, data.stack);
              }
              break;

            case 'EXECUTE_RESULT':
              if (data.success) {
                setWorkerStatus('Operation completed successfully');
                console.log('[Manager] Query result:', data.result);

                // If this is a SELECT query result with rows, update the state
                if (data.result && data.result.rows && Array.isArray(data.result.rows)) {
                  console.log('[Manager] Query result rows:', data.result.rows);
                  setGroceryItems(data.result.rows);
                }

                // Start the timer to add random groceries after the table is created
                if (
                  data.originalQuery &&
                  data.originalQuery.sql &&
                  data.originalQuery.sql.includes('CREATE TABLE')
                ) {
                  // Start with an initial fetch of all items
                  worker.postMessage({
                    type: 'EXECUTE',
                    data: {
                      sql: 'SELECT * FROM groceries',
                    },
                  });

                  // Set up the timer to add a random grocery every minute
                  if (!timerRef.current) {
                    console.log('[Manager] Starting timer to add random groceries');
                    // Add first item immediately
                    addRandomGrocery();

                    // Then set up interval
                    timerRef.current = setInterval(addRandomGrocery, 1000);
                  }
                }
              } else {
                setWorkerStatus(`Query error: ${data.error}`);
                console.error('[Manager] Query error:', data.error, data.stack);
              }
              break;
          }
        };

        // Replace bridge with direct methods for handling the same operations
        // These functions will be called directly instead of through the bridge
        const addGrocery = (groceryName: string) => {
          console.log('[Manager] Adding grocery:', groceryName);
          setWorkerStatus(`Adding grocery: ${groceryName}`);

          if (workerRef.current) {
            // Insert the new grocery item
            workerRef.current.postMessage({
              type: 'EXECUTE',
              data: {
                sql: 'INSERT INTO groceries (name) VALUES (?)',
                params: [groceryName],
              },
            });

            // Fetch all groceries after insertion
            setTimeout(() => {
              if (workerRef.current) {
                workerRef.current.postMessage({
                  type: 'EXECUTE',
                  data: {
                    sql: 'SELECT * FROM groceries',
                  },
                });
              }
            }, 100); // Small delay to ensure insertion completes
          }
          
          return { items: groceryItems };
        };

        const getGroceries = () => {
          if (workerRef.current) {
            workerRef.current.postMessage({
              type: 'EXECUTE',
              data: {
                sql: 'SELECT * FROM groceries',
              },
            });
          }
          
          return { items: groceryItems };
        };

        // Expose these methods globally if needed for external access
        // This replaces the bridge functionality
        window.groceryManager = {
          addGrocery,
          getGroceries
        };

        // Initial data fetch after table creation
        setTimeout(() => {
          if (workerRef.current) {
            workerRef.current.postMessage({
              type: 'EXECUTE',
              data: {
                sql: 'SELECT * FROM groceries',
              },
            });
          }
        }, 1000); // Give time for table creation to complete
      } catch (e) {
        console.error('[Manager] Initialization error:', e);
        setWorkerStatus(`Error: ${e.message}`);
      }
    };

    initDb();

    // Cleanup
    return () => {
      // Remove the global methods if they were added
      if (window.groceryManager) {
        delete window.groceryManager;
      }

      if (workerRef.current) {
        workerRef.current.terminate();
      }

      // Clear the timer
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="manager-container">
      <div
        className="manager-controls"
        style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          padding: '10px',
          background: '#f0f0f0',
          borderRadius: '8px',
          boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
        }}
      >
        <div style={{ marginBottom: '10px' }}>Status: {workerStatus}</div>
        <button
          onClick={addRandomGrocery}
          style={{
            padding: '8px 16px',
            background: '#4CAF50',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 'bold',
          }}
        >
          Add Random Grocery
        </button>
        <div style={{ marginTop: '10px' }}>
          <strong>Grocery Items ({groceryItems.length}):</strong>
          <ul
            style={{
              maxHeight: '200px',
              overflowY: 'auto',
              padding: '0 0 0 20px',
              margin: '5px 0 0 0',
            }}
          >
            {groceryItems.map((item) => (
              <li key={item.id}>{item.name}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

const container = document.getElementById('app');
if (container) {
  const root = createRoot(container);
  root.render(<ManagerApp />);
}
