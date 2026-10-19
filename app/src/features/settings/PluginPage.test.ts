import { describe, expect, it } from "vitest";

import { listItems } from "./PluginPage";

describe("listItems", () => {
  it("keeps stable edit identities but rejects unbounded fixed arguments",()=>{
    const row={label:"Note",detail:"Original",edit:{tool:"notes_edit",label:"Edit",matchParameter:"text",valueParameter:"replacement",args:{id:2}}};
    expect(listItems({items:[row]},new Set(["notes_edit"]))[0].edit?.args).toEqual({id:2});
    expect(listItems({items:[{...row,edit:{...row.edit,args:{payload:"x".repeat(8193)}}}]},new Set(["notes_edit"]))[0].edit).toBeUndefined();
  });
  it("bounds list rendering work and rejects oversized display fields", () => {
    expect(listItems({items:Array.from({length:1000},()=>({label:"Review"}))})).toHaveLength(64);
    expect(listItems({items:[{label:"x".repeat(401)},{label:"Review",detail:"x".repeat(8001)}]})).toEqual([]);
  });
  it("keeps labelled rows and their actions", () => {
    const rows = listItems({
      items: [
        {
          label: "Ordinary",
          detail: "Alex Warren · 18:18",
          action: { label: "Play", tool: "history_replay", args: { index: 0 } },
        },
        { label: "Timeless" },
      ],
    });
    expect(rows).toEqual([
      {
        label: "Ordinary",
        detail: "Alex Warren · 18:18",
        action: { label: "Play", tool: "history_replay", args: { index: 0 } },
        image: null,
      },
      { label: "Timeless", detail: null, action: null, image: null },
    ]);
  });

  it("drops what a plugin got wrong instead of rendering it", () => {
    expect(listItems(null)).toEqual([]);
    expect(listItems({ items: "nope" })).toEqual([]);
    const rows = listItems({
      items: [{ detail: "no label" }, { label: "  " }, 7, { label: "ok", action: { label: "x" } }],
    });
    expect(rows).toEqual([{ label: "ok", detail: null, action: null, image: null }]);
  });

  it("keeps a row's picture only when it names a file and a type", () => {
    const rows = listItems({
      items: [
        { label: "a red fox", image: { file: "img/1.b64", mime: "image/png" } },
        { label: "broken", image: { file: 7 } },
      ],
    });
    expect(rows.map((row) => row.image)).toEqual([{ file: "img/1.b64", mime: "image/png" }, null]);
  });

  it("drops dynamic actions whose tools are not owned by the list's plugin",()=>{
    const rows=listItems({items:[{label:"Review",detail:"ciao",action:{label:"Run",tool:"foreign"},
      edit:{label:"Edit",tool:"owned_edit",matchParameter:"old",valueParameter:"new"},
      deleteAction:{label:"Delete",tool:"foreign_delete",args:{id:1}}}]},new Set(["owned_edit"]));
    expect(rows[0]).toMatchObject({action:null,edit:{tool:"owned_edit"}});
    expect(rows[0].deleteAction).toBeUndefined();
  });
});
