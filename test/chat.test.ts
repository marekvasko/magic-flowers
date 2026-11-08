import test from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';

test('chat: správa sa oreže na D.CHAT_MAX znakov', () => {
  assert.strictEqual(D.CHAT_MAX, 120);
  assert.strictEqual(D.chatText('a'.repeat(500)).length, D.CHAT_MAX);
  assert.strictEqual(D.chatText('ahoj'), 'ahoj');
});

test('chat: odstráni < >, medzery na krajoch a prázdne správy', () => {
  assert.strictEqual(D.chatText('  <b>ahoj</b>  '), 'bahoj/b');
  assert.strictEqual(D.chatText('   '), '');
  assert.strictEqual(D.chatText(undefined), '');
  assert.strictEqual(D.chatText(42), '42');
  // orezanie neskončí medzerou
  assert.strictEqual(D.chatText('a'.repeat(119) + '  b'), 'a'.repeat(119));
});
