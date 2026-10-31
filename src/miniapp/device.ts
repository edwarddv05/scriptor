import * as Location from 'expo-location';
import { Accelerometer, Barometer, Gyroscope } from 'expo-sensors';
import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

// Hooks that follow the phone while the miniapp is on screen. They read Expo's modules here, in
// the app's runtime, instead of asking the script engine: a reading becomes React state at once.

type Vector = { x: number; y: number; z: number };
type Subscription = { remove: () => void };

// ─── Accelerometer ─────────────────────────────────────────────────────────

// The update interval is one setting for the whole app, and shaking to open the menu reads the
// accelerometer too. Every listener says how often it wants readings; the sensor runs at the
// fastest of them and each listener gets readings no closer than it asked for.
const accelerometerListeners = new Map<number, { ms: number; listener: (data: Vector) => void; last: number }>();
let accelerometerSubscription: Subscription | null = null;
let nextListener = 0;

function applyAccelerometer() {
  if (!accelerometerListeners.size) {
    accelerometerSubscription?.remove();
    accelerometerSubscription = null;
    return;
  }
  Accelerometer.setUpdateInterval(Math.min(...[...accelerometerListeners.values()].map((entry) => entry.ms)));
  accelerometerSubscription ??= Accelerometer.addListener((data) => {
    const now = Date.now();
    for (const entry of accelerometerListeners.values()) {
      // A reading may come a little early, so a few milliseconds of slack keep the asked rate.
      if (now - entry.last < entry.ms - 5) continue;
      entry.last = now;
      entry.listener(data);
    }
  });
}

/** Acceleration readings in g, at most every `ms`. Returns a function that stops them. */
export function listenAccelerometer(ms: number, listener: (data: Vector) => void) {
  const id = nextListener++;
  accelerometerListeners.set(id, { ms: Math.max(16, ms), listener, last: 0 });
  applyAccelerometer();
  return () => {
    accelerometerListeners.delete(id);
    applyAccelerometer();
  };
}

// ─── Sensors ───────────────────────────────────────────────────────────────

type Sensor<T> = { isAvailableAsync: () => Promise<boolean>; listen: (ms: number, listener: (data: T) => void) => () => void };

const sensor = <T>(module: { isAvailableAsync: () => Promise<boolean>; setUpdateInterval: (ms: number) => void; addListener: (listener: (data: T) => void) => Subscription }): Sensor<T> => ({
  isAvailableAsync: () => module.isAvailableAsync(),
  listen: (ms, listener) => {
    module.setUpdateInterval(Math.max(16, ms));
    const subscription = module.addListener(listener);
    return () => subscription.remove();
  },
});

const ACCELEROMETER: Sensor<Vector> = { isAvailableAsync: () => Accelerometer.isAvailableAsync(), listen: listenAccelerometer };
const GYROSCOPE = sensor<Vector>(Gyroscope);
const BAROMETER = sensor<{ pressure: number; relativeAltitude?: number }>(Barometer);

function useSensor<T>(source: Sensor<T>, interval: number) {
  const [reading, setReading] = useState<T | null>(null);
  const ms = Number.isFinite(interval) ? interval : 100;
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    source.isAvailableAsync().then(
      (available) => {
        if (available && !cancelled) stop = source.listen(ms, (data) => setReading({ ...data }));
      },
      () => {},
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [source, ms]);
  return reading;
}

/** Acceleration in g on each axis, or null until the first reading (or without the sensor). */
export const useAccelerometer = (ms = 100) => useSensor(ACCELEROMETER, ms);
/** Rotation in radians per second on each axis. */
export const useGyroscope = (ms = 100) => useSensor(GYROSCOPE, ms);
/** Air pressure in hPa, and the change in height in metres since it started. */
export const useBarometer = (ms = 500) => useSensor(BAROMETER, ms);

// ─── Location ──────────────────────────────────────────────────────────────

async function ensureLocation() {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) throw new Error('Sin acceso a la ubicación. Actívalo en Ajustes de iOS.');
}

// The same names Location.current() gives, plus speed and when it was read.
const toPlace = ({ coords, timestamp }: Location.LocationObject) => ({
  latitude: coords.latitude,
  longitude: coords.longitude,
  altitude: coords.altitude,
  horizontalAccuracy: coords.accuracy,
  verticalAccuracy: coords.altitudeAccuracy,
  speed: coords.speed,
  time: new Date(timestamp),
});

/** Follows the phone's position, updating after it moves `distance` metres (10 by default). */
export function useLocation(options: { precise?: boolean; distance?: number } = {}) {
  const [location, setLocation] = useState<ReturnType<typeof toPlace> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const precise = options.precise === true;
  const distance = Math.max(0, Number(options.distance ?? 10) || 0);
  useEffect(() => {
    let cancelled = false;
    let subscription: Subscription | null = null;
    void (async () => {
      try {
        await ensureLocation();
        const watch = await Location.watchPositionAsync(
          { accuracy: precise ? Location.Accuracy.BestForNavigation : Location.Accuracy.Balanced, distanceInterval: distance },
          (position) => {
            setLocation(toPlace(position));
            setError(null);
          },
          (reason) => {
            if (!cancelled) setError(reason);
          },
        );
        if (cancelled) watch.remove();
        else subscription = watch;
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'No se pudo obtener la ubicación.');
      }
    })();
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [precise, distance]);
  return { location, error };
}

/** Compass heading in degrees from north (true north when known), or null until the first reading. */
export function useHeading() {
  const [heading, setHeading] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let subscription: Subscription | null = null;
    void (async () => {
      try {
        await ensureLocation();
        const watch = await Location.watchHeadingAsync((value) => setHeading(value.trueHeading >= 0 ? value.trueHeading : value.magHeading));
        if (cancelled) watch.remove();
        else subscription = watch;
      } catch {
        // Without access the heading stays null.
      }
    })();
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);
  return heading;
}

// ─── App state ─────────────────────────────────────────────────────────────

/** 'active', 'inactive' or 'background'; `onChange` runs on each change, to save before leaving. */
export function useAppState(onChange?: (state: AppStateStatus) => void) {
  const [state, setState] = useState(AppState.currentState);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setState(next);
      latest.current?.(next);
    });
    return () => subscription.remove();
  }, []);
  return state;
}
