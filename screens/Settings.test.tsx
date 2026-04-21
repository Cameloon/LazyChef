import { beforeEach, describe, expect, it } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import React from 'react';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const testDbDir = join(import.meta.dir, '..', 'db', '.test-data');
if (!existsSync(testDbDir)) mkdirSync(testDbDir, { recursive: true });
process.env.LAZYCHEF_DB_PATH = join(testDbDir, 'Settings.test.sqlite');

describe('Settings', () => {
  beforeEach(async () => {
    const settingsRepo = await import('../db/settingsRepo');
    settingsRepo.resetAppSettingsToDefaults();
  });

  it('renders german labels and values when language is de', async () => {
    const settingsRepo = await import('../db/settingsRepo');
    settingsRepo.updateAppSettings({
      language: 'de',
      intolerances: 'none',
      eatingHabit: 'all',
      defaultServings: 1,
    });

    const { Settings } = await import('./Settings');
    const app = render(<Settings />);

    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('Unverträglichkeiten');
      expect(frame).toContain('Sprache');
      expect(frame).toContain('deutsch');
      expect(frame).toContain('keine');
    } finally {
      app.cleanup();
      cleanup();
    }
  });
});
