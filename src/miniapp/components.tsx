// Views a miniapp draws with. Each takes a few plain props and maps them onto SwiftUI views
// from @expo/ui; `modifiers` passes raw SwiftUI modifiers on for anything not covered.

import {
  Button as NativeButton,
  ContentUnavailableView,
  Divider as NativeDivider,
  Form,
  GlassEffectContainer,
  HStack as NativeHStack,
  Image as NativeImage,
  Picker as NativePicker,
  ProgressView,
  RNHostView,
  ScrollView,
  Section as NativeSection,
  Slider as NativeSlider,
  Spacer as NativeSpacer,
  Stepper as NativeStepper,
  Text as NativeText,
  TextField as NativeTextField,
  Toggle as NativeToggle,
  VStack as NativeVStack,
  ZStack as NativeZStack,
  useNativeState,
} from '@expo/ui/swift-ui';
import {
  Animation,
  accessibilityAddTraits,
  accessibilityLabel,
  animation,
  aspectRatio,
  autocorrectionDisabled,
  background,
  buttonBorderShape,
  buttonStyle,
  clipShape,
  clipped,
  controlSize,
  disabled,
  font,
  foregroundStyle,
  frame,
  glassEffect,
  keyboardType,
  labelStyle,
  lineLimit,
  listStyle,
  monospacedDigit,
  multilineTextAlignment,
  offset,
  onLongPressGesture,
  onSubmit,
  onTapGesture,
  opacity,
  padding,
  pickerStyle,
  resizable,
  rotationEffect,
  scaleEffect,
  scrollDismissesKeyboard,
  tag,
  textFieldStyle,
  textInputAutocapitalization,
  textSelection,
  tint,
  createModifier,
  createModifierWithEventListener,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import { requireNativeModule, requireNativeView } from 'expo';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import React, { createContext, useContext, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { PlatformColor, type ColorValue } from 'react-native';
import { WebView as RNWebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';
import type { SFSymbol } from 'sf-symbols-typescript';

import { scriptColors, type ScriptColor } from '@/theme';

const liquidGlass = isLiquidGlassAvailable();

/** The running miniapp's color, used for "accent". */
export const TintContext = createContext<string>(scriptColors.blue[1]);
const InListContext = createContext(false);

const NAMED: Record<string, ColorValue> = {
  primary: PlatformColor('label'),
  secondary: PlatformColor('secondaryLabel'),
  tertiary: PlatformColor('tertiaryLabel'),
  danger: PlatformColor('systemRed'),
  background: PlatformColor('systemBackground'),
  surface: PlatformColor('secondarySystemBackground'),
  grouped: PlatformColor('systemGroupedBackground'),
};

/** 'accent', 'primary', 'secondary', 'danger', 'surface', a Scriptor color name ('orange') or any CSS color. */
export function resolveColor(value: unknown, accent: string): ColorValue | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (value === 'accent') return accent;
  if (value in NAMED) return NAMED[value];
  if (value in scriptColors) return scriptColors[value as ScriptColor][1];
  return value;
}

type FrameAlignment = 'center' | 'leading' | 'trailing' | 'top' | 'bottom' | 'topLeading' | 'topTrailing' | 'bottomLeading' | 'bottomTrailing';
type AnimationKind = 'default' | 'spring' | 'bouncy' | 'smooth' | 'snappy' | 'easeInOut' | 'easeIn' | 'easeOut' | 'linear';
type GlassShape = 'capsule' | 'circle' | 'rectangle' | 'roundedRectangle';
type Point = { x: number; y: number };
export type DragEvent = { phase: 'start' | 'change' | 'end'; translation: Point; predicted: Point; location: Point };
export type TapEvent = { x: number; y: number; width: number; height: number };
type Rotation3D = number | { angle: number; axis?: 'x' | 'y' | 'z'; anchor?: 'center' | 'leading' | 'trailing' | 'top' | 'bottom'; perspective?: number };
type Glass = boolean | 'regular' | 'clear' | { variant?: 'regular' | 'clear'; tint?: string; interactive?: boolean; shape?: GlassShape };

export type ViewProps = {
  padding?: number | { top?: number; bottom?: number; leading?: number; trailing?: number; horizontal?: number; vertical?: number };
  width?: number;
  height?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** As wide as the parent allows, content to the leading edge. */
  fill?: boolean;
  frameAlignment?: FrameAlignment;
  background?: string;
  radius?: number;
  /** Liquid Glass behind the view (a material before iOS 26). */
  glass?: Glass;
  opacity?: number;
  disabled?: boolean;
  onTap?: () => void;
  onLongPress?: () => void;
  /** Tap with where it landed and the view's size: tell the left third from the right. */
  onTapAt?: (event: TapEvent) => void;
  onDoubleTap?: () => void;
  /** true on touch down, false on release: hold to pause. */
  onHold?: (pressing: boolean) => void;
  /** A flick: 'left', 'right', 'up' or 'down'. Lists keep scrolling. */
  onSwipe?: (direction: 'left' | 'right' | 'up' | 'down') => void;
  /** The view follows the finger and springs back; "end" says how far and where it was heading. */
  onDrag?: (event: DragEvent) => void;
  /** axis: 'x' | 'y' | 'both'; follow: false keeps the view still; live: also send 'change'. */
  drag?: { axis?: 'x' | 'y' | 'both'; follow?: boolean; live?: boolean; minimumDistance?: number };
  /** Pinch to zoom, pan and double tap. 'peek' springs back on release, like a feed photo. */
  zoom?: boolean | { mode?: 'zoom' | 'peek'; maxScale?: number; doubleTap?: boolean; onZoom?: (scale: number) => void };
  /** Degrees around an axis (y by default), for flips and a cube between pages. */
  rotation3D?: Rotation3D;
  /** Moves the view by this many points without changing the layout. */
  x?: number;
  y?: number;
  scale?: number;
  /** Degrees, clockwise. */
  rotation?: number;
  /** Animates the changes above whenever `animateOn` changes. Nothing animates without it. */
  animation?: AnimationKind | { type: AnimationKind; duration?: number };
  animateOn?: unknown;
  modifiers?: ModifierConfig[];
};

function animationFor(value: ViewProps['animation']) {
  const kind = typeof value === 'object' && value ? value.type : (value ?? 'default');
  const duration = typeof value === 'object' && value ? value.duration : undefined;
  if (kind === 'spring' || kind === 'bouncy' || kind === 'smooth' || kind === 'snappy') return Animation[kind]();
  if (kind === 'easeIn' || kind === 'easeOut' || kind === 'easeInOut' || kind === 'linear') return Animation[kind]({ duration });
  return Animation.default;
}

// SwiftUI animates on a number or a boolean; anything else becomes a number that changes with it.
function animatedValue(value: unknown): number | boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return hash;
}

function glassModifiers(value: Glass, radius: number | undefined, accent: string): ModifierConfig[] {
  const options = typeof value === 'object' ? value : { variant: value === 'clear' ? ('clear' as const) : ('regular' as const) };
  const shape = options.shape ?? (radius !== undefined ? 'roundedRectangle' : 'capsule');
  if (!liquidGlass) return [background({ type: 'material', material: 'regular' }), clipShape(shape, radius)];
  return [
    glassEffect({
      glass: { variant: options.variant ?? 'regular', interactive: options.interactive, tint: resolveColor(options.tint, accent) },
      shape,
      cornerRadius: radius,
    }),
  ];
}

export function common(props: ViewProps, accent: string): ModifierConfig[] {
  const result: ModifierConfig[] = [];
  if (typeof props.padding === 'number') result.push(padding({ all: props.padding }));
  else if (props.padding) result.push(padding(props.padding));
  if (props.width !== undefined || props.height !== undefined) result.push(frame({ width: props.width, height: props.height }));
  const maxWidth = props.fill ? Infinity : props.maxWidth;
  if (maxWidth !== undefined || props.maxHeight !== undefined || props.minHeight !== undefined) {
    result.push(frame({ maxWidth, maxHeight: props.maxHeight, minHeight: props.minHeight, alignment: props.frameAlignment ?? (props.fill ? 'leading' : undefined) }));
  }
  const fill = resolveColor(props.background, accent);
  if (fill) result.push(background(fill));
  if (props.glass) result.push(...glassModifiers(props.glass, props.radius, accent));
  else if (props.radius !== undefined) result.push(clipShape('roundedRectangle', props.radius));
  if (props.opacity !== undefined) result.push(opacity(props.opacity));
  if (props.disabled) result.push(disabled(true));
  if (props.x !== undefined || props.y !== undefined) result.push(offset({ x: props.x ?? 0, y: props.y ?? 0 }));
  if (props.scale !== undefined) result.push(scaleEffect(props.scale));
  if (props.rotation !== undefined) result.push(rotationEffect(props.rotation));
  if (props.rotation3D !== undefined) {
    const turn = typeof props.rotation3D === 'number' ? { angle: props.rotation3D } : props.rotation3D;
    result.push(createModifier('scriptorRotation3D', turn));
  }
  result.push(...gestureModifiers(props));
  if (props.animateOn !== undefined) result.push(animation(animationFor(props.animation), animatedValue(props.animateOn)));
  return Array.isArray(props.modifiers) ? [...result, ...props.modifiers] : result;
}

// Gestures come after the look, so dragging or zooming moves the glass and background too.
function gestureModifiers(props: ViewProps): ModifierConfig[] {
  const result: ModifierConfig[] = [];
  if (props.zoom) {
    const { onZoom, ...params } = typeof props.zoom === 'object' ? props.zoom : {};
    result.push(createModifierWithEventListener('scriptorZoom', (e: { scale: number }) => onZoom?.(e.scale), params));
  }
  const { onDrag, onSwipe, onHold, onDoubleTap, onTapAt } = props;
  if (onDrag) result.push(createModifierWithEventListener('scriptorDrag', (e: DragEvent) => onDrag(e), props.drag ?? {}));
  if (onSwipe) result.push(createModifierWithEventListener('scriptorSwipe', (e: { direction: 'left' | 'right' | 'up' | 'down' }) => onSwipe(e.direction)));
  if (onHold) result.push(createModifierWithEventListener('scriptorPress', (e: { pressing?: boolean }) => e.pressing !== undefined && onHold(e.pressing)));
  // The double tap goes first, so a single tap waits to see whether a second one follows.
  if (onDoubleTap) result.push(createModifierWithEventListener('scriptorTapAt', () => onDoubleTap(), { count: 2 }));
  if (onTapAt) result.push(createModifierWithEventListener('scriptorTapAt', (e: TapEvent) => onTapAt(e), { count: 1 }));
  if (props.onTap) result.push(onTapGesture(props.onTap));
  if (props.onLongPress) result.push(onLongPressGesture(props.onLongPress));
  return result;
}

const useAccent = () => useContext(TintContext);

function textOf(children: ReactNode) {
  return React.Children.toArray(children)
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('');
}

type TextStyle = 'largeTitle' | 'title' | 'title2' | 'title3' | 'headline' | 'subheadline' | 'body' | 'callout' | 'footnote' | 'caption' | 'caption2';
type Weight = 'ultraLight' | 'thin' | 'light' | 'regular' | 'medium' | 'semibold' | 'bold' | 'heavy' | 'black';
type Design = 'default' | 'rounded' | 'serif' | 'monospaced';

// One font per Text: SwiftUI keeps the innermost font, so a second one would be ignored.
function Text({ children, style, size, weight, design, color, mono, align, lines, selectable, ...rest }: ViewProps & { children?: ReactNode; style?: TextStyle; size?: number; weight?: Weight; design?: Design; color?: string; mono?: boolean; align?: 'leading' | 'center' | 'trailing'; lines?: number; selectable?: boolean }) {
  const accent = useAccent();
  const face: Design = design ?? (mono ? 'monospaced' : 'default');
  const modifiers: ModifierConfig[] = [
    foregroundStyle(resolveColor(color, accent) ?? NAMED.primary),
    size ? font({ size, weight: weight ?? 'regular', design: face }) : font({ textStyle: style ?? 'body', weight, design: face }),
  ];
  if (style && ['largeTitle', 'title', 'title2', 'title3'].includes(style)) modifiers.push(accessibilityAddTraits(['isHeader']));
  if (mono) modifiers.push(monospacedDigit());
  if (align) modifiers.push(multilineTextAlignment(align));
  if (lines) modifiers.push(lineLimit(lines));
  if (selectable) modifiers.push(textSelection(true));
  return <NativeText modifiers={[...modifiers, ...common(rest, accent)]}>{textOf(children)}</NativeText>;
}

function VStack({ children, spacing, alignment, ...rest }: ViewProps & { children?: ReactNode; spacing?: number; alignment?: 'leading' | 'center' | 'trailing' }) {
  return <NativeVStack alignment={alignment} spacing={spacing} modifiers={common(rest, useAccent())}>{children}</NativeVStack>;
}

function HStack({ children, spacing, alignment, ...rest }: ViewProps & { children?: ReactNode; spacing?: number; alignment?: 'top' | 'center' | 'bottom' | 'firstTextBaseline' | 'lastTextBaseline' }) {
  return <NativeHStack alignment={alignment} spacing={spacing} modifiers={common(rest, useAccent())}>{children}</NativeHStack>;
}

function ZStack({ children, alignment, ...rest }: ViewProps & { children?: ReactNode; alignment?: FrameAlignment }) {
  return <NativeZStack alignment={alignment} modifiers={common(rest, useAccent())}>{children}</NativeZStack>;
}

/** Glass views inside blend and morph into each other as they move (iOS 26). */
function GlassGroup({ children, spacing, ...rest }: ViewProps & { children?: ReactNode; spacing?: number }) {
  const accent = useAccent();
  if (!liquidGlass) return <NativeZStack modifiers={common(rest, accent)}>{children}</NativeZStack>;
  return <GlassEffectContainer spacing={spacing} modifiers={common(rest, accent)}>{children}</GlassEffectContainer>;
}

const Spacer = ({ minLength }: { minLength?: number }) => <NativeSpacer minLength={minLength} />;
const Divider = () => <NativeDivider />;

/** A scrolling column with page insets. */
function Page({ children, spacing = 20, alignment = 'leading', ...rest }: ViewProps & { children?: ReactNode; spacing?: number; alignment?: 'leading' | 'center' | 'trailing' }) {
  return (
    <ScrollView modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity }), scrollDismissesKeyboard('interactively')]}>
      <NativeVStack alignment={alignment} spacing={spacing} modifiers={[frame({ maxWidth: Infinity, alignment: alignment === 'center' ? 'center' : alignment }), padding({ horizontal: 20, top: 12, bottom: 32 }), ...common(rest, useAccent())]}>
        {children}
      </NativeVStack>
    </ScrollView>
  );
}

/** A native grouped list, like Ajustes. Holds Sections. */
function List({ children }: { children?: ReactNode }) {
  return (
    <InListContext.Provider value>
      <Form modifiers={[listStyle('insetGrouped'), scrollDismissesKeyboard('interactively')]}>{children}</Form>
    </InListContext.Provider>
  );
}

function Section({ title, footer, children }: { title?: string; footer?: string; children?: ReactNode }) {
  return (
    <NativeSection title={title} footer={footer ? <NativeText modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(NAMED.secondary)]}>{footer}</NativeText> : undefined}>
      {children}
    </NativeSection>
  );
}

/** A rounded surface for grouping content on a Page; `glass` makes it Liquid Glass. */
function Card({ children, spacing = 12, glass, ...rest }: ViewProps & { children?: ReactNode; spacing?: number }) {
  const accent = useAccent();
  const surface = glass ? glassModifiers(glass, 22, accent) : [background(NAMED.surface), clipShape('roundedRectangle', 22)];
  return (
    <NativeVStack alignment="leading" spacing={spacing} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' }), padding({ all: 16 }), ...surface, ...common(rest, accent)]}>
      {children}
    </NativeVStack>
  );
}

/** A label and its value on one line; tappable when it has onPress. */
function Row({ label, value, icon, color, onPress, ...rest }: ViewProps & { label: string; value?: string | number; icon?: string; color?: string; onPress?: () => void }) {
  const accent = useAccent();
  const content = (
    <NativeHStack alignment="center" spacing={12} modifiers={[frame({ maxWidth: Infinity, minHeight: 32, alignment: 'leading' }), ...common(rest, accent)]}>
      {icon ? <NativeImage systemName={icon as SFSymbol} modifiers={[font({ size: 18 }), foregroundStyle(resolveColor(color, accent) ?? accent)]} /> : null}
      <NativeText modifiers={[foregroundStyle(NAMED.primary)]}>{label}</NativeText>
      <NativeSpacer />
      {value !== undefined && value !== null ? <NativeText modifiers={[foregroundStyle(NAMED.secondary), monospacedDigit()]}>{String(value)}</NativeText> : null}
      {onPress ? <NativeImage systemName="chevron.right" modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(NAMED.tertiary)]} /> : null}
    </NativeHStack>
  );
  return onPress ? <NativeButton onPress={onPress} modifiers={[buttonStyle('plain')]}>{content}</NativeButton> : content;
}

type ButtonKind = 'prominent' | 'glass' | 'bordered' | 'plain' | 'destructive';

function Button({ title, icon, onPress, style, color, ...rest }: ViewProps & { title?: string; icon?: string; onPress?: () => void; style?: ButtonKind; color?: string }) {
  const base = useAccent();
  const accent = resolveColor(color, base) ?? base;
  const look: ModifierConfig[] =
    style === 'prominent' ? [buttonStyle(liquidGlass ? 'glassProminent' : 'borderedProminent'), controlSize('large'), tint(accent)]
    : style === 'glass' ? [buttonStyle(liquidGlass ? 'glass' : 'bordered'), controlSize('large'), tint(accent)]
    : style === 'bordered' ? [buttonStyle('bordered'), tint(accent)]
    : style === 'plain' ? [buttonStyle('plain')]
    : style === 'destructive' ? []
    : [tint(accent)];
  return <NativeButton label={title} systemImage={icon as SFSymbol | undefined} role={style === 'destructive' ? 'destructive' : undefined} onPress={onPress} modifiers={[...look, ...common(rest, base)]} />;
}

/** A round Liquid Glass button with an icon only. */
function IconButton({ icon, label, onPress, prominent, color, ...rest }: ViewProps & { icon: string; label?: string; onPress?: () => void; prominent?: boolean; color?: string }) {
  const base = useAccent();
  const accent = resolveColor(color, base) ?? base;
  const look = prominent ? (liquidGlass ? 'glassProminent' : 'borderedProminent') : liquidGlass ? 'glass' : 'bordered';
  return (
    <NativeButton
      label={label ?? icon}
      systemImage={icon as SFSymbol}
      onPress={onPress}
      modifiers={[labelStyle('iconOnly'), buttonStyle(look), buttonBorderShape('circle'), controlSize('extraLarge'), tint(prominent ? accent : NAMED.primary), accessibilityLabel(label ?? icon), ...common(rest, base)]}
    />
  );
}

type ImageProps = ViewProps & {
  symbol?: string;
  path?: string;
  /** An image on the internet, downloaded once and kept on disk. A path also works. */
  url?: string;
  headers?: Record<string, string>;
  /** Width / height. Without it, 'fit' takes the image's proportions once loaded and 'fill' takes the frame it is given. */
  ratio?: number;
  placeholder?: string;
  onLoad?: (size: { width: number; height: number }) => void;
  onError?: (message: string) => void;
  size?: number;
  color?: string;
  mode?: 'fit' | 'fill';
};

/** An SF Symbol (`symbol`), an image file (`path`, as Photos.pick and FS return them) or one from the internet (`url`). */
function Image({ symbol, path, url, headers, ratio, placeholder, onLoad, onError, size = 22, color, mode = 'fit', ...rest }: ImageProps) {
  const accent = useAccent();
  if (url) {
    const modifiers = common(rest, accent);
    return (
      <RemoteImageView
        url={url}
        headers={headers ?? {}}
        mode={mode}
        ratio={ratio}
        placeholder={resolveColor(placeholder, accent)}
        onLoad={onLoad ? (e) => onLoad(e.nativeEvent) : undefined}
        onError={onError ? (e) => onError(e.nativeEvent.message) : undefined}
        modifiers={modifiers}
        {...modifierEvents(modifiers)}
      />
    );
  }
  if (path) {
    const uri = path.startsWith('file://') ? path : `file://${path}`;
    return <NativeImage uiImage={uri} modifiers={[resizable(), aspectRatio({ contentMode: mode }), ...common(rest, accent), clipped()]} />;
  }
  return <NativeImage systemName={(symbol ?? 'questionmark') as SFSymbol} modifiers={[font({ size }), foregroundStyle(resolveColor(color, accent) ?? NAMED.primary), ...common(rest, accent)]} />;
}

// This app's own SwiftUI views (MiniappViews.swift) get modifier events the way @expo/ui's do.
type NativeEvent<T> = { nativeEvent: T };
type ModifierEvents = { onGlobalEvent?: (event: NativeEvent<Record<string, unknown>>) => void };

function modifierEvents(modifiers: ModifierConfig[]): ModifierEvents {
  const listeners: Record<string, (args: any) => void> = {};
  for (const modifier of modifiers) if (modifier.eventListener) listeners[modifier.$type] = modifier.eventListener;
  if (!Object.keys(listeners).length) return {};
  return {
    onGlobalEvent: ({ nativeEvent }) => {
      for (const [name, params] of Object.entries(nativeEvent)) listeners[name]?.(params);
    },
  };
}

type RemoteImageNativeProps = ModifierEvents & {
  url: string;
  headers: Record<string, string>;
  mode: string;
  ratio?: number;
  placeholder?: ColorValue;
  onLoad?: (event: NativeEvent<{ width: number; height: number }>) => void;
  onError?: (event: NativeEvent<{ message: string }>) => void;
  modifiers: ModifierConfig[];
};
const RemoteImageView = requireNativeView<RemoteImageNativeProps>('ScriptorUI', 'RemoteImageView');

type VideoNativeProps = ModifierEvents & {
  url: string;
  headers: Record<string, string>;
  playing: boolean;
  muted: boolean;
  loop: boolean;
  controls: boolean;
  mode: string;
  rate: number;
  seek?: number;
  seekKey: number;
  onReady?: (event: NativeEvent<{ duration: number; width: number; height: number }>) => void;
  onProgress?: (event: NativeEvent<{ time: number; duration: number }>) => void;
  onEnd?: () => void;
  onError?: (event: NativeEvent<{ message: string }>) => void;
  onBuffering?: (event: NativeEvent<{ buffering: boolean }>) => void;
  modifiers: ModifierConfig[];
};
const ScriptorUI = requireNativeModule<{ prefetchImages(urls: string[], headers?: Record<string, string>): Promise<void> }>('ScriptorUI');

/** Downloads images ahead (the next stories, say) so they show at once when drawn. */
export const prefetchImages = (urls: string[], headers?: Record<string, string>) => ScriptorUI.prefetchImages(urls.map(String), headers);

const NativeVideo = requireNativeView<VideoNativeProps>('ScriptorUI', 'InlineVideoView');

export type VideoHandle = { seek: (seconds: number) => void };

type VideoProps = ViewProps & {
  url: string;
  headers?: Record<string, string>;
  playing?: boolean;
  muted?: boolean;
  loop?: boolean;
  controls?: boolean;
  mode?: 'fit' | 'fill';
  rate?: number;
  ratio?: number;
  onReady?: (info: { duration: number; width: number; height: number }) => void;
  onProgress?: (time: number, duration: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
  onBuffering?: (buffering: boolean) => void;
  ref?: Ref<VideoHandle>;
};

/**
 * A video in the page, from the internet (with headers) or a file. `playing` and `muted` control
 * it; `ref.current.seek(s)` jumps. It fills the space it gets unless width, height or ratio say otherwise.
 */
function Video({ url, headers, playing = true, muted = false, loop = false, controls = false, mode = 'fit', rate = 1, ratio, onReady, onProgress, onEnd, onError, onBuffering, ref, ...rest }: VideoProps) {
  const accent = useAccent();
  const [seek, setSeek] = useState<{ to?: number; key: number }>({ key: 0 });
  useImperativeHandle(ref, () => ({ seek: (seconds: number) => setSeek((s) => ({ to: seconds, key: s.key + 1 })) }));
  const sized = rest.width !== undefined || rest.height !== undefined || rest.maxHeight !== undefined;
  const shape = ratio ? [aspectRatio({ ratio, contentMode: 'fit' })] : sized ? [] : [frame({ maxWidth: Infinity, maxHeight: Infinity })];
  const modifiers = [...shape, ...common(rest, accent)];
  return (
    <NativeVideo
      url={url}
      headers={headers ?? {}}
      playing={playing}
      muted={muted}
      loop={loop}
      controls={controls}
      mode={mode}
      rate={rate}
      seek={seek.to}
      seekKey={seek.key}
      onReady={onReady ? (e) => onReady(e.nativeEvent) : undefined}
      onProgress={onProgress ? (e) => onProgress(e.nativeEvent.time, e.nativeEvent.duration) : undefined}
      onEnd={onEnd}
      onError={onError ? (e) => onError(e.nativeEvent.message) : undefined}
      onBuffering={onBuffering ? (e) => onBuffering(e.nativeEvent.buffering) : undefined}
      modifiers={modifiers}
      {...modifierEvents(modifiers)}
    />
  );
}

function Toggle({ label, icon, value, onChange, ...rest }: ViewProps & { label?: string; icon?: string; value?: boolean; onChange?: (value: boolean) => void }) {
  const accent = useAccent();
  return <NativeToggle label={label} systemImage={icon as SFSymbol | undefined} isOn={Boolean(value)} onIsOnChange={onChange} modifiers={[tint(accent), ...common(rest, accent)]} />;
}

function Slider({ value, min = 0, max = 1, step, onChange, ...rest }: ViewProps & { value?: number; min?: number; max?: number; step?: number; onChange?: (value: number) => void }) {
  const accent = useAccent();
  return <NativeSlider value={value} min={min} max={max} step={step} onValueChange={onChange} modifiers={[tint(accent), ...common(rest, accent)]} />;
}

function Stepper({ label, value, min, max, step, onChange, ...rest }: ViewProps & { label?: string; value?: number; min?: number; max?: number; step?: number; onChange?: (value: number) => void }) {
  return <NativeStepper label={label ?? String(value ?? '')} value={value} min={min} max={max} step={step} onValueChange={onChange ?? (() => {})} modifiers={common(rest, useAccent())} />;
}

const KEYBOARDS = { text: 'default', number: 'numeric', decimal: 'decimal-pad', email: 'email-address', url: 'url', phone: 'phone-pad' } as const;

/** Controlled like a React input: `value` and `onChange`. */
function TextField({ value, onChange, onSubmit: submit, placeholder, multiline, lines, plain, keyboard, autocorrect = true, ...rest }: ViewProps & { value?: string; onChange?: (text: string) => void; onSubmit?: () => void; placeholder?: string; multiline?: boolean; lines?: number; plain?: boolean; keyboard?: keyof typeof KEYBOARDS; autocorrect?: boolean }) {
  const accent = useAccent();
  const inList = useContext(InListContext);
  const text = useNativeState(value ?? '');
  const last = useRef(value ?? '');
  useEffect(() => {
    // Only a change made by the miniapp itself is pushed into the field.
    if (value !== undefined && value !== last.current) {
      last.current = value;
      text.set(value);
    }
  }, [value, text]);
  return (
    <NativeTextField
      text={text}
      placeholder={placeholder}
      axis={multiline ? 'vertical' : 'horizontal'}
      onTextChange={(next) => {
        last.current = next;
        onChange?.(next);
      }}
      modifiers={[
        textFieldStyle(plain ? 'plain' : inList ? 'automatic' : 'roundedBorder'),
        frame({ maxWidth: Infinity }),
        ...(keyboard && KEYBOARDS[keyboard] ? [keyboardType(KEYBOARDS[keyboard])] : []),
        ...(autocorrect ? [] : [autocorrectionDisabled(), textInputAutocapitalization('never')]),
        ...(submit ? [onSubmit(submit)] : []),
        // A multiline field shows 3 lines unless `lines` says otherwise.
        ...(multiline && (lines ?? 3) > 0 ? [lineLimit(lines ?? 3)] : []),
        ...common(rest, accent),
      ]}
    />
  );
}

type Option = string | number | { label: string; value: string | number };

function Picker({ value, onChange, options = [], label, style = 'menu', ...rest }: ViewProps & { value?: string | number; onChange?: (value: string | number) => void; options?: Option[]; label?: string; style?: 'menu' | 'segmented' | 'wheel' | 'inline' }) {
  const accent = useAccent();
  const items = options.map((option) => (typeof option === 'object' ? option : { label: String(option), value: option }));
  return (
    <NativePicker label={label} selection={value} onSelectionChange={(next) => onChange?.(next as string | number)} modifiers={[pickerStyle(style), tint(accent), ...common(rest, accent)]}>
      {items.map((item) => <NativeText key={String(item.value)} modifiers={[tag(item.value)]}>{item.label}</NativeText>)}
    </NativePicker>
  );
}

/** A bar for a value from 0 to 1, or a spinner without one. */
function Progress({ value, color, ...rest }: ViewProps & { value?: number; color?: string }) {
  const accent = useAccent();
  return <ProgressView value={typeof value === 'number' ? Math.max(0, Math.min(1, value)) : undefined} modifiers={[tint(resolveColor(color, accent) ?? accent), ...common(rest, accent)]} />;
}

function Empty({ title, icon, detail }: { title: string; icon?: string; detail?: string }) {
  return <ContentUnavailableView title={title} systemImage={icon as SFSymbol | undefined} description={detail} modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]} />;
}

// Lets the page talk back like Scriptor's WebView: window.sendToScript(value) reaches onMessage.
const WEB_BRIDGE = `window.sendToScript = function (value) { window.ReactNativeWebView.postMessage(JSON.stringify(value === undefined ? null : value)); }; true;`;

// The package types its class with props `WebViewProps & undefined` by default, which is never.
const NativeWebView = RNWebView as unknown as React.ComponentType<WebViewProps & { ref?: Ref<RNWebView<object>> }>;

export type WebViewHandle = { run: (js: string) => void; reload: () => void; goBack: () => void };

/**
 * A web page among the native views: `url` or `html`. The page calls window.sendToScript(value)
 * and `onMessage(value)` receives it; `ref.current.run(js)` runs code in the page. It fills the
 * space it gets unless width or height say otherwise.
 */
function WebView({ url, html, baseURL, onMessage, onLoad, inject, ref, ...rest }: ViewProps & { url?: string; html?: string; baseURL?: string; onMessage?: (value: unknown) => void; onLoad?: () => void; inject?: string; ref?: Ref<WebViewHandle> }) {
  const accent = useAccent();
  const web = useRef<RNWebView<object>>(null);
  useImperativeHandle(ref, () => ({
    run: (js: string) => web.current?.injectJavaScript(`${js}\n;true;`),
    reload: () => web.current?.reload(),
    goBack: () => web.current?.goBack(),
  }));
  const receive = (event: WebViewMessageEvent) => {
    let value: unknown = event.nativeEvent.data;
    try {
      value = JSON.parse(event.nativeEvent.data);
    } catch {
      // Plain text posted with ReactNativeWebView.postMessage stays text.
    }
    onMessage?.(value);
  };
  const sized = rest.width !== undefined || rest.height !== undefined || rest.maxHeight !== undefined;
  return (
    <NativeVStack spacing={0} modifiers={[...(sized ? [] : [frame({ maxWidth: Infinity, maxHeight: Infinity })]), ...common(rest, accent)]}>
      <RNHostView>
        <NativeWebView
          ref={web}
          style={{ flex: 1, backgroundColor: 'transparent' }}
          source={html !== undefined ? { html, baseUrl: baseURL } : { uri: url ?? 'about:blank' }}
          injectedJavaScriptBeforeContentLoaded={WEB_BRIDGE + (inject ? `\n${inject}\n;true;` : '')}
          onMessage={receive}
          onLoadEnd={onLoad}
          allowsInlineMediaPlayback
          allowsBackForwardNavigationGestures
          originWhitelist={['*']}
        />
      </RNHostView>
    </NativeVStack>
  );
}

export const COMPONENTS = { Text, VStack, HStack, ZStack, GlassGroup, Spacer, Divider, Page, List, Section, Card, Row, Button, IconButton, Image, Toggle, Slider, Stepper, TextField, Picker, Progress, Empty, WebView, Video };

/** Views whose children are text; h() leaves loose strings inside them as they are. */
export const TEXT_TYPES = new Set<unknown>([Text, NativeText]);
