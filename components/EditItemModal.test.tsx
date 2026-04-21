import { describe, expect, it } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import React from 'react';
import EditItemModal from './EditItemModal';

describe('EditItemModal', () => {
  it('shows english unit labels for known german base units when language is en', async () => {
    const app = render(
      <EditItemModal
        item={{ id: 1, name: 'Milk', category: null, quantity: 1, unit: 'Stk' }}
        language='en'
        onCancel={() => {}}
        onSave={() => {}}
      />,
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('pcs');
      expect(frame).not.toContain('Stk');
    } finally {
      app.cleanup();
      cleanup();
    }
  });

  it('keeps ml unchanged for english display', async () => {
    const app = render(
      <EditItemModal
        item={{ id: 1, name: 'Water', category: null, quantity: 2, unit: 'ml' }}
        language='en'
        onCancel={() => {}}
        onSave={() => {}}
      />,
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('ml');
    } finally {
      app.cleanup();
      cleanup();
    }
  });

  it('renders category as fixed selector and shows emoji field', async () => {
    const app = render(
      <EditItemModal
        item={{ id: 1, name: 'Water', category: 'liquid', emoji: '🥤', quantity: 2, unit: 'ml' }}
        language='en'
        onCancel={() => {}}
        onSave={() => {}}
      />,
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('category:');
      expect(frame).toContain('Liquid');
      expect(frame).toContain('emoji:');
      expect(frame).toContain('🥤');
    } finally {
      app.cleanup();
      cleanup();
    }
  });
});
