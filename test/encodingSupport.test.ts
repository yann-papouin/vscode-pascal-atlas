import { test as test } from 'node:test';
import * as assert from 'node:assert/strict';
import { bomEncoding, decodePascalBytes, decodeProcessOutput, declaredXmlEncoding, isAscii, isValidUtf8, normalizeXmlEncoding, reconciledEncoding } from '../src/encodingSupport';

test('recognizes UTF-8 XML encoding declarations only', () => {
  assert.equal(normalizeXmlEncoding('UTF-8'), 'utf8');
  assert.equal(normalizeXmlEncoding('utf8'), 'utf8');
  assert.equal(normalizeXmlEncoding('GB-2312'), undefined);
  assert.equal(normalizeXmlEncoding('cp936'), undefined);
  assert.equal(normalizeXmlEncoding('unknown'), undefined);
});

test('reads encoding declaration from the ASCII XML prolog', () => {
  const bytes = Buffer.from('<?xml version="1.0" encoding="utf-8"?><Project />', 'ascii');
  assert.equal(declaredXmlEncoding(bytes), 'utf8');
});

test('returns undefined when a DPROJ has no encoding declaration', () => {
  assert.equal(declaredXmlEncoding(Buffer.from('<Project />', 'ascii')), undefined);
});

test('detects UTF-8 BOM and validates UTF-8 bytes', () => {
  assert.equal(bomEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'utf8bom');
  assert.equal(bomEncoding(Buffer.from([0xff, 0xfe, 0x41, 0x00])), undefined);
  assert.equal(isAscii(Buffer.from('unit Example;', 'ascii')), true);
  assert.equal(isValidUtf8(Buffer.from('UTF-8 sample', 'utf8')), true);
  assert.equal(isValidUtf8(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), false);
});

test('reconciles files using only UTF-8 choices', () => {
  const invalidUtf8 = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(reconciledEncoding(invalidUtf8, 'utf8'), 'utf8');
  assert.equal(reconciledEncoding(Buffer.from('UTF-8 café', 'utf8'), 'utf8bom'), 'utf8');
  assert.equal(reconciledEncoding(Buffer.from('unit X;', 'ascii'), 'utf8bom'), 'utf8bom');
  assert.equal(reconciledEncoding(invalidUtf8, 'gb2312'), 'utf8');
  assert.equal(reconciledEncoding(Buffer.from('<?xml encoding="gbk"?>', 'ascii'), 'utf8', 'gbk'), 'utf8');
});

test('decodes Pascal sources as UTF-8', () => {
  assert.equal(decodePascalBytes(Buffer.from('unit Sample;', 'utf8')), 'unit Sample;');
  assert.equal(decodePascalBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'A');
});

test('decodes Delphi compiler output as UTF-8', () => {
  assert.equal(decodeProcessOutput(Buffer.from('Notice: UTF-8 output', 'utf8')), 'Notice: UTF-8 output');
  assert.equal(decodeProcessOutput('already decoded'), 'already decoded');
});
