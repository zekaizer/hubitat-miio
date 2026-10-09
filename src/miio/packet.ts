import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export interface Header {
  deviceId: number;
  stamp: number;
}

const MAGIC = 0x2131;
const HEADER_LENGTH = 32;

export const HELLO = Buffer.concat([Buffer.from('21310020', 'hex'), Buffer.alloc(28, 0xff)]);

const md5 = (...parts: Buffer[]): Buffer => createHash('md5').update(Buffer.concat(parts)).digest();

function keys(token: Buffer): { key: Buffer; iv: Buffer } {
  const key = md5(token);
  return { key, iv: md5(key, token) };
}

// length is the packet length the header declares: 32 for a handshake reply.
export function parseHeader(packet: Buffer): (Header & { length: number }) | undefined {
  if (packet.length < HEADER_LENGTH || packet.readUInt16BE(0) !== MAGIC) {
    return undefined;
  }
  return {
    length: packet.readUInt16BE(2),
    deviceId: packet.readUInt32BE(8),
    stamp: packet.readUInt32BE(12),
  };
}

export function encode(payload: string, token: Buffer, header: Header): Buffer {
  const { key, iv } = keys(token);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const body = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const head = Buffer.alloc(16);
  head.writeUInt16BE(MAGIC, 0);
  head.writeUInt16BE(HEADER_LENGTH + body.length, 2);
  head.writeUInt32BE(header.deviceId, 8);
  head.writeUInt32BE(header.stamp, 12);
  return Buffer.concat([head, md5(head, token, body), body]);
}

// Returns undefined for a packet that was not made with this token.
export function decode(packet: Buffer, token: Buffer): string | undefined {
  if (parseHeader(packet) === undefined || packet.length <= HEADER_LENGTH) {
    return undefined;
  }
  const body = packet.subarray(HEADER_LENGTH);
  if (!md5(packet.subarray(0, 16), token, body).equals(packet.subarray(16, HEADER_LENGTH))) {
    return undefined;
  }
  const { key, iv } = keys(token);
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    const text = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    // The devices end the JSON with NUL bytes.
    return text.replace(/\0+$/, '');
  } catch {
    return undefined;
  }
}
