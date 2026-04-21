import React, { useState } from 'react';
import { render, Text, Box, useInput } from 'ink';
import { initDb } from './db/db';

// IMPORTANT: Import screens only after DB initialization
// so no DB queries run during module load before migrations finish.
await initDb;

const { Inventory } = await import('./screens/Inventory.tsx');
const { RecipesView } = await import('./screens/RecipesView.tsx');
const { ShoppingLists } = await import('./screens/ShoppingLists.tsx');
const { Planner } = await import('./screens/Planner.tsx');
const { Dashboard } = await import('./screens/Dashboard.tsx');
const { Settings } = await import('./screens/Settings.tsx');
const { getOrCreateAppSettings } = await import('./db/settingsRepo');

type Tab = 'Dashboard' | 'Inventory' | 'Recipes' | 'Planner' | 'Shopping List' | 'Settings';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('Dashboard');
  const [navigationLocked, setNavigationLocked] = useState(false);

  const [activeRecipeTitle, setActiveRecipeTitle] = useState<string | null>(null);

  const initialSettings = getOrCreateAppSettings();
  const [language, setLanguage] = useState<string>(initialSettings?.language ?? 'en');

  // Keyboard Navigation
  useInput((input) => {
    if (navigationLocked) return;
    if (input === 'q') process.exit(0);

    if (input === '1') setActiveTab('Dashboard');
    if (input === '2') setActiveTab('Inventory');
    if (input === '3') setActiveTab('Recipes');
    if (input === '4') setActiveTab('Planner');
    if (input === '5') setActiveTab('Shopping List');
    if (input === '6') setActiveTab('Settings');
  });

  const PlaceholderScreen: React.FC<{ title: string }> = ({ title }) => (
    <Box flexGrow={1} padding={1}>
      <Text>{title} Content...</Text>
    </Box>
  );

  // Shorten long recipe names
  const menuRecipeTitle =
    activeRecipeTitle && activeRecipeTitle.length > 22
      ? `${activeRecipeTitle.slice(0, 19)}...`
      : activeRecipeTitle;

  const menuEntries = [
    { key: 'Dashboard', label: '[1] Dashboard' },
    { key: 'Inventory', label: '[2] Inventory' },
    { key: 'Recipes', label: '[3] Recipes' },
    ...(activeRecipeTitle ? [{ key: 'ActiveRecipe', label: ` └─ ${menuRecipeTitle}` }] : []),
    { key: 'Planner', label: '[4] Planner' },
    { key: 'Shopping List', label: '[5] Shopping List' },
    { key: 'Settings', label: '[6] Settings' },
  ] as const;

  return (
    <Box flexDirection='column' width='100%' height='100%' paddingLeft={2} paddingRight={2}>
      {/* Logo */}
      <Box width='100%' justifyContent='center'>
        <Text>{`
                  ▄▄▄▄▄▄▄
                ▄███████████▄
                ▀███████████▀
                  ▀██████▀
                   █████
        ██      ▄▄▄  ▄▄▄▄▄ ▄▄ ▄▄ ▄█████ ▄▄ ▄▄ ▄▄▄▄▄ ▄▄▄▄▄ 
        ██     ██▀██   ▄█▀ ▀███▀ ██     ██▄██ ██▄▄  ██▄▄  
        ██████ ██▀██ ▄██▄▄   █   ▀█████ ██ ██ ██▄▄▄ ██    
        `}</Text>
      </Box>

      <Box flexDirection='row' flexGrow={1} width='100%'>
        {/* MENU */}
        <Box
          flexDirection='column'
          borderStyle='single'
          width={26}
          padding={1}
          justifyContent='space-between'
        >
          <Box flexDirection='column'>
            {menuEntries.map((entry) => {
              const isActive =
                entry.key === activeTab ||
                (entry.key === 'ActiveRecipe' && activeTab === 'Recipes');

              return (
                <Text key={entry.key} color={isActive ? 'yellow' : 'white'}>
                  {entry.label}
                </Text>
              );
            })}
          </Box>

          <Text color='red'>[q] Quit</Text>
        </Box>

        {/* SCREEN AREA */}
        <Box borderStyle='single' flexGrow={1} padding={1}>
          {activeTab === 'Dashboard' && <Dashboard onNavigate={setActiveTab} language={language} />}

          {activeTab === 'Inventory' && (
            <Inventory language={language} onNavigationLockChange={setNavigationLocked} />
          )}

          {activeTab === 'Recipes' && (
            <RecipesView
              onNavigationLockChange={setNavigationLocked}
              onActiveRecipeTitleChange={setActiveRecipeTitle}
              language={language}
            />
          )}

          {activeTab === 'Planner' && <Planner language={language} />}

          {activeTab === 'Shopping List' && (
            <ShoppingLists onNavigationLockChange={setNavigationLocked} language={language} />
          )}

          {activeTab === 'Settings' && <Settings onLanguageChanged={setLanguage} />}
        </Box>
      </Box>
    </Box>
  );
};

render(<App />);
