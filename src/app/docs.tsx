import { Stack } from 'expo-router';
import { useState } from 'react';

import { DocsList } from '@/components/docs-list';

export default function DocsScreen() {
  const [query, setQuery] = useState('');
  return (
    <>
      <Stack.SearchBar
        placeholder="Buscar en la API"
        autoCapitalize="none"
        hideWhenScrolling={false}
        onChangeText={(e) => setQuery(e.nativeEvent.text)}
      />
      <DocsList query={query} />
    </>
  );
}
