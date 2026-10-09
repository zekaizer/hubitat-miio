import { type CallOptions, type MiioClient, MiioError } from '../miio/client';

/** Property name to [siid, piid]. */
export type MiotProps = Record<string, readonly [number, number]>;

interface Item {
  did: string;
  code: number;
  value?: unknown;
}

const address = (props: MiotProps, name: string): { did: string; siid: number; piid: number } => {
  const [siid, piid] = props[name] as readonly [number, number];
  return { did: name, siid, piid };
};

// Reads the named properties in one request and rejects unless the device gives every one.
// Ask only for properties the device has: zhimi.humidifier.ca4 fails properties that come
// after a missing one in the same request.
export async function readProps<K extends string>(
  client: MiioClient,
  props: Record<K, readonly [number, number]>,
  names: readonly K[],
): Promise<Record<K, unknown>> {
  const items = await client.call<Item[]>(
    'get_properties',
    names.map((name) => address(props, name)),
  );
  const values = Object.fromEntries(
    items.filter((item) => item.code === 0).map((item) => [item.did, item.value]),
  ) as Record<K, unknown>;
  const missing = names.filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`the device did not give ${missing.join(', ')}`);
  }
  return values;
}

// Writes the properties in the order given, which the device also applies them in. Values must
// have their JSON type: dmaker.fan.p33 takes any string for a boolean as false.
export async function writeProps<K extends string>(
  client: MiioClient,
  props: Record<K, readonly [number, number]>,
  values: Array<[K, boolean | number]>,
  options?: CallOptions,
): Promise<void> {
  const items = await client.call<Item[]>(
    'set_properties',
    values.map(([name, value]) => ({ ...address(props, name), value })),
    options,
  );
  const refused = items.find((item) => item.code !== 0);
  if (refused) {
    throw new MiioError(refused.code, `${refused.did} rejected`);
  }
}
