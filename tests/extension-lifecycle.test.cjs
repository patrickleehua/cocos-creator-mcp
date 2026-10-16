'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../extensions/cocos-creator-mcp/main.js'),'utf8');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(){
 const events=[],exports={};let next=0,stopping=null,failStart=false;
 vm.runInNewContext(source,{exports,Editor:{App:{version:'3.7.3'},Project:{name:'Fixture',path:'fixture'}},console:{log(){},error(){}},require(name){
  if(name==='./adapter')return {createAdapter(){const id=++next;events.push('adapter '+id);return {dispatch(){},commands(){return [];},dispose(){events.push('dispose '+id);}};}};
  if(name==='./bridge')return {async startBridge(){const id=next;events.push('start '+id);if(failStart)throw Error('port failure');return {port:id,sessionId:String(id),async stop(){events.push('stop '+id);if(stopping)await stopping;events.push('stopped '+id);}};}};
  throw Error('Unexpected dependency '+name);
 }});
 return {exports,events,holdStop(value){stopping=value;},failStart(value){failStart=value;}};
}
test('start waits for a pending stop to drain before creating or exposing a replacement adapter',async()=>{
 const f=fixture();await f.exports.load();const held=deferred();f.holdStop(held.promise);
 const stopped=f.exports.methods.stopBridge();const restarted=f.exports.methods.startBridge();
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.events,['adapter 1','start 1','stop 1']);
 held.resolve();await stopped;const running=await restarted;assert.equal(running.sessionId,'2');
 assert.deepEqual(f.events,['adapter 1','start 1','stop 1','stopped 1','dispose 1','adapter 2','start 2']);
 await f.exports.unload();
});
test('duplicate starts and unload during start cannot leak a second listener',async()=>{
 const f=fixture();await Promise.all([f.exports.load(),f.exports.methods.startBridge(),f.exports.unload()]);
 assert.deepEqual(f.events,['adapter 1','start 1','stop 1','stopped 1','dispose 1']);
 assert.equal(f.exports.methods.bridgeStatus().running,false);
});
test('failed startup disposes its adapter and does not poison the lifecycle queue',async()=>{
 const f=fixture();f.failStart(true);await assert.rejects(f.exports.methods.startBridge(),/port failure/);
 assert.equal(f.exports.methods.bridgeStatus().running,false);f.failStart(false);await f.exports.methods.startBridge();
 assert.deepEqual(f.events,['adapter 1','start 1','dispose 1','adapter 2','start 2']);await f.exports.unload();
});
test('discovery cleanup failure still clears the stopped bridge and allows a deliberate restart',async()=>{
 const f=fixture();await f.exports.load();f.holdStop(Promise.reject(Error('cleanup failed')));
 await assert.rejects(f.exports.methods.stopBridge(),/cleanup failed/);assert.equal(f.exports.methods.bridgeStatus().running,false);
 f.holdStop(null);await f.exports.methods.startBridge();assert.equal(f.exports.methods.bridgeStatus().running,true);await f.exports.unload();
});
