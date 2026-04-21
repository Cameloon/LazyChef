type UnitFamily = 'mass' | 'volume' | 'count';

type UnitMeta = {
  family: UnitFamily;
  toBaseFactor: number;
};

const UNIT_CONVERSIONS: Record<string, UnitMeta> = {
  g: { family: 'mass', toBaseFactor: 1 },
  gram: { family: 'mass', toBaseFactor: 1 },
  grams: { family: 'mass', toBaseFactor: 1 },
  kg: { family: 'mass', toBaseFactor: 1000 },
  kilogram: { family: 'mass', toBaseFactor: 1000 },
  kilograms: { family: 'mass', toBaseFactor: 1000 },

  ml: { family: 'volume', toBaseFactor: 1 },
  milliliter: { family: 'volume', toBaseFactor: 1 },
  milliliters: { family: 'volume', toBaseFactor: 1 },
  l: { family: 'volume', toBaseFactor: 1000 },
  liter: { family: 'volume', toBaseFactor: 1000 },
  liters: { family: 'volume', toBaseFactor: 1000 },
  litre: { family: 'volume', toBaseFactor: 1000 },
  litres: { family: 'volume', toBaseFactor: 1000 },
  tbsp: { family: 'volume', toBaseFactor: 15 },
  tblspn: { family: 'volume', toBaseFactor: 15 },
  tablespoon: { family: 'volume', toBaseFactor: 15 },
  tablespoons: { family: 'volume', toBaseFactor: 15 },

  pcs: { family: 'count', toBaseFactor: 1 },
  pc: { family: 'count', toBaseFactor: 1 },
  piece: { family: 'count', toBaseFactor: 1 },
  pieces: { family: 'count', toBaseFactor: 1 },
  stk: { family: 'count', toBaseFactor: 1 },
  stueck: { family: 'count', toBaseFactor: 1 },
  stück: { family: 'count', toBaseFactor: 1 },
};

export const normalizeUnit = (unit: string): string =>
  String(unit || '')
    .trim()
    .toLowerCase();

export const convertAmount = (amount: number, fromUnit: string, toUnit: string): number | null => {
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (!from || !to) return null;
  if (from === to) return amount;

  const fromMeta = UNIT_CONVERSIONS[from];
  const toMeta = UNIT_CONVERSIONS[to];
  if (!fromMeta || !toMeta || fromMeta.family !== toMeta.family) return null;

  const amountInBase = amount * fromMeta.toBaseFactor;
  return amountInBase / toMeta.toBaseFactor;
};
