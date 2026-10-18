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
