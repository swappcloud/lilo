import {describe,expect,it} from "vitest";
import {validPluginFormValues} from "./PluginPage";
import type {PluginFormField} from "../../types";

describe("declarative plugin form validation",()=>{
  const fields:PluginFormField[]=[
    {key:"minutes",label:"Minutes",kind:"number",required:true,min:5,max:120},
    {key:"note",label:"Note",kind:"text",maxLength:20},
    {key:"kind",label:"Kind",kind:"select",options:[{value:"goal",label:"Goal"}]},
  ];
  it("accepts declared values",()=>expect(validPluginFormValues(fields,{minutes:20,note:"Keep practicing",kind:"goal"})).toBe(true));
  it("rejects missing, out-of-range and undeclared values",()=>{
    expect(validPluginFormValues(fields,{note:"ok",kind:"goal"})).toBe(false);
    expect(validPluginFormValues(fields,{minutes:121,note:"ok",kind:"goal"})).toBe(false);
    expect(validPluginFormValues(fields,{minutes:20,note:"ok",kind:"injected"})).toBe(false);
    expect(validPluginFormValues(fields,{minutes:20,note:"x".repeat(21),kind:"goal"})).toBe(false);
  });
});
