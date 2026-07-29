import { SqliteMutex } from "../../src/coordinator.js";

const databasePath = process.argv[2];
if (databasePath === undefined) {
  throw new Error("expected a SQLite database path");
}

const mutex = new SqliteMutex({ databasePath });
await mutex.acquire();
process.send?.({ type: "acquired" });

setInterval(() => {
  // Keep the process alive without registering cleanup that would release the lock.
}, 1_000);
