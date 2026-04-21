import { initDb } from '../db/db';

console.log('Starte DB-Initialisierung und Migration (non-interactive)...');
await initDb;
console.log('initDb abgeschlossen. Überprüfe Tabellen und führe E2E-Insert aus.');

try {
  const invRepo = await import('../db/inventoryRepo');
  const dbModule = await import('../db/db');
  const schema = await import('../db/schema');

  const { addOrUpdateInventoryItem } = invRepo;
  const { db } = dbModule;
  const { inventory } = schema;

  console.log('Füge Test-Item zum Inventar hinzu...');
  addOrUpdateInventoryItem({ name: 'E2E-Test-Apfel', quantity: 3, unit: 'pcs' });

  const items = db.select().from(inventory).all();
  console.log(`Inventar-Einträge nach Insert: ${items.length}`);
  console.log(items.slice(0, 8));
} catch (err) {
  console.error('Fehler im E2E-Check:', err);
  process.exitCode = 2;
}

process.exit(0);
