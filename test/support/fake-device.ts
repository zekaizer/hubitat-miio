import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';

// A fake Xiaomi device on localhost UDP. It follows docs/local-api.md and can be told to
// misbehave.
// The crypto is written out here, not imported from src/, so the tests do not check the client
// against its own code.

export type FakeModel = 'zhimi.fan.za1' | 'dmaker.fan.p33' | 'zhimi.humidifier.ca4';

export const FAKE_TOKEN = '00112233445566778899aabbccddeeff';
export const FAKE_DEVICE_ID = 0x0badf00d;

const md5 = (...parts: Buffer[]): Buffer => createHash('md5').update(Buffer.concat(parts)).digest();

interface Request {
  id: number;
  method: string;
  // biome-ignore lint/suspicious/noExplicitAny: requests are arbitrary JSON
  params: any;
}

type Reply = { result: unknown } | { error: { code: number; message: string } };

const err = (code: number, message: string): Reply => ({ error: { code, message } });
const OK: Reply = { result: ['ok'] };

export class FakeDevice {
  /** Ignore every packet, like a fan that is unplugged. */
  silent = false;
  /** Answer the handshake only, like a fan given the wrong token. */
  dropRequests = false;
  /** Number of requests to carry out without answering. */
  dropReplies = 0;
  /** Number of requests to answer with a second handshake reply instead. */
  strayHello = 0;
  /** Delay before each reply. */
  delayMs = 0;
  /** How long the device takes to answer -9999; 4 s on the real ones. */
  ackTimeoutMs = 20;

  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly moves: string[] = [];
  /** When each move arrived. */
  readonly moveTimes: number[] = [];
  hellos = 0;
  /** Highest number of requests that were being served at the same time. */
  maxInFlight = 0;

  readonly legacy: Record<string, string | number> = {
    power: 'on',
    speed_level: 25,
    natural_level: 0,
    mode: 'normal',
    speed: 300,
    angle: 120,
    angle_enable: 'off',
    poweroff_time: 0,
    child_lock: 'off',
    buzzer: 0,
    led_b: 0,
    ac_power: 'on',
    use_time: 1,
  };
  /** Keyed "siid/piid". */
  readonly miot: Record<string, boolean | number> = {
    '2/1': true,
    '2/2': 1,
    '2/3': 0,
    '2/4': false,
    '2/5': 120,
    '2/6': 25,
    '3/1': 0,
    '4/1': true,
    '5/1': false,
    '6/2': 0,
    '7/1': false,
  };
  /** miot properties, keyed "siid/piid", that answer as if the device did not have them. */
  readonly unreadable = new Set<string>();

  /**
   * zhimi.humidifier.ca4, keyed "siid/piid". Only reads were measured on the real one: how the
   * fake takes writes follows the value ranges of the published spec and is an assumption.
   */
  readonly humidifier: Record<string, boolean | number> = {
    '2/1': false,
    '2/2': 0,
    '2/5': 0,
    '2/6': 70,
    '2/7': 0,
    '2/8': true,
    '2/9': 30895473,
    '2/10': 2,
    '2/11': 704,
    '3/7': 29.1,
    '3/8': 84.3,
    '3/9': 47,
    '4/1': false,
    '5/2': 2,
    '6/1': false,
    '7/1': 0,
    '7/3': 30225623,
    '7/4': 86,
    '7/5': false,
  };

  private readonly token = Buffer.from(FAKE_TOKEN, 'hex');
  private readonly key = md5(this.token);
  private readonly iv = md5(this.key, this.token);
  private readonly started = Date.now();
  private inFlight = 0;
  private closed = false;

  private constructor(
    readonly model: FakeModel,
    private readonly socket: Socket,
    readonly port: number,
  ) {
    socket.on('message', (data, from) => this.receive(data, from));
  }

  static start(model: FakeModel): Promise<FakeDevice> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4');
      socket.once('error', reject);
      socket.bind(0, '127.0.0.1', () =>
        resolve(new FakeDevice(model, socket, socket.address().port)),
      );
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return new Promise((resolve) => this.socket.close(() => resolve()));
  }

  get address(): string {
    return '127.0.0.1';
  }

  /** Methods of the requests received so far. */
  get methods(): string[] {
    return this.requests.map((r) => r.method);
  }

  private get isMiot(): boolean {
    return this.model === 'dmaker.fan.p33';
  }

  private stamp(): number {
    return 1000 + Math.floor((Date.now() - this.started) / 1000);
  }

  private header(length: number): Buffer {
    const head = Buffer.alloc(16);
    head.writeUInt16BE(0x2131, 0);
    head.writeUInt16BE(length, 2);
    head.writeUInt32BE(FAKE_DEVICE_ID, 8);
    head.writeUInt32BE(this.stamp(), 12);
    return head;
  }

  private helloReply(): Buffer {
    return Buffer.concat([this.header(32), Buffer.alloc(16, 0xff)]);
  }

  private packet(reply: object): Buffer {
    const cipher = createCipheriv('aes-128-cbc', this.key, this.iv);
    // The real devices end the JSON with a NUL byte.
    const body = Buffer.concat([
      cipher.update(`${JSON.stringify(reply)}\0`, 'utf8'),
      cipher.final(),
    ]);
    const head = this.header(32 + body.length);
    return Buffer.concat([head, md5(head, this.token, body), body]);
  }

  private receive(data: Buffer, from: RemoteInfo): void {
    if (this.silent) {
      return;
    }
    const send = (packet: Buffer): void => {
      if (!this.closed) {
        this.socket.send(packet, from.port, from.address);
      }
    };
    if (data.length === 32 && data.subarray(4).equals(Buffer.alloc(28, 0xff))) {
      this.hellos += 1;
      send(this.helloReply());
      return;
    }
    const body = data.subarray(32);
    if (!md5(data.subarray(0, 16), this.token, body).equals(data.subarray(16, 32))) {
      return;
    }
    if (this.dropRequests) {
      return;
    }
    const decipher = createDecipheriv('aes-128-cbc', this.key, this.iv);
    const request = JSON.parse(
      Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'),
    ) as Request;
    // Message id 0 is never answered.
    if (request.id === 0) {
      return;
    }
    this.requests.push({ method: request.method, params: request.params });
    const reply = this.handle(request.method, request.params);
    if (this.strayHello > 0) {
      this.strayHello -= 1;
      send(this.helloReply());
      return;
    }
    if (this.dropReplies > 0) {
      this.dropReplies -= 1;
      return;
    }
    const slow = 'error' in reply && reply.error.code === -9999 ? this.ackTimeoutMs : 0;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    setTimeout(() => {
      this.inFlight -= 1;
      send(this.packet({ id: request.id, ...reply }));
    }, this.delayMs + slow);
  }

  // biome-ignore lint/suspicious/noExplicitAny: requests are arbitrary JSON
  private handle(method: string, params: any): Reply {
    if (method === 'miIO.info') {
      return {
        result: { model: this.model, fw_ver: '9.9.9', mac: 'AA:BB:CC:DD:FA:CE', token: FAKE_TOKEN },
      };
    }
    if (this.model === 'zhimi.humidifier.ca4') {
      return this.handleHumidifier(method, params);
    }
    return this.isMiot ? this.handleMiot(method, params) : this.handleLegacy(method, params);
  }

  // biome-ignore lint/suspicious/noExplicitAny: requests are arbitrary JSON
  private handleHumidifier(method: string, params: any): Reply {
    if (method === 'set_properties' && Array.isArray(params) && params.length > 0) {
      return {
        result: params.map((item: { did: string; siid: number; piid: number; value: unknown }) => ({
          did: item.did,
          siid: item.siid,
          piid: item.piid,
          code: this.writeHumidifier(`${item.siid}/${item.piid}`, item.value),
        })),
      };
    }
    if (method !== 'get_properties') {
      return method === 'action' ? err(-9999, 'user ack timeout') : err(-5001, 'command error');
    }
    // 15 items were read in one request and 25 were not; what lies between was not measured.
    if (!Array.isArray(params) || params.length === 0 || params.length > 15) {
      return err(-9999, 'user ack timeout');
    }
    let spoiled = false;
    return {
      result: params.map((item: { did: string; siid: number; piid: number }) => {
        const key = `${item.siid}/${item.piid}`;
        const base = { did: item.did, siid: item.siid, piid: item.piid };
        // 2/3 and 2/4 answer -4001 and leave the rest of the request alone.
        if (!spoiled && (key === '2/3' || key === '2/4')) {
          return { ...base, code: -4001 };
        }
        // A property the device does not have answers -4004, and so do properties after it in
        // the same request. The real device spares some of those; the fake spares none.
        if (spoiled || !(key in this.humidifier) || this.unreadable.has(key)) {
          spoiled = true;
          return { ...base, code: -4004 };
        }
        return { ...base, code: 0, value: this.humidifier[key] };
      }),
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: requests are arbitrary JSON
  private handleLegacy(method: string, params: any): Reply {
    const p = this.legacy;
    const value = Array.isArray(params) ? params[0] : undefined;
    const invalid = err(-5001, 'invalid arg');
    const isLevel = (v: unknown, min: number): boolean =>
      typeof v === 'number' && Number.isInteger(v) && v >= min && v <= 100;
    switch (method) {
      case 'get_prop':
        if (!Array.isArray(params) || params.length === 0) {
          return err(-5000, 'method not found');
        }
        return { result: params.map((name: string) => p[name] ?? 'null') };
      case 'set_power':
        if (value !== 'on' && value !== 'off') {
          return invalid;
        }
        p.power = value;
        if (value === 'off') {
          p.poweroff_time = 0;
        }
        return OK;
      case 'set_child_lock':
        if (value !== 'on' && value !== 'off') {
          return invalid;
        }
        p.child_lock = value;
        return OK;
      case 'set_buzzer':
      case 'set_led_b':
        if (value !== 0 && value !== 1 && value !== 2) {
          return invalid;
        }
        p[method.slice(4)] = value;
        return OK;
      case 'set_speed_level':
      case 'set_natural_level':
      case 'set_angle':
      case 'set_angle_enable':
      case 'set_mode':
      case 'set_move':
        break;
      default:
        return err(-5000, 'method not found');
    }
    if (p.power !== 'on') {
      return err(-6011, 'device_poweroff');
    }
    switch (method) {
      case 'set_speed_level':
        if (!isLevel(value, 1)) {
          return invalid;
        }
        p.speed_level = value;
        p.natural_level = 0;
        p.mode = 'normal';
        return OK;
      case 'set_natural_level':
        if (!isLevel(value, 0)) {
          return invalid;
        }
        p.natural_level = value;
        p.mode = value === 0 ? 'normal' : 'natural';
        if (value !== 0) {
          p.speed_level = value;
        }
        return OK;
      case 'set_mode':
        if (value !== 'natural' && value !== 'normal') {
          return invalid;
        }
        p.mode = value;
        p.natural_level = value === 'natural' ? (p.speed_level as number) : 0;
        return OK;
      case 'set_angle':
        if (![0, 30, 45, 60, 90, 120].includes(value)) {
          return invalid;
        }
        p.angle = value;
        p.angle_enable = 'on';
        return OK;
      case 'set_angle_enable':
        // Every value other than "on" turns the swing off without an error.
        p.angle_enable = value === 'on' ? 'on' : 'off';
        return OK;
      default:
        if (value !== 'left' && value !== 'right') {
          return invalid;
        }
        if (p.angle_enable === 'on') {
          return err(-6007, 'device_busy');
        }
        this.moves.push(value);
        this.moveTimes.push(Date.now());
        return OK;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: requests are arbitrary JSON
  private handleMiot(method: string, params: any): Reply {
    const p = this.miot;
    const timeout = err(-9999, 'user ack timeout');
    if (!Array.isArray(params) || params.length === 0) {
      return timeout;
    }
    const keyOf = (item: { siid: number; piid: number }): string => `${item.siid}/${item.piid}`;
    if (method === 'get_properties') {
      return {
        result: params.map((item) => {
          const key = keyOf(item);
          const base = { did: item.did, siid: item.siid, piid: item.piid };
          return key in p && !this.unreadable.has(key)
            ? { ...base, code: 0, value: p[key] }
            : { ...base, code: -4003 };
        }),
      };
    }
    if (method !== 'set_properties') {
      return timeout;
    }
    // A fan level written alone while the fan is off is not serviced.
    if (!p['2/1'] && params.length === 1 && keyOf(params[0]) === '2/2') {
      return timeout;
    }
    return {
      result: params.map((item) => ({
        did: item.did,
        siid: item.siid,
        piid: item.piid,
        code: this.writeMiot(keyOf(item), item.value),
      })),
    };
  }

  // Not measured. Writable properties and their ranges are the spec's; the codes for a refused
  // write are the ones dmaker.fan.p33 uses.
  private writeHumidifier(key: string, value: unknown): number {
    const ranges: Record<string, [number, number] | 'bool'> = {
      '2/1': 'bool',
      '2/5': [0, 3],
      '2/6': [30, 80],
      '2/8': 'bool',
      '2/11': [200, 2000],
      '4/1': 'bool',
      '5/2': [0, 2],
      '6/1': 'bool',
      '7/5': 'bool',
    };
    const range = ranges[key];
    if (!range) {
      return key in this.humidifier ? -4003 : -4004;
    }
    const ok =
      range === 'bool'
        ? typeof value === 'boolean'
        : typeof value === 'number' &&
          Number.isInteger(value) &&
          value >= range[0] &&
          value <= range[1];
    if (!ok) {
      return -4005;
    }
    this.humidifier[key] = value as boolean | number;
    return 0;
  }

  private writeMiot(key: string, value: unknown): number {
    const p = this.miot;
    const isInt = (min: number, max: number): boolean =>
      typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
    switch (key) {
      case '2/1':
        // true and 1 turn the fan on; 0 and every string turn it off without an error.
        if (value === true || value === 1) {
          p[key] = true;
        } else if (value === false || value === 0 || typeof value === 'string') {
          p[key] = false;
          p['3/1'] = 0;
        } else {
          return -4005;
        }
        return 0;
      case '2/2':
        if (!isInt(1, 4)) {
          return -4005;
        }
        // Accepted but not applied while the fan is off.
        if (p['2/1']) {
          p[key] = value as number;
          p['2/6'] = [1, 35, 70, 100][(value as number) - 1] as number;
        }
        return 0;
      case '2/6': {
        if (!isInt(1, 100)) {
          return -4005;
        }
        const level = value as number;
        p[key] = level;
        p['2/2'] = level >= 100 ? 4 : level >= 70 ? 3 : level >= 35 ? 2 : 1;
        return 0;
      }
      case '2/3':
        if (!isInt(0, 1)) {
          return -4005;
        }
        p[key] = value as number;
        return 0;
      case '2/5':
        p[key] = value as number;
        return 0;
      case '2/4':
      case '4/1':
      case '5/1':
      case '7/1':
        if (typeof value !== 'boolean') {
          return -4005;
        }
        p[key] = value;
        return 0;
      case '6/1':
        // The end of the range is not reported: every step answers code 0.
        if (value === 1 || value === 2) {
          this.moves.push(value === 1 ? 'left' : 'right');
          this.moveTimes.push(Date.now());
          return 0;
        }
        return -4005;
      default:
        return -4003;
    }
  }
}
