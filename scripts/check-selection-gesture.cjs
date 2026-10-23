'use strict';
// 独立原生回归，仅使用自有虚构材料窗口。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),framework=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319');
const sourceIndex=process.argv.indexOf('--source');
if(sourceIndex>=0 && (!process.argv[sourceIndex+1] || process.argv[sourceIndex+1].startsWith('--'))) throw Error('--source 后需要指定源码路径');
const source=path.resolve(sourceIndex>=0?process.argv[sourceIndex+1]:path.join(root,'src/windows/ContextProbe.cs'));
const dir=path.join(root,'.scratch/selection-gesture',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(dir,{recursive:true});
const report={description:'传统编辑控件的真实只读 UIA 两阶段手势回归',source,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')};
let exitCode=2;
try {
  function compile(name,file,refs){const target=path.join(dir,name+'.exe'),r=spawnSync(path.join(framework,'csc.exe'),['/nologo','/codepage:65001','/target:exe','/platform:x64','/out:'+target,...refs.map(v=>'/reference:'+path.join(framework,v)),file],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error(r.stdout||r.stderr||r.error?.message);return target;}
  const refs=['System.Web.Extensions.dll','WPF/UIAutomationClient.dll','WPF/UIAutomationTypes.dll','WPF/WindowsBase.dll'];
  const helper=compile('ContextProbe',source,refs),fixture=compile('SelectionGestureFixture',path.join(root,'tests/fixtures/selection-gesture-fixture.cs'),[...refs,'System.Windows.Forms.dll','System.Drawing.dll']);
  const run=spawnSync(fixture,[helper,...process.argv.filter(v=>['--standby','--quick','--fast'].includes(v))],{encoding:'utf8',windowsHide:false,timeout:150000,maxBuffer:1024*1024});
  if(run.error)throw run.error;
  report.fixture=JSON.parse(run.stdout.trim());
  if(run.status!==0||report.fixture.error||report.fixture.results?.length!==13)throw Error(report.fixture.error||'原生夹具未完成');
  exitCode=report.fixture.results.every(r=>r.pass)?0:1;
}catch(error){report.error=error.message;}
report.exitCode=exitCode;fs.writeFileSync(path.join(dir,'evidence.json'),JSON.stringify(report,null,2));
for(const r of report.fixture?.results||[])console.log(`${r.pass?'通过':'失败'}：${r.name}`);
if(report.error)console.error(report.error);console.log(path.join(dir,'evidence.json'));process.exitCode=exitCode;
