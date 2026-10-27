import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, Pressable, PlatformColor, StyleSheet, Text, View } from 'react-native';

import { IconButton } from '@/components/icon-button';
import {
  deleteScript,
  isValidName,
  listScripts,
  NEW_SCRIPT,
  readScript,
  renameScript,
  uniqueName,
  writeScript,
  type ScriptFile,
} from '@/lib/scripts';

const dateFormat = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' });

function askName(title: string, initial: string, onDone: (name: string) => void) {
  Alert.prompt(title, undefined, (value) => {
    const name = value?.trim();
    if (!name) return;
    if (!isValidName(name)) return Alert.alert('Nombre no válido', 'No uses / \\ : * ? " < > |');
    onDone(name);
  }, 'plain-text', initial);
}

export default function ScriptsScreen() {
  const [scripts, setScripts] = useState<ScriptFile[]>([]);
  const refresh = useCallback(() => setScripts(listScripts()), []);
  useFocusEffect(refresh);

  const create = () => {
    askName('Nuevo script', uniqueName('Sin título'), (name) => {
      if (scripts.some((s) => s.name === name)) return Alert.alert('Ya existe un script con ese nombre');
      writeScript(name, NEW_SCRIPT);
      router.push({ pathname: '/script/[name]', params: { name } });
    });
  };

  const showActions = (script: ScriptFile) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: script.name,
        options: ['Ejecutar', 'Renombrar', 'Duplicar', 'Eliminar', 'Cancelar'],
        destructiveButtonIndex: 3,
        cancelButtonIndex: 4,
      },
      (i) => {
        try {
          if (i === 0) router.push({ pathname: '/run/[name]', params: { name: script.name } });
          if (i === 1) {
            askName('Renombrar', script.name, (to) => {
              try {
                renameScript(script.name, to);
                refresh();
              } catch (e) {
                Alert.alert('No se pudo renombrar', String(e));
              }
            });
          }
          if (i === 2) {
            writeScript(uniqueName(`${script.name} copia`), readScript(script.name));
            refresh();
          }
          if (i === 3) {
            Alert.alert(`¿Eliminar "${script.name}"?`, 'No se puede deshacer.', [
              { text: 'Cancelar', style: 'cancel' },
              { text: 'Eliminar', style: 'destructive', onPress: () => { deleteScript(script.name); refresh(); } },
            ]);
          }
        } catch (e) {
          Alert.alert('Error', String(e));
        }
      },
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerLeft: () => <IconButton name="book" label="Documentación" onPress={() => router.push('/docs')} />,
          headerRight: () => <IconButton name="plus" label="Nuevo script" onPress={create} />,
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={scripts}
        keyExtractor={(s) => s.name}
        onRefresh={refresh}
        refreshing={false}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={<Text style={styles.empty}>No hay scripts. Pulsa + para crear uno.</Text>}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push({ pathname: '/script/[name]', params: { name: item.name } })}
            onLongPress={() => showActions(item)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.meta}>{dateFormat.format(item.modified)}</Text>
            </View>
            <IconButton
              name="play.fill"
              label={`Ejecutar ${item.name}`}
              onPress={() => router.push({ pathname: '/run/[name]', params: { name: item.name } })}
            />
          </Pressable>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    backgroundColor: PlatformColor('systemBackground'),
  },
  pressed: { backgroundColor: PlatformColor('systemGray5') },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 17, color: PlatformColor('label') },
  meta: { fontSize: 13, color: PlatformColor('secondaryLabel') },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16, backgroundColor: PlatformColor('separator') },
  empty: { textAlign: 'center', marginTop: 48, color: PlatformColor('secondaryLabel') },
});
