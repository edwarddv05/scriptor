import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { seedExamples } from '@/lib/scripts';
import { colors } from '@/theme';

seedExamples();

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
        <Stack.Screen name="index" options={{ title: 'Scripts', headerLargeTitle: true }} />
        <Stack.Screen name="script/[name]" options={{ title: '' }} />
        {/* Sheets use the raised background so they stand apart from the black screen behind. */}
        <Stack.Screen
          name="docs"
          options={{ title: 'Documentación', presentation: 'modal', contentStyle: { backgroundColor: colors.raised } }}
        />
        <Stack.Screen
          name="run/[name]"
          options={{ title: 'Ejecutar', presentation: 'modal', contentStyle: { backgroundColor: colors.raised } }}
        />
        <Stack.Screen
          name="x-callback/[...path]"
          options={{ headerShown: false, presentation: 'transparentModal', animation: 'none' }}
        />
      </Stack>
    </ThemeProvider>
  );
}
