export const builderStages = [
  {key:'understanding-request',label:'Understanding request'},
  {key:'loading-project-context',label:'Loading project context'},
  {key:'creating-plan',label:'Creating plan'},
  {key:'validating-schema',label:'Validating schema'},
  {key:'preparing-changes',label:'Preparing changes'},
  {key:'ready-for-approval',label:'Ready for approval'}
] as const;

export type BuilderStage=typeof builderStages[number]['key'];
export type StageState='idle'|'pending'|'active'|'complete'|'error'|'blocked';

export function stageKey(value:any):BuilderStage|undefined {
  const text=String(value?.key||value?.stage||value?.name||value||'').toLowerCase().replace(/[_ ]/g,'-');
  return builderStages.some(s=>s.key===text)?text as BuilderStage:undefined;
}

const completeStatuses=new Set(['complete','completed','done','success','successful']);
const activeStatuses=new Set(['running','in_progress','in-progress','active']);
const failedStatuses=new Set(['failed','error']);

function statusOf(stage:any){return String(stage?.status||stage?.state||'').toLowerCase().replace(/ /g,'_');}

export function stageState(stage:{key:BuilderStage}, index:number, response:any, loading:boolean, failed:boolean):StageState {
  const reported=Array.isArray(response?.stages)?response.stages:[];
  const entries=reported.map((item:any)=>({item,key:stageKey(item),status:statusOf(item)})).filter((entry:any)=>entry.key);
  const exact=entries.find((entry:any)=>entry.key===stage.key);
  const reportedIndex=entries.findIndex((entry:any)=>entry.key===stage.key);

  if(!loading&&!failed&&response) return 'complete';

  if(failed){
    const failedEntry=entries.find((entry:any)=>failedStatuses.has(entry.status));
    const failedKey=stageKey(response?.stage)||failedEntry?.key;
    const failedIndex=builderStages.findIndex(item=>item.key===failedKey);
    const inferredIndex=failedIndex>=0?failedIndex:(entries.find((entry:any)=>!completeStatuses.has(entry.status))?.key
      ?builderStages.findIndex(item=>item.key===entries.find((entry:any)=>!completeStatuses.has(entry.status))!.key):0);
    if(index<inferredIndex) return 'complete';
    if(index===inferredIndex) return 'error';
    return 'blocked';
  }

  if(loading){
    const running=entries.find((entry:any)=>activeStatuses.has(entry.status));
    const explicitIndex=running?builderStages.findIndex(item=>item.key===running.key):-1;
    const lastReported=entries.length?builderStages.findIndex(item=>item.key===entries[entries.length-1].key):-1;
    const activeIndex=explicitIndex>=0?explicitIndex:lastReported>=0 && completeStatuses.has(entries[entries.length-1].status)?lastReported+1:lastReported>=0?lastReported:0;
    if(index<activeIndex) return 'complete';
    if(index===activeIndex) return 'active';
    return 'pending';
  }

  if(exact&&completeStatuses.has(exact.status)) return 'complete';
  if(reportedIndex>=0&&reportedIndex<entries.length-1) return 'complete';
  return index===0?'idle':'pending';
}
