import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { seedExamples } from '@/lib/scripts';

seedExamples();

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Scripts', headerLargeTitle: true }} />
        <Stack.Screen name="script/[name]" options={{ title: '' }} />
        <Stack.Screen name="docs" options={{ title: 'Documentación', presentation: 'modal' }} />
        <Stack.Screen name="run/[name]" options={{ title: 'Ejecutar', presentation: 'modal' }} />
        <Stack.Screen
          name="x-callback/[...path]"
          options={{ headerShown: false, presentation: 'transparentModal', animation: 'none' }}
        />
      </Stack>
    </ThemeProvider>
  );
}
