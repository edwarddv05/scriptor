import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { listScripts } from '@/lib/scripts';
import { MiniappScreen } from '@/miniapp/screen';
import { colorFor, scriptColors } from '@/theme';

/**
 * A .jsx/.tsx miniapp on the whole screen. Also the target of scriptor://app/<file>?key=value,
 * whose query parameters become the miniapp's `input`. `from=editor` means Editar just goes back.
 */
export default function MiniappRoute() {
  const { name, from, ...input } = useLocalSearchParams<{ name: string; from?: string }>();
  const tint = useMemo(() => {
    const script = listScripts().find((s) => s.name === name);
    return scriptColors[colorFor(script ?? { name })][1];
  }, [name]);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const edit = () => {
    if (from === 'editor') return close();
    close();
    router.push({ pathname: '/script/[name]', params: { name } });
  };

  return <MiniappScreen key={name} name={name} tint={tint} input={input as Record<string, string>} onClose={close} onEdit={edit} />;
}
