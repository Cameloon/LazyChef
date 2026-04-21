import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { getOrCreateAppSettings, updateAppSettings, type AppSettingsRow } from '../db/settingsRepo';
import { t } from '../services/i18n';

const HABITS = ['all', 'vegetarian', 'vegan'] as const;
const LANGUAGES = ['de', 'en'] as const;
const INTOLERANCES = ['none', 'lactose', 'gluten', 'lactose+gluten'] as const;

type Habit = (typeof HABITS)[number];
type Language = (typeof LANGUAGES)[number];
type Intolerances = (typeof INTOLERANCES)[number];

type FieldKey = 'intolerances' | 'eatingHabit' | 'defaultServings' | 'language';

const FIELD_ORDER: FieldKey[] = ['intolerances', 'eatingHabit', 'defaultServings', 'language'];

const FIELD_LABEL_KEYS: Record<FieldKey, string> = {
  intolerances: 'settings.field.intolerances',
  eatingHabit: 'settings.field.eatingHabit',
  defaultServings: 'settings.field.defaultServings',
  language: 'settings.field.language',
};

const cycleValue = <T,>(arr: readonly T[], current: T, direction: -1 | 1): T => {
  const idx = arr.indexOf(current);
  if (idx === -1) return arr[0] as T;
  return arr[(idx + direction + arr.length) % arr.length] as T;
};

const toDisplayHabit = (habit: string, language: string): string => {
  if (habit === 'vegetarian') return t('settings.value.habit.vegetarian', language);
  if (habit === 'vegan') return t('settings.value.habit.vegan', language);
  return t('settings.value.habit.all', language);
};

const toDisplayLanguage = (currentLanguage: string, language: string): string => {
  if (currentLanguage === 'en') return t('settings.value.language.english', language);
  return t('settings.value.language.german', language);
};

export const Settings: React.FC<{ onLanguageChanged?: (lang: string) => void }> = ({
  onLanguageChanged,
}) => {
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  });

  const [draft, setDraft] = useState<AppSettingsRow | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<AppSettingsRow | null>(null);
  const [selectedFieldIndex, setSelectedFieldIndex] = useState(0);
  const [status, setStatus] = useState<string>('');
  const uiLanguage = draft?.language ?? 'en';

  useEffect(() => {
    const onResize = () => {
      setTerminalSize({
        columns: stdout?.columns || 80,
        rows: stdout?.rows || 24,
      });
    };

    stdout?.on('resize', onResize);
    return () => {
      stdout?.off('resize', onResize);
    };
  }, [stdout]);

  useEffect(() => {
    const initial = getOrCreateAppSettings();
    setDraft(initial);
    setSavedSnapshot(initial);
  }, []);

  const screenWidth = Math.max(50, Math.floor(terminalSize.columns * 0.8));
  const screenHeight = Math.max(14, Math.floor(terminalSize.rows * 0.7));

  const selectedKey = useMemo(
    () => FIELD_ORDER[selectedFieldIndex] ?? FIELD_ORDER[0],
    [selectedFieldIndex],
  );

  const hasUnsavedChanges = useMemo(() => {
    if (!draft || !savedSnapshot) return false;

    return (
      draft.intolerances !== savedSnapshot.intolerances ||
      draft.eatingHabit !== savedSnapshot.eatingHabit ||
      draft.defaultServings !== savedSnapshot.defaultServings ||
      draft.language !== savedSnapshot.language
    );
  }, [draft, savedSnapshot]);

  const mutateDraft = (mutator: (current: AppSettingsRow) => AppSettingsRow) => {
    setStatus('');
    setDraft((prev) => {
      if (!prev) return prev;
      return mutator(prev);
    });
  };

  const changeFieldValue = (direction: -1 | 1) => {
    if (!draft) return;

    if (selectedKey === 'intolerances') {
      mutateDraft((current) => ({
        ...current,
        intolerances: cycleValue(INTOLERANCES, current.intolerances as Intolerances, direction),
      }));
      return;
    }

    if (selectedKey === 'eatingHabit') {
      mutateDraft((current) => ({
        ...current,
        eatingHabit: cycleValue(HABITS, current.eatingHabit as Habit, direction),
      }));
      return;
    }

    if (selectedKey === 'defaultServings') {
      mutateDraft((current) => ({
        ...current,
        defaultServings: Math.max(1, Math.min(20, current.defaultServings + direction)),
      }));
      return;
    }

    mutateDraft((current) => ({
      ...current,
      language: cycleValue(LANGUAGES, current.language as Language, direction),
    }));
  };

  useInput((input, key) => {
    if (!draft) return;

    if (key.upArrow) {
      setSelectedFieldIndex((prev) => (prev - 1 + FIELD_ORDER.length) % FIELD_ORDER.length);
      return;
    }

    if (key.downArrow) {
      setSelectedFieldIndex((prev) => (prev + 1) % FIELD_ORDER.length);
      return;
    }

    if (key.leftArrow || input === '-') {
      changeFieldValue(-1);
      return;
    }

    if (key.rightArrow || input === '+' || key.return) {
      changeFieldValue(1);
      return;
    }

    if (input.toLowerCase() === 's') {
      const { id, ...patch } = draft;
      const updated = updateAppSettings(patch);
      setDraft(updated);
      setSavedSnapshot(updated);
      setStatus(
        t('settings.status.saved', updated.language, { time: new Date().toLocaleTimeString() }),
      );
      if (onLanguageChanged) onLanguageChanged(updated.language);
      return;
    }

    if (input.toLowerCase() === 'r') {
      setDraft((current) => {
        if (!current) return current;
        return {
          ...current,
          intolerances: 'none',
          lactoseIntolerance: 0,
          glutenIntolerance: 0,
          eatingHabit: 'all',
          defaultServings: 1,
          language: 'en',
        };
      });
      setStatus(t('settings.status.defaultsApplied', uiLanguage));
      return;
    }
  });

  if (!draft) {
    return (
      <Box width={screenWidth} height={screenHeight} paddingLeft={2} paddingRight={1}>
        <Text>{t('settings.loading', uiLanguage)}</Text>
      </Box>
    );
  }

  const values: Record<FieldKey, string> = {
    intolerances: t(`settings.value.intolerance.${draft.intolerances}`, uiLanguage),
    eatingHabit: toDisplayHabit(draft.eatingHabit, uiLanguage),
    defaultServings: String(draft.defaultServings),
    language: toDisplayLanguage(draft.language, uiLanguage),
  };

  const statusText =
    status || (hasUnsavedChanges ? t('settings.status.notSavedYet', uiLanguage) : '');

  return (
    <Box
      flexDirection='column'
      height={screenHeight}
      width={screenWidth}
      paddingLeft={2}
      paddingRight={1}
    >
      <Box marginBottom={1} flexDirection='column' borderStyle='single' paddingLeft={1}>
        <Text color='gray' dimColor>
          {t('settings.hint.controls', uiLanguage)}
        </Text>
      </Box>

      <Box flexDirection='column'>
        {FIELD_ORDER.map((fieldKey, idx) => {
          const selected = idx === selectedFieldIndex;
          return (
            <Text key={fieldKey} color={selected ? 'yellow' : 'white'}>
              {selected ? '>' : ' '} {t(FIELD_LABEL_KEYS[fieldKey], uiLanguage)}: {values[fieldKey]}
            </Text>
          );
        })}
      </Box>

      {statusText ? (
        <Box marginTop={1} flexDirection='column'>
          <Text color='yellow'>{statusText}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
