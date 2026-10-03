'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bomEncoding,
  decodePascalBytes,
  decodeProcessOutput,
  declaredXmlEncoding,
  isAscii,
  isValidUtf8,
  normalizeXmlEncoding,
  reconciledEncoding
} = require('../src/encodingSupport');

test('normalizes supported XML encoding aliases', () => {
  assert.equal(normalizeXmlEncoding('UTF-8'), 'utf8');
  assert.equal(normalizeXmlEncoding('GB-2312'), 'gb2312');
  assert.equal(normalizeXmlEncoding('cp936'), 'gbk');
  assert.equal(normalizeXmlEncoding('unknown'), undefined);
});

test('reads encoding declaration from the ASCII XML prolog', () => {
  const bytes = Buffer.from('<?xml version="1.0" encoding="utf-8"?><Project />', 'ascii');
  assert.equal(declaredXmlEncoding(bytes), 'utf8');
});

test('returns undefined when a DPROJ has no encoding declaration', () => {
  assert.equal(declaredXmlEncoding(Buffer.from('<Project />', 'ascii')), undefined);
});

test('detects BOMs and distinguishes valid UTF-8 from a legacy byte stream', () => {
  assert.equal(bomEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'utf8bom');
  assert.equal(bomEncoding(Buffer.from([0xff, 0xfe, 0x41, 0x00])), 'utf16le');
  assert.equal(isAscii(Buffer.from('unit Example;', 'ascii')), true);
  assert.equal(isValidUtf8(Buffer.from('中文', 'utf8')), true);
  assert.equal(isValidUtf8(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), false);
});

test('uses GB2312 for a PAS file that is neither clearly UTF-8 nor explicitly encoded', () => {
  const legacyBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(reconciledEncoding(legacyBytes, 'gbk', 'gb2312', true), 'gb2312');
  assert.equal(reconciledEncoding(Buffer.from('中文', 'utf8'), 'utf8', 'gb2312', true), 'utf8');
  assert.equal(reconciledEncoding(Buffer.from('unit X;', 'ascii'), 'utf8', 'gb2312', true), 'gb2312');
  assert.equal(reconciledEncoding(legacyBytes, 'utf16le', 'gb2312', true, 'utf16le'), 'utf16le');
});

test('decodes UTF-8 and legacy GB2312 Pascal sources before indexing', () => {
  assert.equal(decodePascalBytes(Buffer.from('unit 中文;', 'utf8')), 'unit 中文;');
  const gb2312 = Buffer.concat([
    Buffer.from('unit Legacy; // ', 'ascii'),
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
    Buffer.from('\r\nend.', 'ascii')
  ]);
  assert.equal(decodePascalBytes(gb2312), 'unit Legacy; // 中文\r\nend.');
});

test('decodes Delphi compiler output as UTF-8 or the Windows Chinese ANSI code page', () => {
  assert.equal(decodeProcessOutput(Buffer.from('提示：UTF-8 输出', 'utf8')), '提示：UTF-8 输出');
  const cp936 = Buffer.from([
    0x53, 0x79, 0x6d, 0x62, 0x6f, 0x6c, 0x20, 0x27, 0x44, 0x65, 0x66, 0x54,
    0x6f, 0x6c, 0x27, 0x20, 0x69, 0x73, 0x20, 0x64, 0x65, 0x70, 0x72, 0x65,
    0x63, 0x61, 0x74, 0x65, 0x64, 0x3a, 0x20, 0xbe, 0xc9, 0xbd, 0xd3, 0xbf, 0xda,
    0xa3, 0xac, 0xc7, 0xeb, 0xb8, 0xc4, 0xd3, 0xc3, 0x20, 0x44, 0x65, 0x66, 0x61,
    0x75, 0x6c, 0x74, 0x54, 0x6f, 0x6c
  ]);
  assert.equal(
    decodeProcessOutput(cp936),
    "Symbol 'DefTol' is deprecated: 旧接口，请改用 DefaultTol"
  );
  assert.equal(decodeProcessOutput('already decoded'), 'already decoded');
});
