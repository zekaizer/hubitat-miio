import type { AtNight, Kept } from './fan';

/** Local time, "HH:MM". The night runs from start to end, across midnight when end is earlier. */
export interface NightSchedule {
  start: string;
  end: string;
}

export interface DeviceConfig {
  name: string;
  address: string;
  /** For a device that is not on the miio port, 54321. */
  port?: number;
  token: string;
  pollMs?: number;
  moveSwitches: boolean;
  buzzer: Kept;
  light: Kept;
  buzzerAtNight: AtNight;
  lightAtNight: AtNight;
}

/** What tells one device from another: its address, with the port when one is given. */
export const endpoint = (device: Pick<DeviceConfig, 'address' | 'port'>): string =>
  device.port === undefined ? device.address : `${device.address}:${device.port}`;

export interface Config {
  night?: NightSchedule;
  devices: DeviceConfig[];
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEPT: Kept[] = ['unmanaged', 'on', 'off'];
const AT_NIGHT: AtNight[] = ['same', 'on', 'off'];

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

// Leaves out what cannot be used and says why through warn. Never puts a token in a message.
export function parseConfig(raw: unknown, warn: (message: string) => void): Config {
  const config = (raw ?? {}) as { night?: unknown; devices?: unknown };
  const devices: DeviceConfig[] = [];
  const list = Array.isArray(config.devices) ? config.devices : [];
  list.forEach((entry: Record<string, unknown>, index: number) => {
    const name = text(entry?.name) || `Device ${index + 1}`;
    const address = text(entry?.address);
    const token = text(entry?.token);
    if (!address) {
      warn(`${name}: left out, it has no address`);
      return;
    }
    if (!/^[0-9a-fA-F]{32}$/.test(token)) {
      warn(`${name}: left out, the token must be 32 hex characters`);
      return;
    }
    const port = typeof entry.port === 'number' ? entry.port : undefined;
    if (devices.some((device) => endpoint(device) === endpoint({ address, port }))) {
      warn(`${name}: left out, ${address} is already used by another device`);
      return;
    }
    const oneOf = <T extends string>(key: string, allowed: T[], fallback: T): T => {
      const value = entry[key];
      if (value === undefined || allowed.includes(value as T)) {
        return (value as T | undefined) ?? fallback;
      }
      warn(`${name}: ${key} must be one of ${allowed.join(', ')}; using ${fallback}`);
      return fallback;
    };
    let pollMs: number | undefined;
    if (entry.pollInterval !== undefined) {
      if (typeof entry.pollInterval === 'number' && entry.pollInterval >= 1) {
        pollMs = entry.pollInterval * 1000;
      } else {
        warn(`${name}: pollInterval must be a number of seconds, 1 or more; using the default`);
      }
    }
    devices.push({
      name,
      address,
      port,
      token,
      pollMs,
      moveSwitches: entry.moveSwitches === true,
      buzzer: oneOf('buzzer', KEPT, 'unmanaged'),
      light: oneOf('light', KEPT, 'unmanaged'),
      buzzerAtNight: oneOf('buzzerAtNight', AT_NIGHT, 'same'),
      lightAtNight: oneOf('lightAtNight', AT_NIGHT, 'same'),
    });
  });
  return { night: parseNight(config.night, warn), devices };
}

function parseNight(raw: unknown, warn: (message: string) => void): NightSchedule | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const { start, end } = raw as { start?: unknown; end?: unknown };
  if (!TIME.test(text(start)) || !TIME.test(text(end))) {
    warn('night: start and end must be times of day such as 22:00; night values are not used');
    return undefined;
  }
  return { start: text(start), end: text(end) };
}

const minutes = (time: string): number => {
  const [hours, mins] = time.split(':').map(Number) as [number, number];
  return hours * 60 + mins;
};

export function isNightAt(schedule: NightSchedule | undefined, now: Date): boolean {
  if (!schedule) {
    return false;
  }
  const start = minutes(schedule.start);
  const end = minutes(schedule.end);
  const time = now.getHours() * 60 + now.getMinutes();
  return start <= end ? time >= start && time < end : time >= start || time < end;
}
