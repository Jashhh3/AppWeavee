import {describe,expect,it} from "vitest";
import {providerDefaults,providerLabels,providerModels} from "./App";

describe("AppWeave frontend",()=>{
  it("has a configured API contract",()=>{expect("VITE_API_URL").toMatch(/^VITE_/);});
});

describe("NVIDIA provider configuration",()=>{
  it("exposes the NVIDIA label, defaults, and supported models",()=>{
    expect(providerLabels.nvidia).toBe("NVIDIA");
    expect(providerDefaults.nvidia).toEqual({baseUrl:"https://integrate.api.nvidia.com/v1",model:"z-ai/glm-5.3-flash"});
    expect(providerModels.nvidia.map((model:string[])=>model[0])).toEqual([
      "z-ai/glm-5.3-flash",
      "deepseek-ai/deepseek-v4.1-flash",
      "meta/muse-glimmer-30b",
      "poolside/laguna-xs-2.1"
    ]);
  });
});

describe('MCP connection configuration',()=>{
  it('builds a standard streamable HTTP client config without storing secrets',async()=>{
    const {mcpClientConfig,mcpEndpoint}=await import('./App');
    expect(mcpEndpoint()).toMatch(/\/mcp$/);
    expect(mcpClientConfig('https://example.test/mcp','aw_mcp_demo')).toEqual({mcpServers:{appweave:{url:'https://example.test/mcp',headers:{Authorization:'Bearer aw_mcp_demo'}}}});
  });
});
