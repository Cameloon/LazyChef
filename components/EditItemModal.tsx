import React, { useState } from 'react';
import { Box, Text, Newline, useInput } from 'ink';
import { t } from '../services/i18n';

type Item = {
  id?: number;
  name: string;
  category?: string | null;
  emoji?: string | null;
  quantity: number;
  unit: string;
};

type Props = {
  item: Item | null;
  onCancel: () => void;
  onSave: (item: Partial<Item>) => void;
  language?: string;
};

const PREDEFINED_UNITS = ['Stk', 'kg', 'g', 'L', 'ml', 'Pkg', 'Bund'] as const;
const EN_UNIT_LABELS: Record<string, string> = {
  Stk: 'pcs',
  kg: 'kg',
  g: 'gram',
  L: 'L',
  ml: 'ml',
  Pkg: 'pkg',
  Bund: 'bunch',
};
const EN_TO_CANONICAL_UNITS: Record<string, (typeof PREDEFINED_UNITS)[number]> = {
  pcs: 'Stk',
  gram: 'g',
  pkg: 'Pkg',
  bunch: 'Bund',
};
const PREDEFINED_CATEGORIES = ['essentials', 'liquid', 'alcohol', 'other'] as const;
const DE_TO_CANONICAL_CATEGORIES: Record<string, (typeof PREDEFINED_CATEGORIES)[number]> = {
  grundnahrungsmittel: 'essentials',
  fluessig: 'liquid',
  flüssig: 'liquid',
  alkohol: 'alcohol',
  sonstiges: 'other',
};
const fields = ['name', 'category', 'emoji', 'quantity', 'unit'] as const;
type FieldType = (typeof fields)[number];

const BG = 'black';
const FG = 'white';

const toCanonicalUnit = (unit?: string | null): string => {
  if (!unit) return PREDEFINED_UNITS[0];
  return EN_TO_CANONICAL_UNITS[unit] ?? unit;
};

const toDisplayUnit = (unit: string, language: string): string => {
  if (language !== 'en') return unit;
  return EN_UNIT_LABELS[unit] ?? unit;
};

const toCanonicalCategory = (category?: string | null): (typeof PREDEFINED_CATEGORIES)[number] => {
  if (!category) return 'other';
  const normalized = category.toLowerCase();
  if (PREDEFINED_CATEGORIES.includes(normalized as (typeof PREDEFINED_CATEGORIES)[number])) {
    return normalized as (typeof PREDEFINED_CATEGORIES)[number];
  }
  return DE_TO_CANONICAL_CATEGORIES[normalized] ?? 'other';
};

const EditItemModal: React.FC<Props> = ({ item, onCancel, onSave, language = 'en' }) => {
  const [values, setValues] = useState<Record<FieldType, string>>({
    name: item?.name ?? '',
    category: toCanonicalCategory(item?.category),
    emoji: item?.emoji ?? '',
    quantity: item?.quantity?.toString() ?? '1',
    unit: toCanonicalUnit(item?.unit),
  });

  const [activeIdx, setActiveIdx] = useState(0);

  useInput((input, key) => {
    const currentField: FieldType = fields[activeIdx];

    if (key.return) {
      if (activeIdx === fields.length - 1) {
        onSave({
          id: item?.id,
          name: values.name.trim(),
          category: values.category,
          emoji: values.emoji.trim() || null,
          quantity: parseFloat(values.quantity) || 0,
          unit: values.unit,
        });
      } else {
        setActiveIdx((prev) => prev + 1);
      }
      return;
    }

    if (key.escape) return onCancel();

    if (key.upArrow) setActiveIdx((prev) => (prev - 1 + fields.length) % fields.length);
    if (key.downArrow) setActiveIdx((prev) => (prev + 1) % fields.length);

    if (currentField === 'category' && (key.leftArrow || key.rightArrow)) {
      const currentCategoryIdx = Math.max(
        PREDEFINED_CATEGORIES.indexOf(values.category as (typeof PREDEFINED_CATEGORIES)[number]),
        0,
      );
      const nextIdx = key.rightArrow
        ? (currentCategoryIdx + 1) % PREDEFINED_CATEGORIES.length
        : (currentCategoryIdx - 1 + PREDEFINED_CATEGORIES.length) % PREDEFINED_CATEGORIES.length;
      setValues((prev) => ({ ...prev, category: PREDEFINED_CATEGORIES[nextIdx] }));
      return;
    }

    if (currentField === 'unit' && (key.leftArrow || key.rightArrow)) {
      const currentUnitIdx = Math.max(
        PREDEFINED_UNITS.indexOf(values.unit as (typeof PREDEFINED_UNITS)[number]),
        0,
      );
      const nextIdx = key.rightArrow
        ? (currentUnitIdx + 1) % PREDEFINED_UNITS.length
        : (currentUnitIdx - 1 + PREDEFINED_UNITS.length) % PREDEFINED_UNITS.length;
      setValues((prev) => ({ ...prev, unit: PREDEFINED_UNITS[nextIdx] }));
      return;
    }

    if (currentField !== 'unit' && currentField !== 'category') {
      if (key.backspace || key.delete) {
        setValues((prev) => ({
          ...prev,
          [currentField]: prev[currentField].slice(0, -1),
        }));
      } else if (input && input.length === 1 && !key.ctrl && !key.meta) {
        if (currentField === 'quantity' && !/[0-9.]/.test(input)) return;
        setValues((prev) => ({
          ...prev,
          [currentField]: prev[currentField] + input,
        }));
      }
    }
  });

  const renderTextField = (field: Exclude<FieldType, 'unit'>, isFocused: boolean) => {
    const value = values[field];
    return (
      <Box backgroundColor={BG} flexGrow={1} paddingX={1}>
        <Text backgroundColor={BG} color='gray'></Text>
        <Text backgroundColor={BG} color={FG}>
          {value}
        </Text>
        {isFocused && (
          <Text backgroundColor={BG} color='yellow'>
            █
          </Text>
        )}
        <Box flexGrow={1} backgroundColor={BG} />
        <Text backgroundColor={BG} color='gray'></Text>
      </Box>
    );
  };

  const renderUnitField = (isFocused: boolean) => {
    return (
      <Box backgroundColor={BG} flexGrow={1} justifyContent='center' paddingX={1}>
        <Text backgroundColor={BG} color='gray'>
          {' '}
        </Text>
        <Text backgroundColor={BG} color={isFocused ? 'yellow' : FG}>
          {isFocused ? '◀ ' : ''}
          {toDisplayUnit(values.unit, language)}
          {isFocused ? ' ▶' : ''}
        </Text>
        <Text backgroundColor={BG} color='gray'>
          {' '}
        </Text>
      </Box>
    );
  };

  const renderCategoryField = (isFocused: boolean) => {
    return (
      <Box backgroundColor={BG} flexGrow={1} justifyContent='center' paddingX={1}>
        <Text backgroundColor={BG} color='gray'>
          {' '}
        </Text>
        <Text backgroundColor={BG} color={isFocused ? 'yellow' : FG}>
          {isFocused ? '◀ ' : ''}
          {t(`inventory.category.${values.category}`, language)}
          {isFocused ? ' ▶' : ''}
        </Text>
        <Text backgroundColor={BG} color='gray'>
          {' '}
        </Text>
      </Box>
    );
  };

  return (
    <Box backgroundColor={BG} flexDirection='column'>
      <Box
        flexDirection='column'
        borderStyle='double'
        borderColor='yellow'
        padding={1}
        backgroundColor={BG}
      >
        <Text bold color='yellow' backgroundColor={BG}>
          {item
            ? t('inventory.modal.editTitle', language)
            : t('inventory.modal.addTitle', language)}
        </Text>

        <Newline />

        {fields.map((field, idx) => {
          const isFocused = idx === activeIdx;
          const isUnitField = field === 'unit';
          const isCategoryField = field === 'category';

          return (
            <Box key={field} backgroundColor={BG}>
              <Box width={12} backgroundColor={BG}>
                <Text backgroundColor={BG} color={isFocused ? 'yellow' : FG} bold={isFocused}>
                  {isFocused
                    ? `> ${t(`inventory.field.${field}`, language)}:`
                    : `  ${t(`inventory.field.${field}`, language)}:`}
                </Text>
              </Box>

              <Box backgroundColor={BG} flexGrow={1}>
                {isCategoryField
                  ? renderCategoryField(isFocused)
                  : isUnitField
                    ? renderUnitField(isFocused)
                    : renderTextField(field as Exclude<FieldType, 'unit' | 'category'>, isFocused)}
              </Box>
            </Box>
          );
        })}

        <Newline />
        <Box flexDirection='column' backgroundColor={BG}>
          <Text dimColor backgroundColor={BG}>
            {t('inventory.modal.hint.base', language)}
          </Text>
          {fields[activeIdx] === 'unit' && (
            <Text color='yellow' backgroundColor={BG}>
              {t('inventory.modal.hint.unit', language)}
            </Text>
          )}
          {fields[activeIdx] === 'category' && (
            <Text color='yellow' backgroundColor={BG}>
              {t('inventory.modal.hint.category', language)}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
};

export default EditItemModal;
