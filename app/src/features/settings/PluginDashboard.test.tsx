import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dashboardData, PluginDashboard } from "./PluginDashboard";

const dashboard = () => ({
  hero: {label:"Next-level task coverage",value:30,detail:"Provisional evidence"},
  metrics:[{label:"Words",value:"8",detail:"Practiced today"}],
  skills:[{label:"Pronunciation",value:null,detail:"Not assessed yet"},{label:"Conversation",value:30,detail:"Two observations"}],
  series:[{label:"Daily practice",kind:"bars",max:10,points:[{label:"2026-10-07",value:5,detail:"Recorded practice"}]}],
  highlights:[{label:"Next step",detail:"Recall before seeing the answer"}],
});

describe("declarative plugin dashboards", () => {
  it("rejects malformed hero values and filters unsafe or oversized chart data", () => {
    expect(dashboardData(null)).toBeNull();
    expect(dashboardData({...dashboard(),hero:{label:"Test",value:NaN,detail:"Test"}})).toBeNull();
    const result=dashboardData({...dashboard(),skills:[{label:"Bad",value:Infinity,detail:"Bad"}],series:[
      {label:"Invalid",kind:"html",max:100,points:[]},
      {label:"Zero",kind:"bars",max:0,points:[]},
      {label:"Valid",kind:"line",max:100,points:[{label:"Day",value:101,detail:"Bad"},{label:"Day",value:2,detail:"Good"}]},
    ]});
    expect(result?.skills).toEqual([]);
    expect(result?.series).toHaveLength(1);
    expect(result?.series[0].points).toHaveLength(1);
    const many={...dashboard(),series:[{...dashboard().series[0],points:Array.from({length:1000},()=>dashboard().series[0].points[0])}]};
    expect(dashboardData(many)?.series[0].points).toHaveLength(60);
  });

  it("renders unknown skills without claiming zero and exposes chart values accessibly", () => {
    const html=renderToStaticMarkup(<PluginDashboard value={dashboard()}/>);
    expect(html).toContain("30%");
    expect(html).toContain("Not assessed yet");
    expect(html).not.toContain('aria-valuenow="0"');
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain("<table>");
    expect(html).toContain("2026-10-07");
  });

  it("escapes plugin text and translates presentation without modifying data", () => {
    const value={...dashboard(),metrics:[{label:"<script>alert(1)</script>",value:"2",detail:"safe"}]};
    const before=JSON.stringify(value);
    const html=renderToStaticMarkup(<PluginDashboard value={value} translate={(text)=>text==="Not assessed yet"?"Ainda não avaliado":text}/>);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Ainda não avaliado");
    expect(JSON.stringify(value)).toBe(before);
  });
});
