import {describe,expect,it} from 'vitest';
import {classifyBuildStatus,isBuildTerminal,latestBuild} from './workspaceLifecycle';

describe('workspace build lifecycle',()=>{
  it('classifies backend build states and missing builds',()=>{
    expect(classifyBuildStatus(undefined,false)).toBe('unavailable');
    expect(classifyBuildStatus({status:'queued'})).toBe('initializing');
    expect(classifyBuildStatus({status:'building'})).toBe('building');
    expect(classifyBuildStatus({status:'active'})).toBe('ready');
    expect(classifyBuildStatus({status:'failed'})).toBe('failed');
  });

  it('sorts the latest build by version and recognizes terminal states',()=>{
    expect(latestBuild([{environment:'preview',version:1},{environment:'preview',version:3},{environment:'production',version:8}])).toEqual({environment:'preview',version:3});
    expect(isBuildTerminal({status:'active'})).toBe(true);
    expect(isBuildTerminal({status:'building'})).toBe(false);
  });
});
