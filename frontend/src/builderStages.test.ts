import {describe,expect,it} from 'vitest';
import {builderStages,stageState} from './builderStages';

describe('AI builder stage classification',()=>{
  it('keeps exactly one stage active while a request is loading',()=>{
    const states=builderStages.map((stage,index)=>stageState(stage,index,undefined,true,false));
    expect(states).toEqual(['active','pending','pending','pending','pending','pending']);
  });

  it('completes earlier stages and advances the active stage from progress',()=>{
    const response={stages:[
      {key:'understanding-request',status:'complete'},
      {key:'loading-project-context',status:'running'}
    ]};
    const states=builderStages.map((stage,index)=>stageState(stage,index,response,true,false));
    expect(states).toEqual(['complete','active','pending','pending','pending','pending']);
  });

  it('marks a failed stage as error and later stages blocked',()=>{
    const error={stage:'validating-schema',stages:[
      {key:'understanding-request',status:'complete'},
      {key:'loading-project-context',status:'complete'},
      {key:'creating-plan',status:'complete'},
      {key:'validating-schema',status:'failed'}
    ]};
    const states=builderStages.map((stage,index)=>stageState(stage,index,error,false,true));
    expect(states).toEqual(['complete','complete','complete','error','blocked','blocked']);
  });

  it('marks every stage complete after a successful response',()=>{
    expect(builderStages.map((stage,index)=>stageState(stage,index,{output:'ready'},false,false)))
      .toEqual(['complete','complete','complete','complete','complete','complete']);
  });
});
