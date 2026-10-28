import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ConsoleView, RunStatus } from '@/components/console-view';
import { startRun, stopRun, useRun } from '@/lib/runner';
import { listScripts, readScript } from '@/lib/scripts';
import { colorFor, colors, scriptColors, spacing, type } from '@/theme';

/**
 * Runs a script and shows its console. Also the target of scriptor://run/<name>?key=value,
 * whose query parameters become Script.input.
 */
export default function RunScreen() {
  const { name, ...params } = useLocalSearchParams<{ name: string }>();
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRun(runId);
  const tint = useMemo(() => {
    const script = listScripts().find((s) => s.name === name);
    return scriptColors[colorFor(script ?? { name })][1];
  }, [name]);

  // Starting the run is the external side effect; its id is stored to follow the logs.
  // Runs once per opened screen.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    try {
      setRunId(startRun(name, readScript(name), params));
    } catch {
      setError(`No existe el script «${name}». Revisa el nombre en el atajo o el enlace.`);
    }
  }, [name]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  return (
    <>
      <Stack.Screen options={{ title: name }} />
      {!error && (
        <Stack.Toolbar placement="right">
          {run?.status === 'running' ? (
            <Stack.Toolbar.Button icon="stop.fill" accessibilityLabel="Detener" variant="prominent" tintColor={colors.danger} onPress={() => stopRun(runId!)} />
          ) : (
            <Stack.Toolbar.Button
              icon="arrow.clockwise"
              accessibilityLabel="Ejecutar de nuevo"
              variant="prominent"
              tintColor={tint}
              onPress={() => setRunId(startRun(name, readScript(name), params))}
            />
          )}
        </Stack.Toolbar>
      )}
      {error ? (
        <View style={styles.center}>
          <Text style={[type.body, styles.error]}>{error}</Text>
        </View>
      ) : (
        <View style={styles.flex}>
          <RunStatus run={run} />
          <ConsoleView run={run} tint={tint} />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  error: { color: colors.danger, textAlign: 'center' },
});
