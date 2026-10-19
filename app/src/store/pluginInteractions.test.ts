import { expect, it, vi } from "vitest";
import { submitInteractionQuestion, type QuestionSubmissionHost } from "./pluginInteractions";

function fixture() {
  const submit = vi.fn(() => true);
  const publish = vi.fn(async () => {});
  const host: QuestionSubmissionHost = {submit,publish,now:() => 1000};
  const event = {source:"host",topic:"interaction.requested",payload:{id:"question",deliveryId:"attempt",sessionId:"voice",prompt:"How many minutes?",expiresAt:2000}};
  return {host,event,submit,publish};
}
it("reports adapter submission with correlated ids without claiming spoken delivery", async () => {
  const {host,event,submit,publish} = fixture();
  await submitInteractionQuestion(host,event);
  expect(submit).toHaveBeenCalledWith("voice","How many minutes?");
  expect(publish).toHaveBeenCalledWith("interaction.delivery",{id:"question",deliveryId:"attempt",sessionId:"voice",status:"submitted"});
});
it("ignores forged, expired or invalid questions and reports missing channels or submission failure", async () => {
  const {host,event,submit,publish} = fixture();
  await submitInteractionQuestion(host,{...event,source:"plugin"});
  await submitInteractionQuestion(host,{...event,payload:{...event.payload,expiresAt:900}});
  await submitInteractionQuestion(host,{...event,payload:{...event.payload,prompt:"x".repeat(2001)}});
  expect(submit).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  submit.mockReturnValue(false);
  await submitInteractionQuestion(host,event);
  expect(publish).toHaveBeenLastCalledWith("interaction.delivery",expect.objectContaining({status:"unsupported"}));
  submit.mockImplementation(() => { throw new Error("Adapter failed"); });
  await submitInteractionQuestion(host,event);
  expect(publish).toHaveBeenLastCalledWith("interaction.delivery",expect.objectContaining({status:"failed"}));
});
