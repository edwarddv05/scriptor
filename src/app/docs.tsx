import { useMemo, useState } from 'react';
import { PlatformColor, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';

import { API_DOCS } from '@/lib/api-docs';

export default function DocsScreen() {
  const [query, setQuery] = useState('');

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return API_DOCS.map((s) => ({
      title: s.title,
      summary: s.summary,
      data: q
        ? s.items.filter((i) => `${i.name} ${i.signature} ${i.description}`.toLowerCase().includes(q))
        : s.items,
    })).filter((s) => s.data.length > 0);
  }, [query]);

  return (
    <SectionList
      contentInsetAdjustmentBehavior="automatic"
      sections={sections}
      keyExtractor={(item) => item.name + item.signature}
      stickySectionHeadersEnabled={false}
      keyboardDismissMode="on-drag"
      ListHeaderComponent={
        <TextInput
          style={styles.search}
          placeholder="Buscar en la API"
          placeholderTextColor={PlatformColor('placeholderText')}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      }
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          <Text style={styles.summary}>{section.summary}</Text>
        </View>
      )}
      renderItem={({ item }) => (
        <View style={styles.item}>
          <Text selectable style={styles.signature}>{item.signature}</Text>
          <Text style={styles.description}>{item.description}</Text>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  search: {
    margin: 16,
    paddingHorizontal: 12,
    height: 38,
    borderRadius: 10,
    fontSize: 16,
    color: PlatformColor('label'),
    backgroundColor: PlatformColor('tertiarySystemFill'),
  },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6, gap: 4 },
  sectionTitle: { fontSize: 22, fontWeight: '700', color: PlatformColor('label') },
  summary: { fontSize: 14, color: PlatformColor('secondaryLabel') },
  item: { paddingHorizontal: 16, paddingVertical: 10, gap: 4 },
  signature: { fontFamily: 'Menlo', fontSize: 13, color: PlatformColor('systemBlue') },
  description: { fontSize: 15, color: PlatformColor('label') },
});
