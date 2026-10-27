import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { PlatformColor, StyleSheet, Text, View } from 'react-native';

import { ConsoleView } from '@/components/console-view';
import { IconButton } from '@/components/icon-button';
import { startRun, stopRun, useRun } from '@/lib/runner';
import { readScript } from '@/lib/scripts';

/**
 * Runs a script and shows its console. Also the target of scriptor://run/<name>?key=value,
 * whose query parameters become Script.input.
 */
export default function RunScreen() {
  const { name, ...params } = useLocalSearchParams<{ name: string }>();
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRun(runId);

  // Starting the run is the external side effect; its id is stored to follow the logs.
  // Runs once per opened screen.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    try {
      setRunId(startRun(name, readScript(name), params));
    } catch {
      setError(`No existe el script "${name}".`);
    }
  }, [name]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  return (
    <>
      <Stack.Screen
        options={{
          title: name,
          headerRight: () =>
            run?.status === 'running' ? (
              <IconButton name="stop.fill" label="Detener" tint={PlatformColor('systemRed')} onPress={() => stopRun(runId!)} />
            ) : (
              <IconButton name="arrow.clockwise" label="Repetir" onPress={() => setRunId(startRun(name, readScript(name), params))} />
            ),
        }}
      />
      {error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : (
        <ConsoleView run={run} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { color: PlatformColor('systemRed'), fontSize: 16, textAlign: 'center' },
});
