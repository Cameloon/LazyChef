import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

const tmpDir = join(import.meta.dir, '.test-data', 'receiptScanner');
const emptyReceiptsDir = join(tmpDir, 'empty-receipts');
const testDbDir = join(import.meta.dir, '.test-data');
process.env.LAZYCHEF_DB_PATH = join(testDbDir, 'receiptScanner.test.sqlite');

type ReceiptScannerModule = typeof import('./receiptScanner');
let scanner: ReceiptScannerModule;

beforeAll(async () => {
  // Ensure isolated test directory
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(emptyReceiptsDir, { recursive: true });
  mkdirSync(testDbDir, { recursive: true });

  scanner = await import('./receiptScanner');
});

afterAll(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

describe('receiptScanner', () => {
  beforeEach(async () => {
    const settingsRepo = await import('./settingsRepo');
    settingsRepo.resetAppSettingsToDefaults();
  });

  describe('buildInventoryContext', () => {
    it('includes serialized inventory when snapshot is provided', () => {
      const context = scanner.buildInventoryContext([
        { name: 'Saftorangen', quantity: 2, unit: 'kg' },
      ]);

      expect(context).toContain('Current inventory');
      expect(context).toContain('"name":"Saftorangen"');
      expect(context).toContain('"quantity":2');
      expect(context).toContain('"unit":"kg"');
    });

    it('returns empty-inventory hint when snapshot is empty', () => {
      expect(scanner.buildInventoryContext([])).toBe('Current inventory is empty.');
    });
  });

  describe('buildReceiptSystemPrompt', () => {
    it('adds explicit english-output instruction for en language', () => {
      const prompt = scanner.buildReceiptSystemPrompt('en');
      expect(prompt).toContain('Output item names in English only');
    });

    it('does not add english-only instruction for de language', () => {
      const prompt = scanner.buildReceiptSystemPrompt('de');
      expect(prompt).not.toContain('Output item names in English only');
    });
  });

  describe('getReceiptPromptLanguage', () => {
    it('returns en when settings language is en', async () => {
      const settingsRepo = await import('./settingsRepo');
      settingsRepo.updateAppSettings({ language: 'en' });
      expect(scanner.getReceiptPromptLanguage()).toBe('en');
    });

    it('returns de when settings language is de', async () => {
      const settingsRepo = await import('./settingsRepo');
      settingsRepo.updateAppSettings({ language: 'de' });
      expect(scanner.getReceiptPromptLanguage()).toBe('de');
    });
  });

  describe('getLatestReceiptImage', () => {
    it('returns null for an empty directory', () => {
      const emptyDir = join(tmpDir, 'empty');
      mkdirSync(emptyDir, { recursive: true });
      expect(scanner.getLatestReceiptImage(emptyDir)).toBeNull();
    });

    it('returns null for a non-existent directory', () => {
      expect(scanner.getLatestReceiptImage(join(tmpDir, 'nonexistent'))).toBeNull();
    });

    it('returns null when directory contains only non-image files', () => {
      const dir = join(tmpDir, 'noimg');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'notes.txt'), 'not an image');
      writeFileSync(join(dir, 'data.json'), '{}');
      expect(scanner.getLatestReceiptImage(dir)).toBeNull();
    });

    it('returns the single image when only one exists', () => {
      const dir = join(tmpDir, 'single');
      mkdirSync(dir, { recursive: true });
      const imgPath = join(dir, 'receipt.jpg');
      writeFileSync(imgPath, 'fake-image-data');
      expect(scanner.getLatestReceiptImage(dir)).toBe(imgPath);
    });

    it('returns the most recently modified image', async () => {
      const dir = join(tmpDir, 'multi');
      mkdirSync(dir, { recursive: true });

      const older = join(dir, 'old.png');
      writeFileSync(older, 'old-image');

      // Small delay to ensure different mtimes
      await new Promise((resolve) => setTimeout(resolve, 50));

      const newer = join(dir, 'new.jpeg');
      writeFileSync(newer, 'new-image');

      expect(scanner.getLatestReceiptImage(dir)).toBe(newer);
    });

    it('ignores non-image files when selecting latest', () => {
      const dir = join(tmpDir, 'mixed');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'readme.md'), 'text');
      const imgPath = join(dir, 'photo.webp');
      writeFileSync(imgPath, 'webp-data');
      expect(scanner.getLatestReceiptImage(dir)).toBe(imgPath);
    });

    it('supports all accepted image extensions', () => {
      for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.gif']) {
        const dir = join(tmpDir, `ext-${ext.slice(1)}`);
        mkdirSync(dir, { recursive: true });
        const imgPath = join(dir, `receipt${ext}`);
        writeFileSync(imgPath, 'data');
        expect(scanner.getLatestReceiptImage(dir)).toBe(imgPath);
      }
    });
  });

  describe('scanLatestReceipt', () => {
    it('returns error when no images exist in receipts folder', async () => {
      const result = await scanner.scanLatestReceipt(emptyReceiptsDir);
      expect(result.count).toBe(0);
      expect(result.error).toBeDefined();
    });
  });

  describe('scanLatestReceiptToInventoryAndShoppingList', () => {
    it('returns error when no images exist in receipts folder', async () => {
      const result = await scanner.scanLatestReceiptToInventoryAndShoppingList(emptyReceiptsDir);
      expect(result.count).toBe(0);
      expect(result.error).toBeDefined();
    });
  });

  describe('categorizeScannedItemsAsEssentials', () => {
    it('forces essentials category for all scanned receipt items', () => {
      const categorized = scanner.categorizeScannedItemsAsEssentials([
        { name: 'Milk', quantity: 1, unit: 'L' },
        { name: 'Juice', quantity: 2, unit: 'pcs', category: 'liquid' },
      ]);

      expect(categorized).toEqual([
        { name: 'Milk', quantity: 1, unit: 'L', category: 'essentials' },
        { name: 'Juice', quantity: 2, unit: 'pcs', category: 'essentials' },
      ]);
    });
  });
});
