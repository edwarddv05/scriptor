import { Link, router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { ScriptTile } from '@/components/script-tile';
import {
  deleteScript,
  isValidName,
  listScripts,
  NEW_SCRIPT,
  readScript,
  renameScript,
  setAppearance,
  uniqueName,
  writeScript,
  type ScriptFile,
} from '@/lib/scripts';
import {
  colorFor,
  colors,
  radius,
  scriptColorLabels,
  scriptColors,
  scriptGlyphs,
  spacing,
  type,
  type ScriptColor,
  type ScriptGlyph,
} from '@/theme';

const GAP = 12;

function askName(title: string, initial: string, onDone: (name: string) => void) {
  Alert.prompt(title, undefined, (value) => {
    const name = value?.trim();
    if (!name) return;
    if (!isValidName(name)) return Alert.alert('Nombre no válido', 'No uses / \\ : * ? " < > |');
    onDone(name);
  }, 'plain-text', initial);
}

const openEditor = (name: string) => router.push({ pathname: '/script/[name]', params: { name } });
const runScript = (name: string) => router.push({ pathname: '/run/[name]', params: { name } });

export default function ScriptsScreen() {
  const [scripts, setScripts] = useState<ScriptFile[]>([]);
  const [query, setQuery] = useState('');
  const { width } = useWindowDimensions();
  const refresh = useCallback(() => setScripts(listScripts()), []);
  useFocusEffect(refresh);

  // Two columns on iPhone; iPad fits as many ~200 pt tiles as the width allows.
  const minTile = width >= 700 ? 200 : 150;
  const columns = Math.max(2, Math.floor((width - spacing.md * 2 + GAP) / (minTile + GAP)));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scripts;
    return scripts.filter((s) => `${s.name} ${s.summary ?? ''}`.toLowerCase().includes(q));
  }, [scripts, query]);

  const attempt = (action: () => void) => {
    try {
      action();
      refresh();
    } catch (e) {
      Alert.alert('No se pudo completar', String(e));
    }
  };

  const create = () => {
    askName('Nuevo script', uniqueName('Sin título'), (name) => {
      if (scripts.some((s) => s.name === name)) return Alert.alert('Ya existe un script con ese nombre');
      writeScript(name, NEW_SCRIPT);
      openEditor(name);
    });
  };

  const remove = (script: ScriptFile) => {
    Alert.alert(`¿Eliminar "${script.name}"?`, 'El archivo se borra de la carpeta de Scriptor.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar', style: 'destructive', onPress: () => attempt(() => deleteScript(script.name)) },
    ]);
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Scripts', headerLargeTitle: true }} />
      <Stack.SearchBar placeholder="Buscar scripts" onChangeText={(e) => setQuery(e.nativeEvent.text)} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="book" accessibilityLabel="Documentación" onPress={() => router.push('/docs')} />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="plus" accessibilityLabel="Nuevo script" variant="prominent" onPress={create} />
      </Stack.Toolbar>
      <FlatList
        key={columns}
        style={styles.list}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        columnWrapperStyle={styles.row}
        numColumns={columns}
        data={visible}
        keyExtractor={(s) => s.name}
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          query ? (
            <Text style={[type.footnote, styles.empty]}>Ningún script coincide con «{query}».</Text>
          ) : (
            <View style={styles.emptyBox}>
              <Text style={type.title}>Aún no hay scripts</Text>
              <Text style={[type.footnote, styles.center]}>
                Crea uno aquí o copia archivos .js a Scriptor desde la app Archivos.
              </Text>
              <Pressable accessibilityRole="button" onPress={create} style={({ pressed }) => [styles.cta, pressed && { opacity: 0.7 }]}>
                <Text style={styles.ctaText}>Crear script</Text>
              </Pressable>
            </View>
          )
        }
        renderItem={({ item }) => (
          <View style={{ flex: 1 / columns }}>
            <Link href={{ pathname: '/script/[name]', params: { name: item.name } }} asChild>
              <Link.Trigger withAppleZoom>
                <ScriptTile script={item} onRun={() => runScript(item.name)} />
              </Link.Trigger>
              <Link.Menu>
                <Link.MenuAction title="Ejecutar" icon="play.fill" onPress={() => runScript(item.name)} />
                <Link.MenuAction title="Editar" icon="chevron.left.forwardslash.chevron.right" onPress={() => openEditor(item.name)} />
                <Link.Menu title="Color" icon="paintpalette">
                  {(Object.keys(scriptColors) as ScriptColor[]).map((c) => (
                    <Link.MenuAction
                      key={c}
                      title={scriptColorLabels[c]}
                      isOn={colorFor(item) === c}
                      onPress={() => attempt(() => setAppearance(item, { color: c }))}
                    />
                  ))}
                </Link.Menu>
                <Link.Menu title="Icono" icon="square.grid.2x2" elementSize="small">
                  {(Object.keys(scriptGlyphs) as ScriptGlyph[]).map((g) => (
                    <Link.MenuAction
                      key={g}
                      icon={scriptGlyphs[g]}
                      isOn={item.glyph === g}
                      onPress={() => attempt(() => setAppearance(item, { glyph: g }))}
                    />
                  ))}
                </Link.Menu>
                <Link.MenuAction
                  title="Renombrar"
                  icon="pencil"
                  onPress={() => askName('Renombrar', item.name, (to) => attempt(() => renameScript(item.name, to)))}
                />
                <Link.MenuAction
                  title="Duplicar"
                  icon="plus.square.on.square"
                  onPress={() => attempt(() => writeScript(uniqueName(`${item.name} copia`), readScript(item.name)))}
                />
                <Link.MenuAction title="Eliminar" icon="trash" destructive onPress={() => remove(item)} />
              </Link.Menu>
            </Link>
          </View>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: { backgroundColor: colors.canvas },
  content: { padding: spacing.md, gap: GAP },
  row: { gap: GAP },
  empty: { textAlign: 'center', marginTop: spacing.xl },
  emptyBox: { alignItems: 'center', gap: spacing.sm, marginTop: 96, paddingHorizontal: spacing.xl },
  center: { textAlign: 'center' },
  cta: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  ctaText: { color: colors.onTile, fontSize: 16, fontWeight: '600' },
});
