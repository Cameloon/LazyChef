import { asc, eq } from 'drizzle-orm';
import { db } from './db';
import { appSettings } from './schema';

export type AppSettingsRow = typeof appSettings.$inferSelect;
export type AppSettingsUpdate = Partial<typeof appSettings.$inferInsert>;

const DEFAULT_SETTINGS: Omit<AppSettingsRow, 'id'> = {
  intolerances: 'none',
  lactoseIntolerance: 0,
  glutenIntolerance: 0,
  eatingHabit: 'all',
  defaultServings: 1,
  language: 'en',
};

export const getOrCreateAppSettings = (): AppSettingsRow => {
  const existing = db.select().from(appSettings).orderBy(asc(appSettings.id)).get();
  if (existing) {
    // Validate and fix intolerances value if invalid
    const validIntolerances = ['none', 'lactose', 'gluten', 'lactose+gluten'];
    if (!validIntolerances.includes(existing.intolerances)) {
      db.update(appSettings)
        .set({ intolerances: 'none' })
        .where(eq(appSettings.id, existing.id))
        .run();
      return { ...existing, intolerances: 'none' };
    }
    return existing;
  }

  return db.insert(appSettings).values(DEFAULT_SETTINGS).returning().get();
};

export const updateAppSettings = (patch: AppSettingsUpdate): AppSettingsRow => {
  const current = getOrCreateAppSettings();

  db.update(appSettings).set(patch).where(eq(appSettings.id, current.id)).run();

  return db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, current.id))
    .get() as AppSettingsRow;
};

export const resetAppSettingsToDefaults = (): AppSettingsRow => {
  const current = getOrCreateAppSettings();

  db.update(appSettings).set(DEFAULT_SETTINGS).where(eq(appSettings.id, current.id)).run();

  return db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, current.id))
    .get() as AppSettingsRow;
};
