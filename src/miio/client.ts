import { createSocket, type Socket } from 'node:dgram';

import { decode, encode, HELLO, parseHeader } from './packet';

export class MiioError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`${code} ${message}`);
    this.name = 'MiioError';
  }
}

export class MiioTimeoutError extends Error {
  // handshakeAnswered: the device answered the handshake but not the request. A device does
  // that when the token is wrong.
  constructor(readonly handshakeAnswered: boolean) {
    super(handshakeAnswered ? 'no reply to the request' : 'no reply');
    this.name = 'MiioTimeoutError';
  }
}

export interface MiioClientOptions {
  address: string;
  port?: number;
  /** 32 hex characters. */
  token: string;
  timeoutMs?: number;
  handshakeTtlMs?: number;
  /** Times a request is sent again after no reply. */
  retries?: number;
}

export interface CallOptions {
  /** false for a request that must not be sent twice, such as a relative move. */
  retry?: boolean;
}

interface Handshake {
  deviceId: number;
  stamp: number;
  at: number;
}

interface Reply {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

const PORT = 54321;
// Longer than the 4 s the devices take to answer "user ack timeout".
const TIMEOUT_MS = 6000;
// zhimi.fan.za1 drops a packet whose stamp is 60 s stale and still accepts 30 s.
const HANDSHAKE_TTL_MS = 20000;
const RETRIES = 2;

// One device. Requests are sent one at a time, each after the reply to the one before.
export class MiioClient {
  private readonly address: string;
  private readonly port: number;
  private readonly token: Buffer;
  private readonly timeoutMs: number;
  private readonly handshakeTtlMs: number;
  private readonly retries: number;

  private socket?: Socket;
  private handshake?: Handshake;
  private messageId = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private waiting?: (packet: Buffer) => boolean;
  private abort?: () => void;
  private closed = false;

  constructor(options: MiioClientOptions) {
    if (!/^[0-9a-fA-F]{32}$/.test(options.token)) {
      throw new Error('the token must be 32 hex characters');
    }
    this.address = options.address;
    this.port = options.port ?? PORT;
    this.token = Buffer.from(options.token, 'hex');
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.handshakeTtlMs = options.handshakeTtlMs ?? HANDSHAKE_TTL_MS;
    this.retries = options.retries ?? RETRIES;
  }

  // Rejects with MiioError when the device answers with an error and with MiioTimeoutError when
  // it does not answer.
  call<T = unknown>(method: string, params: unknown, options: CallOptions = {}): Promise<T> {
    const run = this.tail.then(() => this.exchange<T>(method, params, options.retry ?? true));
    this.tail = run.catch(() => undefined);
    return run;
  }

  // A call that is waiting for its reply is rejected.
  close(): void {
    this.closed = true;
    this.abort?.();
    this.socket?.close();
    this.socket = undefined;
  }

  private async exchange<T>(method: string, params: unknown, retry: boolean): Promise<T> {
    let handshakeAnswered = false;
    const attempts = retry ? this.retries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.closed) {
        throw new Error('the client is closed');
      }
      if (!this.handshake || Date.now() - this.handshake.at > this.handshakeTtlMs) {
        this.handshake = await this.hello();
        handshakeAnswered = this.handshake !== undefined;
        if (!this.handshake) {
          continue;
        }
      }
      // Message id 0 is never answered.
      this.messageId = (this.messageId % 9999) + 1;
      const id = this.messageId;
      const elapsed = Math.floor((Date.now() - this.handshake.at) / 1000);
      const request = encode(JSON.stringify({ id, method, params }), this.token, {
        deviceId: this.handshake.deviceId,
        stamp: this.handshake.stamp + elapsed,
      });
      const reply = await this.roundTrip<Reply>(request, (packet) => {
        const text = decode(packet, this.token);
        if (text === undefined) {
          return undefined;
        }
        try {
          const parsed = JSON.parse(text) as Reply;
          return parsed.id === id ? parsed : undefined;
        } catch {
          return undefined;
        }
      });
      if (reply) {
        if (reply.error) {
          throw new MiioError(reply.error.code, reply.error.message);
        }
        return reply.result as T;
      }
      // A lost packet, a stale stamp and an absent device look the same.
      this.handshake = undefined;
    }
    throw new MiioTimeoutError(handshakeAnswered);
  }

  private hello(): Promise<Handshake | undefined> {
    return this.roundTrip(HELLO, (packet) => {
      const header = parseHeader(packet);
      return header && header.length === 32 && packet.length === 32
        ? { deviceId: header.deviceId, stamp: header.stamp, at: Date.now() }
        : undefined;
    });
  }

  // Sends the packet and resolves with the first received packet that accept() takes, or with
  // undefined after the timeout. Other packets, such as a late handshake reply, are ignored.
  private roundTrip<R>(
    packet: Buffer,
    accept: (received: Buffer) => R | undefined,
  ): Promise<R | undefined> {
    return new Promise((resolve) => {
      const finish = (value: R | undefined): void => {
        clearTimeout(timer);
        this.waiting = undefined;
        this.abort = undefined;
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), this.timeoutMs);
      this.abort = () => finish(undefined);
      this.waiting = (received) => {
        const value = accept(received);
        if (value === undefined) {
          return false;
        }
        finish(value);
        return true;
      };
      this.open().send(packet, this.port, this.address, (error) => {
        if (error) {
          finish(undefined);
        }
      });
    });
  }

  private open(): Socket {
    if (!this.socket) {
      const socket = createSocket('udp4');
      socket.on('message', (received) => this.waiting?.(received));
      // A send error is reported to the send callback; this keeps the process from crashing on it.
      socket.on('error', () => undefined);
      socket.unref();
      this.socket = socket;
    }
    return this.socket;
  }
}
