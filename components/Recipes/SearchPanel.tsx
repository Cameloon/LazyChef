import React from 'react';
import { Box, Text } from 'ink';
import { t } from '../../services/i18n';

// Render compact search feedback for the recipes list header
export type RecipeSearchPanelProps = {
  isSearching: boolean;
  visualValue: string;
  activeQuery: string;
  idleHint: string;
  allergenLegend?: string | null;
  language: string;
};

export const RecipeSearchPanel: React.FC<RecipeSearchPanelProps> = ({
  isSearching,
  visualValue,
  activeQuery,
  idleHint,
  allergenLegend,
  language,
}) => {
  const hasActiveFilter = activeQuery.trim().length > 0;

  return (
    <Box flexDirection='column'>
      {isSearching ? (
        <Box>
          <Text bold color='yellow'>
            {t('recipes.search.label', language)}{' '}
          </Text>
          <Text>{visualValue}</Text>
          <Text inverse>_</Text>
          <Text dimColor> {t('recipes.search.exitHint', language)}</Text>
        </Box>
      ) : hasActiveFilter ? (
        <Box>
          <Text bold color='yellow'>
            {t('recipes.search.label', language)}{' '}
          </Text>
          <Text>{activeQuery}</Text>
          <Text dimColor> {t('recipes.search.filtered', language)}</Text>
        </Box>
      ) : (
        <Box>
          <Text dimColor>{idleHint}</Text>
          <Text dimColor> | {t('recipes.detail.favorite', language)}</Text>
          <Text>★ </Text>
          {allergenLegend ? <Text dimColor> | {allergenLegend}</Text> : null}
        </Box>
      )}
    </Box>
  );
};
