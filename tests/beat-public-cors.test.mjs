import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(file) {
  return readFileSync(new URL(file, import.meta.url), 'utf8');
}

const anchorRoute = read('../app/api/v1/beat/anchor/route.ts');
const verifyRoute = read('../app/api/v1/beat/verify/route.ts');
const timestampRoute = read('../app/api/v1/beat/timestamp/route.ts');
const keyRoute = read('../app/api/v1/beat/key/route.ts');

test('public beat routes expose wildcard CORS for access portability', () => {
  assert.equal(anchorRoute.includes("'Access-Control-Allow-Origin': '*'"), true);
  assert.equal(verifyRoute.includes("'Access-Control-Allow-Origin': '*'"), true);
  assert.equal(timestampRoute.includes("'Access-Control-Allow-Origin': '*'"), true);
  assert.equal(keyRoute.includes("'Access-Control-Allow-Origin': '*'"), true);
});

test('public beat routes implement OPTIONS preflight handlers', () => {
  assert.equal(anchorRoute.includes('export function OPTIONS()'), true);
  assert.equal(verifyRoute.includes('export function OPTIONS()'), true);
  assert.equal(timestampRoute.includes('export function OPTIONS()'), true);
  assert.equal(keyRoute.includes('export function OPTIONS()'), true);
});

