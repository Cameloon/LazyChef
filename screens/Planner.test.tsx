import { describe, it, expect, beforeEach, vi, afterEach } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import React from 'react';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { computeTruncatedDayRenderStart, shouldShowBottomTruncationEllipsis } from './Planner';

// Ensure an isolated DB file for Planner UI tests so they do not touch the
// default project DB used by other tests.
const testDbDir = join(import.meta.dir, '..', 'db', '.test-data');
if (!existsSync(testDbDir)) mkdirSync(testDbDir, { recursive: true });
process.env.LAZYCHEF_DB_PATH = join(testDbDir, 'Planner.test.sqlite');

let plannerRepo: typeof import('../db/plannerRepo');
// Empirically enough for Ink's async first frame flush in Bun tests.
const INK_RENDER_DELAY_MS = 10;

describe('Planner UI', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Import plannerRepo per test and clear persisted plans to keep each test isolated.
    plannerRepo = await import('../db/plannerRepo');
    plannerRepo.clearPlannerHistory();
  });

  it('zeigt leeren Zustand, wenn keine Pläne existieren', async () => {
    const { Planner } = await import('./Planner');
    const app = render(<Planner language='de' />);
    try {
      // Allow Ink a short async render tick before asserting captured output.
      await new Promise((r) => setTimeout(r, INK_RENDER_DELAY_MS));
      const frame = app.lastFrame();
      expect(frame).toBeDefined();
      expect(frame ?? '').toMatch(/Plan f\u00fcr|Plan for/i);
    } finally {
      app.cleanup();
    }
  });

  it('zeigt einen Plan korrekt an', async () => {
    plannerRepo.savePlannerGeneration({
      days: 1,
      diet: 'vegetarian',
      generationMode: 'ai',
      plan: [
        {
          dayNumber: 1,
          meals: [
            { type: 'Breakfast', name: 'Test-Frühstück', time: '08:00', missing: [], source: 'ai' },
            { type: 'Lunch', name: 'Test-Mittag', time: '12:00', missing: ['Salz'], source: 'ai' },
            { type: 'Dinner', name: 'Test-Abend', time: '18:00', missing: [], source: 'ai' },
          ],
        },
      ],
      sourceScreen: 'planner',
    });

    const { Planner } = await import('./Planner');
    const app = render(<Planner language='de' />);
    try {
      await new Promise((r) => setTimeout(r, INK_RENDER_DELAY_MS));
      const frame = app.lastFrame();
      expect(frame).toBeDefined();
      expect(frame ?? '').toContain('Test-Frühstück');
      // Lunch header should be present even if the meal name may be truncated
      expect(frame ?? '').toContain('Mittag');
    } finally {
      app.cleanup();
    }
  });

  it('zeigt Trunkierungs-Punkte nur bei verstecktem Inhalt unten', () => {
    expect(shouldShowBottomTruncationEllipsis(true, true)).toBe(true);
    expect(shouldShowBottomTruncationEllipsis(true, false)).toBe(false);
    expect(shouldShowBottomTruncationEllipsis(false, true)).toBe(false);
  });

  it('berechnet bei Überlauf einen Startindex, der die fokussierte Meal sichtbar macht', () => {
    const mealLineEstimates = [10, 9, 8];
    const focusedMealIndex = 2;
    const allowedLines = 13; // 1 line header + 12 lines meal area
    const isTruncated = true;

    const start = computeTruncatedDayRenderStart(
      mealLineEstimates,
      focusedMealIndex,
      allowedLines,
      isTruncated,
    );

    expect(start).toBe(2);
  });

  it('reagiert auf Plan zurücksetzen', () => {
    plannerRepo.savePlannerGeneration({
      days: 1,
      diet: 'vegetarian',
      generationMode: 'ai',
      sourceScreen: 'planner',
      plan: [{ dayNumber: 1, meals: [] }],
    });

    plannerRepo.clearPlannerHistory();
    expect(plannerRepo.getLatestPlannerGeneration()).toBeNull();
  });
});
