import React from 'react';
import { Text, Box, useInput } from 'ink';
import { t } from '../../services/i18n';

export type ViewMode = 'list' | 'grid';

export interface HeaderProps {
  title: string; // kept for compatibility, not rendered
  viewMode: ViewMode;
  onToggleView: () => void;
  showViewToggle?: boolean;
  searchQuery: string;
  onSearchChange: (value: string | ((prev: string) => string)) => void;
  isSearching: boolean;
  setIsSearching: (val: boolean) => void;
  isActive: boolean;
  language?: string;
}

export const Header: React.FC<HeaderProps> = ({
  viewMode,
  onToggleView,
  showViewToggle = true,
  onSearchChange,
  isSearching,
  setIsSearching,
  searchQuery,
  isActive,
  language = 'en',
}) => {
  useInput((input, key) => {
    if (!isActive) return;

    if (isSearching) {
      if (key.escape || key.return) {
        setIsSearching(false);
        return;
      }

      if (key.backspace || key.delete) {
        onSearchChange((prev) => prev.slice(0, -1));
      } else if (input && input.length === 1 && !key.ctrl && !key.meta) {
        onSearchChange((prev) => prev + input);
      }
      return;
    }

    if (showViewToggle && input === 'v') onToggleView();
    if (input === '/') setIsSearching(true);
  });

  return (
    <Box width='100%' flexDirection='column'>
      <Box width='100%' flexDirection='row' alignItems='center' justifyContent='space-between'>
        <Box flexGrow={1}>
          {isSearching ? (
            <Box flexGrow={0.65} borderStyle='single' borderColor='yellow'>
              <Text bold color='yellow'>
                {t('common.search', language)}{' '}
              </Text>
              <Text>{searchQuery}</Text>
              <Text inverse>_</Text>
              <Text dimColor> {t('common.searchExitHint', language)}</Text>
            </Box>
          ) : (
            <Box flexGrow={0.65} borderStyle='single'>
              <Text dimColor> {t('common.searchPrompt', language)}</Text>
            </Box>
          )}
        </Box>

        {showViewToggle ? (
          <Box flexDirection='row' gap={2}>
            <Text color={viewMode === 'list' ? 'green' : 'gray'}>≡</Text>
            <Text color={viewMode === 'grid' ? 'green' : 'gray'}>▦</Text>
            <Text dimColor>[v]</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
};
