#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const project=path.resolve(process.argv[2]||path.join(root,'.work/creator-3.7.3-test'));
const output=path.resolve(process.argv[3]||path.join(root,'.work/reference-report.json'));
const marker=JSON.parse(await fs.readFile(path.join(project,'.cocos-mcp-test-project.json'),'utf8'));
assert.equal(marker.uuid,JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8')).uuid);
assert.equal(marker.purpose,'cocos-creator-mcp integration tests');
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/server.mjs'),'--project',project,'--timeout','45000'],stderr:'pipe'});
let stderr='';transport.stderr?.on('data',data=>{stderr=(stderr+data).slice(-64000);});
const client=new Client({name:'creator37-reference-tests',version:'0.1.0'});
const report={startedAt:new Date().toISOString(),runId:Date.now().toString(36),project,steps:[],success:false};
const base='db://assets/McpReferences_'+report.runId;
const className='McpReferences_'+report.runId;
const state={};
async function call(name,args={}) {
 const reply=await client.callTool({name,arguments:args});
 const result=reply.structuredContent?.result??JSON.parse(reply.content.find(c=>c.type==='text').text);
 if(reply.isError){const error=new Error(name+': '+(result.error?.message||JSON.stringify(result)));error.details=result;throw error;}
 return result;
}
async function step(name,run){const at=Date.now();try{const evidence=await run();report.steps.push({name,passed:true,durationMs:Date.now()-at,evidence});console.log('PASS '+name);}catch(error){report.steps.push({name,passed:false,durationMs:Date.now()-at,error:error.message,details:error.details});throw error;}}
const component=(node,id)=>node.components.find(c=>c.uuid===id);
const walk=tree=>[tree,...(tree.children||[]).flatMap(walk)];

// Deterministic 1px RGBA PNG fixture; no external file or image service required.
function png(){
 const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const name=Buffer.from(type);const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length,0);name.copy(result,4);data.copy(result,8);result.writeUInt32BE(crc(Buffer.concat([name,data])),data.length+8);return result;};
 const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,64,128,255]))),chunk('IEND',Buffer.alloc(0))]);
}
try{
 await client.connect(transport);
 report.editor=await call('editor_info');
 await step('Create the reference-test scene from the installed editor template',async()=>{
  const scene=await call('scene_query');if(scene.ready&&scene.dirty)await call('scene_save');
  await call('asset_edit',{action:'create',url:base});
  state.scene=await call('scene_create',{url:base+'/References.scene'});
  state.other=await call('scene_create',{url:base+'/Other.scene'});
  const opened=await call('scene_open',{asset:state.scene.asset.uuid});
  state.canvas=walk(opened.scene.tree).find(n=>n.name==='Canvas').uuid;
 });
 await step('Create and compile a custom component through asset-db',async()=>{
  const source=`import { _decorator, Component, Node, SpriteFrame } from 'cc';\nconst {ccclass, property} = _decorator;\n@ccclass('${className}')\nexport class ${className} extends Component {\n @property(Node) target: Node | null = null;\n @property(Component) peer: Component | null = null;\n @property(SpriteFrame) icon: SpriteFrame | null = null;\n @property([Node]) targets: Node[] = [];\n @property message = 'initial';\n handleClick() {}\n}\n`;
  state.script=await call('asset_edit',{action:'create',url:base+'/References.ts',content:source});
  const deadline=Date.now()+90000;
  let catalog;
  while(Date.now()<deadline){
   try{catalog=await call('component_edit',{action:'catalog',component:className});if(catalog.classes.some(c=>c.name===className))break;}
   catch(error){if(error.details?.error?.code!=='SCENE_NOT_READY')throw error;}
   // Script compilation may temporarily reload the native scene process. Only
   // retry this read-only catalog query; never replay the asset creation above.
   await new Promise(r=>setTimeout(r,500));
  }
  assert(catalog?.classes.some(c=>c.name===className),'Custom class was not registered after compilation');
  return {script:state.script.uuid,className};
 });
 await step('Import PNG data and locate a native SpriteFrame subasset',async()=>{
  const input=path.join(project,'temp/cocos-mcp-test-inputs/icon.png');await fs.mkdir(path.dirname(input),{recursive:true});await fs.writeFile(input,png());
  state.image=await call('asset_edit',{action:'import',source:input,url:base+'/icon.png'});
  state.image=(await call('asset_edit',{action:'meta',asset:state.image.uuid,userData:{type:'sprite-frame'}})).asset;
  const frames=Object.values(state.image.subAssets||{}).filter(asset=>asset.type==='cc.SpriteFrame');
  assert.equal(frames.length,1,'Imported 2D image must have one SpriteFrame subasset');
  state.frame=frames[0];
  return {image:state.image.uuid,spriteFrame:state.frame.uuid};
 });
 await step('Bind node, component, array and asset references on custom components',async()=>{
  const created=await call('node_edit',{action:'create',parent:state.canvas,name:'ComplexRoot',components:['cc.UITransform']});state.uuid=created.uuids[0];
  const child=await call('node_edit',{action:'create',parent:state.uuid,name:'Target',components:['cc.Sprite']});state.child=child.uuids[0];
  const one=await call('component_edit',{action:'add',uuid:state.uuid,component:className});state.primary=one.added[0].uuid;
  const two=await call('component_edit',{action:'add',uuid:state.uuid,component:className});state.peer=two.added[0].uuid;
  const three=await call('component_edit',{action:'add',uuid:state.uuid,component:className});const extra=three.added[0].uuid;
  await call('component_edit',{action:'remove',uuid:state.uuid,componentUuid:extra});
  const current=await call('component_edit',{action:'list',uuid:state.uuid});assert(current.components.some(c=>c.uuid===state.primary));assert(current.components.some(c=>c.uuid===state.peer));assert(!current.components.some(c=>c.uuid===extra));
  const set=(property,value)=>call('property_set',{uuid:state.uuid,componentUuid:state.primary,path:property,value});
  await set('target',{uuid:state.child});await set('peer',{uuid:state.peer});await set('icon',base+'/icon.png');
  await set('targets',[{uuid:state.child}]);await set('message','Reference data survives prefab conversion');
  const sprite=(await call('node_query',{uuid:state.child})).components.find(c=>c.type==='cc.Sprite');
  await call('property_set',{uuid:state.child,componentUuid:sprite.uuid,path:'spriteFrame',value:{uuid:state.frame.uuid}});
  const result=component(await call('node_query',{uuid:state.uuid}),state.primary).properties;
  assert.equal(result.target.uuid,state.child);assert.equal(result.peer.uuid,state.peer);assert.equal(result.icon.uuid,state.frame.uuid);assert.equal(result.targets[0].uuid,state.child);
 });
 await step('Bind a native Button click event to the custom component',async()=>{
  const node=await call('node_edit',{action:'create',parent:state.uuid,name:'Action',components:['cc.Button']});state.button=node.uuids[0];
  const button=node.nodes[0].components.find(c=>c.type==='cc.Button');state.buttonComponent=button.uuid;
  const events=[{target:{uuid:state.uuid},component:className,handler:'handleClick',customEventData:'mcp-event'}];
  await call('property_set',{uuid:state.button,componentUuid:button.uuid,path:'clickEvents',value:events});
  const event=component(await call('node_query',{uuid:state.button}),button.uuid).properties.clickEvents[0];
  assert.equal(event.target.uuid,state.uuid);assert.equal(event.handler,'handleClick');assert.equal(event.customEventData,'mcp-event');
 });
 await step('Create a prefab using the editor serializer and check internal-reference remapping',async()=>{
  const prefab=await call('prefab_manage',{action:'create',uuid:state.uuid,url:base+'/Complex.prefab'});
  state.prefab=prefab.asset;state.uuid=prefab.source.uuid;
  state.primary=prefab.identityRemap.components[state.primary];state.peer=prefab.identityRemap.components[state.peer];state.child=prefab.identityRemap.nodes[state.child];state.button=prefab.identityRemap.nodes[state.button];state.buttonComponent=prefab.identityRemap.components[state.buttonComponent];
  const properties=component(prefab.source,state.primary).properties;
  assert.equal(properties.target.uuid,state.child);assert.equal(properties.peer.uuid,state.peer);assert.equal(properties.icon.uuid,state.frame.uuid);assert.equal(properties.targets[0].uuid,state.child);
  const event=component(await call('node_query',{uuid:state.button}),state.buttonComponent).properties.clickEvents[0];assert.equal(event.target.uuid,state.uuid);
  const instance=await call('prefab_manage',{action:'instantiate',asset:state.prefab.uuid,parent:state.canvas,name:'ComplexInstance'});
  assert.equal(instance.nodes[0].name,'ComplexInstance');
  return {prefab:state.prefab.uuid,identityRemap:prefab.identityRemap};
 });
 await step('Reopen the scene and validate prefab script, event and resource references',async()=>{
  await call('scene_save');await call('scene_open',{asset:state.other.asset.uuid});await call('scene_open',{asset:state.scene.asset.uuid});
  const rootNode=await call('node_query',{path:'Canvas/Complex'});
  const tree=(await call('scene_query')).tree;
  const nativeRoot=walk(tree).find(n=>n.uuid===rootNode.uuid);
  const child=nativeRoot.children.find(n=>n.name==='Target');const buttonNode=nativeRoot.children.find(n=>n.name==='Action');
  const customs=rootNode.components.filter(c=>c.properties.message!==undefined);assert.equal(customs.length,2);
  const primary=customs.find(c=>c.properties.message==='Reference data survives prefab conversion');assert(primary);
  assert.equal(primary.properties.target.uuid,child.uuid);assert(customs.some(c=>c.uuid===primary.properties.peer.uuid));assert.equal(primary.properties.icon.uuid,state.frame.uuid);assert.equal(primary.properties.targets[0].uuid,child.uuid);
  const sprite=(await call('node_query',{uuid:child.uuid})).components.find(c=>c.type==='cc.Sprite');assert.equal(sprite.properties.spriteFrame.uuid,state.frame.uuid);
  const event=(await call('node_query',{uuid:buttonNode.uuid})).components.find(c=>c.type==='cc.Button').properties.clickEvents[0];assert.equal(event.target.uuid,rootNode.uuid);assert.equal(event.handler,'handleClick');assert.equal(event.customEventData,'mcp-event');
 });
 report.success=true;
}catch(error){report.error={message:error.message,details:error.details};console.error('FAIL',error.message,error.details||'');process.exitCode=1;}
finally{await client.close().catch(()=>{});report.finishedAt=new Date().toISOString();report.stderr=stderr;await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log('Report: '+output);}
