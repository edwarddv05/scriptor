import { useMemo } from 'react';
import { SectionList, StyleSheet, Text, View } from 'react-native';

import { API_DOCS } from '@/lib/api-docs';
import { colors, spacing, type } from '@/theme';

/** The API reference, filtered by `query`. Used by the Docs sheet and the iPad side panel. */
export function DocsList({ query, header }: { query: string; header?: React.ReactElement }) {
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return API_DOCS.map((s) => ({
      title: s.title,
      summary: s.summary,
      data: q ? s.items.filter((i) => `${i.name} ${i.signature} ${i.description}`.toLowerCase().includes(q)) : s.items,
    })).filter((s) => s.data.length > 0);
  }, [query]);

  return (
    <SectionList
      contentInsetAdjustmentBehavior="automatic"
      sections={sections}
      keyExtractor={(item) => item.name + item.signature}
      stickySectionHeadersEnabled={false}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      contentContainerStyle={styles.content}
      ListEmptyComponent={<Text style={[type.footnote, styles.empty]}>Nada en la API coincide con «{query}».</Text>}
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHeader}>
          <Text style={type.title}>{section.title}</Text>
          <Text style={type.footnote}>{section.summary}</Text>
        </View>
      )}
      renderItem={({ item }) => (
        <View style={styles.item}>
          <Text selectable style={[type.code, styles.signature]}>{item.signature}</Text>
          <Text style={type.body}>{item.description}</Text>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xl },
  sectionHeader: { paddingHorizontal: spacing.md, paddingTop: spacing.lg, paddingBottom: spacing.sm, gap: 4 },
  item: {
    marginHorizontal: spacing.md,
    paddingVertical: 10,
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
  },
  signature: { color: colors.accent, fontWeight: '600' },
  empty: { textAlign: 'center', marginTop: spacing.xl },
});
