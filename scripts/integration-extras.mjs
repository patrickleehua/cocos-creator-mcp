#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const project=path.resolve(process.argv[2]);
const output=path.resolve(process.argv[3]||'.work/extras-report.json');
const marker=JSON.parse(await fs.readFile(path.join(project,'.cocos-mcp-test-project.json'),'utf8'));
assert.equal(marker.purpose,'cocos-creator-mcp integration tests');
assert.equal(marker.uuid,JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8')).uuid);
const client=new Client({name:'creator37-extras-tests',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/server.mjs'),'--project',project,'--timeout','45000'],stderr:'pipe'});
let stderr='';transport.stderr?.on('data',data=>{stderr=(stderr+data).slice(-64000);});
const report={startedAt:new Date().toISOString(),project,steps:[],success:false};
async function call(name,args={}){
 const reply=await client.callTool({name,arguments:args});
 const result=reply.structuredContent?.result??JSON.parse(reply.content.find(c=>c.type==='text').text);
 if(reply.isError){const error=new Error(name+': '+result.error.message);error.details=result;throw error;}
 return result;
}
async function step(name,run){const at=Date.now();try{const evidence=await run();report.steps.push({name,passed:true,durationMs:Date.now()-at,evidence});console.log('PASS '+name);}catch(error){report.steps.push({name,passed:false,durationMs:Date.now()-at,error:error.message,details:error.details});throw error;}}
try{
 await client.connect(transport);report.editor=await call('editor_info');
 await step('Read the native preview URL and request refresh',async()=>{
  const info=await call('editor_preview',{action:'info'});assert.match(info.url,/^https?:/);
  const refresh=await call('editor_preview',{action:'refresh'});assert.equal(refresh.requested,true);
  return {info,refresh};
 });
 await step('Filter real editor logs with bounded normalized results',async()=>{
  const logs=await call('editor_logs',{level:'info',limit:5,since:0});
  assert.equal(logs.source,'Editor.Logger.query');assert(logs.entries.length<=5);
  for(const entry of logs.entries){assert.equal(entry.level,'info');assert.equal(typeof entry.timestamp,'number');assert.equal(typeof entry.message,'string');}
  return logs;
 });
 await step('Query registered web build platform configuration',async()=>{
  const config=await call('project_build',{action:'config',options:{platform:'web-desktop'}});
  assert.equal(config.platform,'web-desktop');assert(config.config&&typeof config.config==='object');return config;
 });
 if(process.argv.includes('--build-cancel'))await step('Cancel only the native build owned by this job and await completion',async()=>{
  const scene=await call('scene_query');assert(scene.ready&&!scene.dirty);
  const asset=await call('asset_query',{action:'info',asset:scene.tree.uuid});
  const job=await call('project_build',{action:'start',options:{platform:'web-desktop',debug:true,buildPath:'project://build',outputName:'mcp-cancel-test',startScene:asset.uuid,scenes:[{uuid:asset.uuid,url:asset.url}]}});
  report.buildJob=job;
  let status;
  const identifyUntil=Date.now()+30000;
  do{status=await call('project_build',{action:'status',taskId:job.taskId});if(status.task.finishedAt!==null||status.nativeTask)break;await new Promise(r=>setTimeout(r,250));}while(Date.now()<identifyUntil);
  if(status.task.finishedAt===null){assert(status.nativeTask,'Native task identity did not become available');const cancelled=await call('project_build',{action:'cancel',taskId:job.taskId});assert.equal(cancelled.cancelRequested,true);report.cancellation=cancelled;}
  const until=Date.now()+120000;
  while(status.task.finishedAt===null&&Date.now()<until){await new Promise(r=>setTimeout(r,1000));status=await call('project_build',{action:'status',taskId:job.taskId});}
  report.buildStatus=status;
  assert.notEqual(status.task.finishedAt,null,'Cancellation outcome is still unknown; inspect this job before any further write');assert.equal(status.isBuilding,false);
  assert.equal(status.task.cancelRequested,true,'Build completed before the cancellation workflow could be tested');
  return status.task;
 });
 report.success=true;
}catch(error){report.error={message:error.message,details:error.details};console.error('FAIL',error.message,error.details||'');process.exitCode=1;}
finally{await client.close().catch(()=>{});report.finishedAt=new Date().toISOString();report.stderr=stderr;await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log('Report: '+output);}
