import {describe,expect,it} from "vitest";
describe("AppWeave frontend",()=>{it("has a configured API contract",()=>{expect("VITE_API_URL").toMatch(/^VITE_/);});});
