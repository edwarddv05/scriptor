import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { displayName, fileKind, type ScriptFile } from '@/lib/scripts';
import { colorFor, colors, glyphFor, radius, scriptColors, spacing, type } from '@/theme';

const liquidGlass = isLiquidGlassAvailable();

type Props = {
  script: ScriptFile;
  onPress?: () => void;
  onRun: () => void;
};

/** A script in the grid: its color as a gradient slab, glyph, name and first comment line. */
export function ScriptTile({ script, onPress, onRun }: Props) {
  const [top, bottom] = scriptColors[colorFor(script)];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${script.app ? 'Miniapp' : 'Script'} ${script.name}, ${fileKind(script.name)}`}
      accessibilityHint="Abre el editor. Mantén pulsado para más opciones."
      style={({ pressed }) => [
        styles.tile,
        { backgroundImage: `linear-gradient(160deg, ${top}, ${bottom})` },
        pressed && styles.pressed,
      ]}>
      <View style={styles.top}>
        <SymbolView name={glyphFor(script)} size={24} tintColor={colors.onTile} weight="semibold" />
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{fileKind(script.name)}</Text>
        </View>
        <Pressable
          onPress={onRun}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Ejecutar ${script.name}`}
          style={({ pressed }) => pressed && styles.runPressed}>
          <GlassView glassEffectStyle="clear" isInteractive tintColor="rgba(255,255,255,0.18)" style={[styles.run, !liquidGlass && styles.runFallback]}>
            <SymbolView name="play.fill" size={15} tintColor={colors.onTile} />
          </GlassView>
        </Pressable>
      </View>
      <View style={styles.text}>
        <Text style={type.tileName} numberOfLines={2}>
          {/* Miniapps and Python scripts keep their extension on disk; the tile shows it without. */}
          {displayName(script.name)}
        </Text>
        {script.summary ? (
          <Text style={type.tileSummary} numberOfLines={2}>
            {script.summary}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    height: 148,
    padding: spacing.md - 2,
    borderRadius: radius.tile,
    borderCurve: 'continuous',
    justifyContent: 'space-between',
    overflow: 'hidden',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28), 0 6px 16px rgba(0,0,0,0.10)',
  },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.92 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  run: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Before iOS 26 GlassView renders as a plain view.
  runFallback: { backgroundColor: 'rgba(255,255,255,0.22)' },
  runPressed: { opacity: 0.7 },
  badge: {
    marginLeft: spacing.xs,
    marginRight: 'auto',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  badgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4, color: colors.onTile },
  text: { gap: 3 },
});
