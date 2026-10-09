import { describe, expect, it } from 'vitest';

import { decode, encode, HELLO, parseHeader } from '../src/miio/packet';

// Reference packets made with the Python client that was checked against the real devices.
const TOKEN = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const REQUEST =
  '21310050000000000badf00d000003e8a3da2f4c3dd8ac1fb4ec2eee2859c42ea5516ec6151955dc2bb2d43e7c84c1833ad6abd2560c09de4318b095b7713e230bbed4ee40764c0304f323716693cc0a';
const REPLY =
  '21310040000000000badf00d000003e92f34cdef8b160aa737c3791396832e8595d444d970e45e453f755f0301fb09fd13e0600851ba45dd821db6a00a6dfb4a';

describe('miio packet', () => {
  it('encodes a request the way the devices accept it', () => {
    const packet = encode('{"id":1,"method":"get_prop","params":["power"]}', TOKEN, {
      deviceId: 0x0badf00d,
      stamp: 1000,
    });
    expect(packet.toString('hex')).toBe(REQUEST);
  });

  it('decodes a reply and drops the NUL bytes the devices append', () => {
    expect(decode(Buffer.from(REPLY, 'hex'), TOKEN)).toBe('{"id":1,"result":["on"]}');
  });

  it('does not decode a packet made with another token', () => {
    const other = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
    expect(decode(Buffer.from(REPLY, 'hex'), other)).toBeUndefined();
  });

  it('reads the device id and the stamp from a handshake reply', () => {
    const reply = Buffer.from(`21310020000000000badf00d000003e8${'ff'.repeat(16)}`, 'hex');
    expect(parseHeader(reply)).toEqual({ deviceId: 0x0badf00d, stamp: 1000, length: 32 });
  });

  it('has the 32-byte handshake request', () => {
    expect(HELLO.toString('hex')).toBe(`21310020${'ff'.repeat(28)}`);
  });

  it('does not read a header from something that is not a miio packet', () => {
    expect(parseHeader(Buffer.from('hello'))).toBeUndefined();
    expect(parseHeader(Buffer.alloc(32))).toBeUndefined();
  });
});
