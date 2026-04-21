import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import React from 'react';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const testDbDir = join(import.meta.dir, '..', 'db', '.test-data');
if (!existsSync(testDbDir)) mkdirSync(testDbDir, { recursive: true });
process.env.LAZYCHEF_DB_PATH = join(testDbDir, 'Inventory.test.sqlite');

describe('Inventory navigation lock', () => {
  const clearInventory = async () => {
    const dbModule = await import('../db/db');
    const schema = await import('../db/schema');
    await dbModule.ensureInitDb();
    dbModule.db.delete(schema.inventory).run();
  };

  afterEach(() => {
    cleanup();
  });

  it('locks app-level navigation when add/edit modal is opened', async () => {
    const lockCalls: boolean[] = [];
    const { Inventory } = await import('./Inventory');
    const app = render(
      <Inventory
        language='en'
        onNavigationLockChange={(locked) => {
          lockCalls.push(locked);
        }}
      />,
    );

    for (let attempt = 0; attempt < 20 && !lockCalls.includes(true); attempt++) {
      app.stdin.write('a');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(lockCalls).toContain(true);
  });

  it('opens add modal when pressing [a] even if inventory is empty', async () => {
    await clearInventory();
    const { Inventory } = await import('./Inventory');
    const app = render(<Inventory language='en' />);

    app.stdin.write('a');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(app.lastFrame()).toContain('Add New Item');
  });
});
