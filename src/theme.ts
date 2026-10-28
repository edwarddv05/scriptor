import type { SymbolViewProps } from 'expo-symbols';
import { PlatformColor, type TextStyle } from 'react-native';

export type SymbolName = SymbolViewProps['name'];

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const radius = { sm: 10, md: 16, tile: 24, panel: 28, full: 9999 } as const;

export const colors = {
  label: PlatformColor('label'),
  secondaryLabel: PlatformColor('secondaryLabel'),
  tertiaryLabel: PlatformColor('tertiaryLabel'),
  separator: PlatformColor('separator'),
  canvas: PlatformColor('systemGroupedBackground'),
  surface: PlatformColor('systemBackground'),
  raised: PlatformColor('secondarySystemBackground'),
  fill: PlatformColor('tertiarySystemFill'),
  accent: PlatformColor('systemBlue'),
  danger: PlatformColor('systemRed'),
  warning: PlatformColor('systemOrange'),
  success: PlatformColor('systemGreen'),
  // Text on a script's color tile stays white in both modes.
  onTile: '#FFFFFF',
  onTileMuted: 'rgba(255,255,255,0.78)',
};

export const type = {
  tileName: { fontSize: 17, fontWeight: '700', letterSpacing: -0.2, color: colors.onTile },
  tileSummary: { fontSize: 13, lineHeight: 17, fontWeight: '500', color: colors.onTileMuted },
  title: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3, color: colors.label },
  headline: { fontSize: 15, fontWeight: '600', color: colors.label },
  body: { fontSize: 15, lineHeight: 21, color: colors.label },
  footnote: { fontSize: 13, color: colors.secondaryLabel },
  code: { fontFamily: 'Menlo', fontSize: 12.5, lineHeight: 18 },
} as const satisfies Record<string, TextStyle>;

/**
 * Script colors, keyed by the names Scriptable writes in `// icon-color: …` so imported
 * scripts keep their color. Each pair is the top and bottom of the tile gradient.
 */
export const scriptColors = {
  red: ['#F0625F', '#D33A3F'],
  pink: ['#EC5AA8', '#C93A88'],
  purple: ['#A970DB', '#8447BD'],
  'deep-purple': ['#8370E0', '#5D47C4'],
  'deep-blue': ['#5A7BEA', '#3654C9'],
  blue: ['#3AA2F5', '#1479D6'],
  'light-blue': ['#4FC0E8', '#1E97C7'],
  cyan: ['#2FC2CF', '#0E98A8'],
  teal: ['#2DB89D', '#128A74'],
  'deep-green': ['#3FAE78', '#22844F'],
  green: ['#6CC05A', '#459A39'],
  'light-green': ['#A1C94E', '#7AA22D'],
  yellow: ['#F2BE3A', '#D69A12'],
  orange: ['#FA8A3C', '#E0621A'],
  brown: ['#BB906A', '#93694A'],
  gray: ['#9A9CA6', '#737683'],
  'deep-gray': ['#6E717F', '#4B4E5B'],
} as const satisfies Record<string, readonly [string, string]>;

export type ScriptColor = keyof typeof scriptColors;

export const scriptColorLabels: Record<ScriptColor, string> = {
  red: 'Rojo',
  pink: 'Rosa',
  purple: 'Morado',
  'deep-purple': 'Violeta',
  'deep-blue': 'Añil',
  blue: 'Azul',
  'light-blue': 'Celeste',
  cyan: 'Cian',
  teal: 'Turquesa',
  'deep-green': 'Verde oscuro',
  green: 'Verde',
  'light-green': 'Lima',
  yellow: 'Amarillo',
  orange: 'Naranja',
  brown: 'Marrón',
  gray: 'Gris',
  'deep-gray': 'Grafito',
};

/** Scriptable glyph names (Font Awesome) and the SF Symbol drawn for each. */
export const scriptGlyphs = {
  code: 'chevron.left.forwardslash.chevron.right',
  terminal: 'apple.terminal.fill',
  magic: 'wand.and.stars',
  bolt: 'bolt.fill',
  download: 'arrow.down.circle.fill',
  'paper-plane': 'paperplane.fill',
  video: 'video.fill',
  camera: 'camera.fill',
  image: 'photo.fill',
  music: 'music.note',
  microphone: 'mic.fill',
  headphones: 'headphones',
  calendar: 'calendar',
  clock: 'clock.fill',
  bell: 'bell.fill',
  tasks: 'checklist',
  envelope: 'envelope.fill',
  comments: 'bubble.left.and.bubble.right.fill',
  globe: 'globe',
  'map-marker-alt': 'mappin.and.ellipse',
  sun: 'sun.max.fill',
  cloud: 'cloud.fill',
  leaf: 'leaf.fill',
  heart: 'heart.fill',
  star: 'star.fill',
  book: 'book.fill',
  'shopping-cart': 'cart.fill',
  'chart-line': 'chart.line.uptrend.xyaxis',
  'dollar-sign': 'dollarsign.circle.fill',
  key: 'key.fill',
  cog: 'gearshape.fill',
  'file-archive': 'archivebox.fill',
  car: 'car.fill',
  bicycle: 'bicycle',
  plane: 'airplane',
  tv: 'tv',
  gamepad: 'gamecontroller.fill',
  home: 'house.fill',
  user: 'person.fill',
  'exclamation-triangle': 'exclamationmark.triangle.fill',
  rocket: 'paperplane.circle.fill',
  link: 'link',
} as const satisfies Record<string, SymbolName>;

export type ScriptGlyph = keyof typeof scriptGlyphs;

const palette = Object.keys(scriptColors) as ScriptColor[];

/** The script's own color, or a stable one picked from its name so the grid stays varied. */
export function colorFor(script: { name: string; color?: string }): ScriptColor {
  if (script.color && script.color in scriptColors) return script.color as ScriptColor;
  let hash = 0;
  for (const ch of script.name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % (palette.length - 2)]; // skip the two grays
}

export function glyphFor(script: { glyph?: string }): SymbolName {
  return (script.glyph && scriptGlyphs[script.glyph as ScriptGlyph]) || scriptGlyphs.code;
}

export const motion = { fast: 150, base: 250 } as const;
