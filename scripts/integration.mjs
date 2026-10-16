#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = path.resolve(process.argv[2] || path.join(root, '.work/creator-3.7.3-test'));
const output = path.resolve(process.argv[3] || path.join(root, '.work/integration-report.json'));
const marker = JSON.parse(await fs.readFile(path.join(project, '.cocos-mcp-test-project.json'), 'utf8'));
const projectInfo = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
assert.equal(marker.uuid, projectInfo.uuid, 'Integration tests require their own marked disposable project');
assert.equal(marker.purpose, 'cocos-creator-mcp integration tests');
const transport = new StdioClientTransport({ command:process.execPath, args:[path.join(root,'src/server.mjs'),'--project',project,'--timeout','45000'], stderr:'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-64000); });
const client = new Client({name:'creator37-integration',version:'0.1.0'});
const report = {project, startedAt:new Date().toISOString(), runId:Date.now().toString(36), steps:[], success:false};
const base = 'db://assets/McpIntegration_' + report.runId;
const values = {};
async function invoke(name, args = {}) {
  const result = await client.callTool({name, arguments:args});
  const data = result.structuredContent?.result ?? JSON.parse(result.content.find(item=>item.type==='text').text);
  if (result.isError) { const error = new Error(name + ': ' + (data.error?.message || JSON.stringify(data))); error.details = data; throw error; }
  return data;
}
async function expectError(name, args, code) {
  const result = await client.callTool({name,arguments:args});
  assert.equal(result.isError,true,'Expected tool failure');
  const data = result.structuredContent || JSON.parse(result.content[0].text);
  assert.equal(data.error.code,code);
}
async function step(name, run) {
  const start = Date.now();
  try { const evidence = await run(); report.steps.push({name,passed:true,durationMs:Date.now()-start,evidence}); console.log('PASS ' + name); }
  catch(error) { report.steps.push({name,passed:false,durationMs:Date.now()-start,error:error.message,details:error.details}); throw error; }
}
function nodes(tree) { return (Array.isArray(tree)?tree:tree?[tree]:[]).flatMap(n=>[n,...nodes(n.children)]); }

try {
  await client.connect(transport);
  await step('Real SDK handshake and tool discovery',async()=>{
    const names=(await client.listTools()).tools.map(tool=>tool.name);
    for(const name of ['editor_info','scene_query','scene_open','scene_save','scene_create','node_query','node_edit','component_edit','property_set','asset_query','asset_edit','prefab_manage','ui_build']) assert(names.includes(name),name+' missing');
    const info=await invoke('editor_info'); assert.match(info.editorVersion,/^3\.7\./); assert.equal(info.project.uuid,marker.uuid);
    report.editor=info; return {toolNames:names,runtime:info.runtime};
  });
  await step('Create native-template scenes and open the requested asset',async()=>{
    const current=await invoke('scene_query'); if(current.ready&&current.dirty)await invoke('scene_save');
    await invoke('asset_edit',{action:'create',url:base});
    values.sceneA=await invoke('scene_create',{url:base+'/Main.scene'});
    values.sceneB=await invoke('scene_create',{url:base+'/Other.scene'});
    const opened=await invoke('scene_open',{asset:base+'/Main.scene'});
    assert.equal(opened.scene.tree.uuid,values.sceneA.asset.uuid);
    values.canvas=nodes(opened.scene.tree).find(n=>n.name==='Canvas').uuid;
    return {scene:opened.scene.tree.uuid,canvas:values.canvas};
  });
  await step('Create UI node and verify requested components',async()=>{
    const result=await invoke('node_edit',{action:'create',name:'MCPPanel',parent:values.canvas,components:['cc.UITransform','cc.Label']});
    values.uuid=result.uuids[0];
    const node=await invoke('node_query',{path:'Canvas/MCPPanel'});
    assert.equal(node.uuid,values.uuid);
    values.label=node.components.find(c=>c.type==='cc.Label').uuid;
    values.transform=node.components.find(c=>c.type==='cc.UITransform').uuid;
    return {uuid:values.uuid,label:values.label};
  });
  await step('Set and read text, zero values, booleans, vectors and colors',async()=>{
    const set=(property,value,componentUuid)=>invoke('property_set',{uuid:values.uuid,path:property,value,...(componentUuid?{componentUuid}:{})});
    await set('string','',values.label);
    await set('string','Creator 3.7 MCP 测试',values.label);
    await set('position',{x:123,y:45,z:0});
    await set('position.x',0);
    await set('active',false);
    await set('active',true);
    await set('color',{r:0,g:128,b:255,a:255},values.label);
    // Label.NONE owns its transform size. CLAMP permits the requested bounds.
    await set('overflow',1,values.label);
    await set('contentSize',{width:240,height:64},values.transform);
    const node=await invoke('node_query',{uuid:values.uuid});
    assert.equal(node.components.find(c=>c.uuid===values.label).properties.string,'Creator 3.7 MCP 测试');
    assert.deepEqual(node.position,{x:0,y:45,z:0});
    return {text:'Creator 3.7 MCP 测试',position:node.position};
  });
  await step('Reject invalid values before mutation',async()=>{
    await expectError('property_set',{uuid:values.uuid,path:'position',value:{x:'bad',y:0,z:0}},'INVALID_ARGUMENT');
    await expectError('property_set',{uuid:values.uuid,path:'__proto__.bad',value:1},'INVALID_ARGUMENT');
    const node=await invoke('node_query',{uuid:values.uuid}); assert.deepEqual(node.position,{x:0,y:45,z:0});
  });
  await step('Undo and redo a native property edit',async()=>{
    await invoke('property_set',{uuid:values.uuid,path:'position',value:{x:200,y:100,z:0}});
    await invoke('scene_history',{action:'undo'});
    assert.deepEqual((await invoke('node_query',{uuid:values.uuid})).position,{x:0,y:45,z:0});
    await invoke('scene_history',{action:'redo'});
    assert.deepEqual((await invoke('node_query',{uuid:values.uuid})).position,{x:200,y:100,z:0});
  });
  await step('Protect unsaved scene changes',async()=>{
    await expectError('scene_open',{asset:base+'/Other.scene'},'UNSAVED_CHANGES');
    assert.equal((await invoke('scene_query')).tree.uuid,values.sceneA.asset.uuid);
  });
  await step('Add and remove a component by its verified instance',async()=>{
    const added=await invoke('component_edit',{action:'add',uuid:values.uuid,component:'cc.Widget'});
    const widget=added.added.find(c=>c.type==='cc.Widget'); assert(widget);
    await invoke('component_edit',{action:'remove',uuid:values.uuid,componentUuid:widget.uuid});
    assert(!(await invoke('component_edit',{action:'list',uuid:values.uuid})).components.some(c=>c.uuid===widget.uuid));
  });
  await step('Duplicate, reparent and remove nodes through native messages',async()=>{
    const parent=await invoke('node_edit',{action:'create',parent:values.canvas,name:'Container'});
    const copy=await invoke('node_edit',{action:'duplicate',uuid:values.uuid});
    await invoke('node_edit',{action:'reparent',uuid:copy.uuids[0],parent:parent.uuids[0],keepWorldTransform:true});
    assert.equal((await invoke('node_query',{uuid:copy.uuids[0]})).parentUuid,parent.uuids[0]);
    await invoke('node_edit',{action:'remove',uuid:copy.uuids[0]});
    await expectError('node_query',{uuid:copy.uuids[0]},'NODE_NOT_FOUND');
  });
  await step('Create, save, copy, move and delete text assets',async()=>{
    let asset=await invoke('asset_edit',{action:'create',url:base+'/empty.txt',content:''});
    assert.equal(await fs.readFile(asset.file,'utf8'),'');
    asset=await invoke('asset_edit',{action:'save',asset:asset.uuid,content:'Native asset database\n测试'});
    assert.equal(await fs.readFile(asset.file,'utf8'),'Native asset database\n测试');
    const copied=await invoke('asset_edit',{action:'copy',asset:asset.uuid,url:base+'/copy.txt'});
    const moved=await invoke('asset_edit',{action:'move',asset:copied.uuid,url:base+'/moved.txt'});
    assert.equal(moved.uuid,copied.uuid); assert.equal(await fs.readFile(moved.file,'utf8'),'Native asset database\n测试');
    await invoke('asset_edit',{action:'delete',asset:moved.uuid});
    await expectError('asset_query',{action:'info',asset:moved.uuid},'ASSET_NOT_FOUND');
    await expectError('asset_edit',{action:'create',url:'db://assets/../escape.txt',content:'bad'},'INVALID_ASSET_URL');
  });
  await step('Build a nested UI subtree with component properties',async()=>{
    const result=await invoke('ui_build',{parent:values.canvas,tree:[{name:'BuiltRoot',components:[{type:'cc.UITransform'}],children:[{name:'Caption',components:[{type:'cc.Label',properties:{string:'Nested caption',fontSize:20}}]}]}]});
    assert.equal(result.created.length,2);
    const caption=await invoke('node_query',{path:'Canvas/BuiltRoot/Caption'});
    assert.equal(caption.components.find(c=>c.type==='cc.Label').properties.string,'Nested caption');
  });
  await step('Create and instantiate a native prefab preserving text',async()=>{
    const prefab=await invoke('prefab_manage',{action:'create',uuid:values.uuid,url:base+'/Panel.prefab'});
    assert.equal(prefab.asset.type,'cc.Prefab');
    values.prefabAsset=prefab.asset;
    values.uuid=prefab.source.uuid;
    values.label=prefab.source.components.find(c=>c.type==='cc.Label').uuid;
    values.sourcePath='Canvas/'+prefab.source.name;
    const instance=await invoke('prefab_manage',{action:'instantiate',url:base+'/Panel.prefab',parent:values.canvas,name:'PrefabInstance'});
    values.instance=instance.uuids[0];
    const node=await invoke('node_query',{uuid:values.instance});
    assert.equal(node.components.find(c=>c.type==='cc.Label').properties.string,'Creator 3.7 MCP 测试');
    return {assetUuid:prefab.asset.uuid,instanceUuid:values.instance};
  });
  await step('Save to disk, switch scenes and verify reopened data',async()=>{
    await invoke('scene_save');
    const disk=JSON.parse(await fs.readFile(values.sceneA.asset.file,'utf8'));
    // Native prefab linking stores an asset reference in the scene; component
    // data is serialized in the prefab, then verified after a real scene reload.
    assert(JSON.stringify(disk).includes(values.prefabAsset.uuid));
    const prefabDisk=JSON.parse(await fs.readFile(values.prefabAsset.file,'utf8'));
    assert(prefabDisk.some(item=>item.__type__==='cc.Label'&&item._string==='Creator 3.7 MCP 测试'));
    await invoke('scene_open',{asset:base+'/Other.scene'});
    await invoke('scene_open',{asset:base+'/Main.scene'});
    const node=await invoke('node_query',{path:values.sourcePath});
    assert.equal(node.components.find(c=>c.type==='cc.Label').properties.string,'Creator 3.7 MCP 测试');
    assert.deepEqual(node.position,{x:200,y:100,z:0});
    assert.equal((await invoke('scene_query')).dirty,false);
  });
  report.success=true;
} catch(error) {
  report.error={message:error.message,details:error.details};
  console.error('FAIL',error.message,error.details||''); process.exitCode=1;
} finally {
  await client.close().catch(()=>{});
  report.finishedAt=new Date().toISOString(); report.stderr=stderr;
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log('Report: '+output);
}
