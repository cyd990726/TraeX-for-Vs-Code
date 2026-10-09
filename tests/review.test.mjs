import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {createPatch} from 'diff';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'trae-review-'));
await build({entryPoints:['src/review.ts'],outfile:join(dir,'review.cjs'),bundle:true,platform:'node'});
const {reconstructBefore}=await import(join(dir,'review.cjs'));
await test('review reconstructs exact before text for updates, adds and deletions',()=>{for(const [before,after] of [['one\ntwo\n','one\nthree\n'],['','new\n'],['gone\n',''],['old','new']])assert.equal(reconstructBefore(after,createPatch('test.txt',before,after)),before);});
await test('review rejects stale and malformed patches instead of inventing a baseline',()=>{assert.equal(reconstructBefore('different\n',createPatch('test.txt','before\n','after\n')),undefined);assert.equal(reconstructBefore('x','not a patch'),undefined);});
await rm(dir,{recursive:true,force:true});
