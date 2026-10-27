import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Pressable, PlatformColor } from 'react-native';

type Props = {
  name: SymbolViewProps['name'];
  onPress: () => void;
  label: string;
  tint?: ReturnType<typeof PlatformColor>;
  disabled?: boolean;
};

export function IconButton({ name, onPress, label, tint, disabled }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => ({ opacity: disabled ? 0.3 : pressed ? 0.5 : 1, padding: 4 })}>
      <SymbolView name={name} size={22} tintColor={tint ?? PlatformColor('systemBlue')} />
    </Pressable>
  );
}
