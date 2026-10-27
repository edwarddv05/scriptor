import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import ScriptEngine from '../../../modules/script-engine';

/**
 * Target of scriptor://x-callback/<token>/<success|error|cancel>?…, the URL that another app opens
 * when it finishes an x-callback-url request made with CallbackURL.open(). Hands the result to
 * the waiting script and goes back to where the user was.
 */
export default function XCallbackScreen() {
  const { path, ...params } = useLocalSearchParams<{ path: string[] }>();
  const [token, status] = Array.isArray(path) ? path : [path];

  useEffect(() => {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) values[key] = Array.isArray(value) ? value.join(',') : String(value);
    if (token) ScriptEngine.deliverCallback(token, status ?? 'success', values);
    if (router.canGoBack()) router.back();
    else router.replace('/');
    // Runs once per callback URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, status]);

  return null;
}
