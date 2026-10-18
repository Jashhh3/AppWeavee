import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

describe('MCP project tools', () => { let app: FastifyInstance; let dir: string;
 beforeEach(async () => { dir=await mkdtemp(join(tmpdir(),'appweave-mcp-')); app=await buildApp({dataFile:join(dir,'db.json'),workspaceRoot:join(dir,'projects'),jwtSecret:'mcp-secret',encryptionKey:'mcp-encryption'}); });
 afterEach(async () => { await app.close(); await rm(dir,{recursive:true,force:true}); });
 async function register(email:string){const r=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email,password:'correct horse battery staple'}});return r.json().token as string;}
 async function call(token:string,name:string,args:Record<string,unknown>={}){return app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${token}`},payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}});}
 it('discovers tools and persists a basic write/read flow',async()=>{const token=await register('mcp-tools@example.com');const list=await app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${token}`},payload:{jsonrpc:'2.0',id:1,method:'tools/list'}});expect(list.json().result.tools.map((x:any)=>x.name)).toEqual(expect.arrayContaining(['list_projects','write_file','read_file','create_checkpoint']));const project=(await call(token,'create_project',{name:'Connector'})).json().result.structuredContent;const write=await call(token,'write_file',{projectId:project.id,path:'src/index.ts',content:'export const answer = 42;'});expect(write.json().result.structuredContent.written).toBe(true);const read=await call(token,'read_file',{projectId:project.id,path:'src/index.ts'});expect(read.json().result.structuredContent.content).toContain('answer = 42');});
 it('enforces ownership and rejects traversal paths',async()=>{const owner=await register('mcp-owner@example.com');const other=await register('mcp-other@example.com');const project=(await call(owner,'create_project',{name:'Private'})).json().result.structuredContent;expect((await call(other,'read_file',{projectId:project.id,path:'secret.txt'})).json().error.message).toBe('Project not found');expect((await call(owner,'write_file',{projectId:project.id,path:'../escape.txt',content:'no'})).json().error.message).toContain('inside the project workspace');expect((await call(owner,'write_file',{projectId:project.id,path:'/tmp/escape.txt',content:'no'})).json().error).toBeTruthy();});
});
