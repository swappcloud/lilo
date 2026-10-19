import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  listeners: new Map<string, (event: {payload: unknown}) => void>(),
  microphone:vi.fn(), trackStop:vi.fn(), sendFrame:vi.fn(), peerClose:vi.fn(), invoke: vi.fn(), close: vi.fn(), play: vi.fn(), open: vi.fn(), stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({invoke:fixture.invoke}));
vi.mock("@tauri-apps/api/event", () => ({listen:vi.fn(async (topic:string, cb:(event:{payload:unknown})=>void) => {
  fixture.listeners.set(topic,cb); return () => {fixture.listeners.delete(topic);};
})}));
vi.mock("../shared/pcmAudio", () => ({PcmAudio: class {
  levels=()=>({mic:0,output:0});
  open=fixture.open; close=fixture.close; play=fixture.play; stopPlayback=fixture.stop;
  setOutputDevice=vi.fn().mockResolvedValue(undefined);
},pcm16ToBase64:()=>"AQACAA=="}));
vi.mock("../../shared/lib/microphone", () => ({getMicrophone:fixture.microphone}));
import { PluginVoiceTransport } from "./transport";

beforeEach(() => {
  vi.clearAllMocks(); fixture.listeners.clear(); fixture.invoke.mockResolvedValue({});
  fixture.open.mockResolvedValue(undefined); fixture.close.mockResolvedValue(undefined);
});
afterEach(()=>vi.unstubAllGlobals());
describe("private plugin voice lifecycle", () => {
  it("rejects foreign captions and releases media and subscriptions on disconnect", async () => {
    const transport = new PluginVoiceTransport("com.fixture.voice", {id:"voice",label:"Fixture",transport:{kind:"pcm"}}, {});
    expect(transport.supportsNativeAudio).toBe(true);
    const caption=vi.fn(); transport.onCaption(caption);
    await transport.connect({settings:{}});
    const receive=fixture.listeners.get("lilo://plugin-voice")!;
    const payload={pluginId:"foreign",providerId:"voice",sessionId:transport.getSessionId(),closed:false,
      events:[{type:"caption",id:"turn",speaker:"assistant",text:"Hello",final:true}]};
    receive({payload}); expect(caption).not.toHaveBeenCalled();
    receive({payload:{...payload,pluginId:"com.fixture.voice"}});
    expect(caption).toHaveBeenCalledWith(expect.objectContaining({id:"turn",text:"Hello",final:true}));
    await transport.disconnect();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.listeners.size).toBe(0);
    expect(transport.getSessionId()).toBeUndefined();
    expect(fixture.invoke).toHaveBeenLastCalledWith("plugin_voice_call", expect.objectContaining({request:expect.objectContaining({operation:"disconnect"})}));
  });
  it("prepares playback before a provider sends its first audio", async () => {
    fixture.invoke.mockImplementation((_command:string, args:{request:{operation:string;sessionId:string}}) => {
      if (args.request.operation === "connect") fixture.listeners.get("lilo://plugin-voice")?.({payload:{
        pluginId:"com.fixture.voice", providerId:"voice", sessionId:args.request.sessionId, closed:false,
        events:[{type:"audio",audio:"AQACAA=="}],
      }});
      return Promise.resolve({});
    });
    const transport = new PluginVoiceTransport("com.fixture.voice", {id:"voice",label:"Fixture",transport:{kind:"pcm"}}, {});
    await transport.connect({settings:{}});
    expect(fixture.play).toHaveBeenCalledWith("AQACAA==", undefined, 24000);
    await transport.disconnect();
  });
  it("cleans up after a microphone permission failure", async () => {
    fixture.open.mockRejectedValue(new Error("Microphone denied"));
    const transport = new PluginVoiceTransport("com.fixture.voice", {id:"voice",label:"Fixture",transport:{kind:"pcm"}}, {});
    await expect(transport.connect({settings:{}})).rejects.toThrow("Microphone denied");
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.listeners.size).toBe(0);
  });
  it("ignores a late connection after cancellation", async () => {
    let resolve!: (result:Record<string,unknown>)=>void;
    fixture.invoke.mockImplementation((_command:string,args:{request:{operation:string}}) => args.request.operation === "connect"
      ? new Promise(done => {resolve=done;}) : Promise.resolve({}));
    const transport = new PluginVoiceTransport("com.fixture.voice", {id:"voice",label:"Fixture",transport:{kind:"pcm"}}, {});
    const connect=transport.connect({settings:{}});
    await vi.waitFor(()=>expect(resolve).toBeTypeOf("function"));
    await transport.disconnect(); resolve({}); await connect;
    expect(fixture.listeners.size).toBe(0);
    expect(transport.getSessionId()).toBeUndefined();
  });
  it("queues early WebRTC frames and releases its microphone on removal", async () => {
    const track={enabled:true,stop:fixture.trackStop};
    fixture.microphone.mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]});
    const channel={label:"oai-events",readyState:"connecting",bufferedAmount:0,send:fixture.sendFrame,
      onopen:null as null|(()=>void),onclose:null as null|(()=>void),onmessage:null,close:vi.fn()};
    vi.stubGlobal("AudioContext",class {resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);
      createAnalyser=()=>({fftSize:256,getFloatTimeDomainData:vi.fn()});createMediaStreamSource=()=>({connect:vi.fn()});});
    vi.stubGlobal("Audio",class {autoplay=false;pause=vi.fn();srcObject=null;setSinkId=vi.fn().mockResolvedValue(undefined);});
    vi.stubGlobal("RTCPeerConnection",class {
      localDescription={sdp:"v=0\r\n"};ontrack=null;onconnectionstatechange=null;close=fixture.peerClose;
      addTrack=vi.fn();createDataChannel=()=>channel;createOffer=async()=>({type:"offer",sdp:"v=0\r\n"});
      setLocalDescription=async()=>{};setRemoteDescription=async()=>{channel.readyState="open";channel.onopen?.();};
    });
    fixture.invoke.mockImplementation((_command:string,args:{request:{operation:string;sessionId:string}})=>{
      if(args.request.operation==="connect") fixture.listeners.get("lilo://plugin-voice")?.({payload:{
        pluginId:"com.fixture.voice",providerId:"voice",sessionId:args.request.sessionId,closed:false,
        events:[{type:"frames",frames:[{type:"session.update"}]}],
      }});
      return Promise.resolve({sdp:"v=0\r\n"});
    });
    const transport=new PluginVoiceTransport("com.fixture.voice",{id:"voice",label:"Fixture",transport:{kind:"webrtc"}},{});
    await transport.connect({settings:{}});
    expect(fixture.sendFrame).toHaveBeenCalledWith(JSON.stringify({type:"session.update"}));
    transport.setMuted(true);expect(track.enabled).toBe(false);
    transport.setMuted(false);transport.setBargeIn(false,0.6);
    fixture.listeners.get("lilo://plugin-voice")?.({payload:{pluginId:"com.fixture.voice",providerId:"voice",sessionId:transport.getSessionId(),closed:false,events:[{type:"response_started"}]}});
    expect(track.enabled).toBe(false);
    fixture.listeners.get("lilo://plugin-voice")?.({payload:{pluginId:"com.fixture.voice",providerId:"voice",sessionId:transport.getSessionId(),closed:false,events:[{type:"state",state:"connected"}]}});
    expect(track.enabled).toBe(true);
    await transport.disconnect();expect(fixture.trackStop).toHaveBeenCalledOnce();expect(fixture.peerClose).toHaveBeenCalledOnce();
  });
  it("does not disconnect a new session when an old text request fails late", async () => {
    let reject!: (error:unknown)=>void;
    fixture.invoke.mockImplementation((_command:string,args:{request:{operation:string}})=>args.request.operation==="text"
      ? new Promise((_resolve,fail)=>{reject=fail;}) : Promise.resolve({}));
    const transport=new PluginVoiceTransport("com.fixture.voice",{id:"voice",label:"Fixture",transport:{kind:"pcm"}},{});
    const error=vi.fn();transport.onError(error);
    await transport.connect({settings:{}});transport.sendText("Hello");
    await transport.disconnect();await transport.connect({settings:{}});
    const session=transport.getSessionId();reject(new Error("Old request failed"));await Promise.resolve();await Promise.resolve();
    expect(error).not.toHaveBeenCalled();expect(transport.getSessionId()).toBe(session);
    await transport.disconnect();
  });

  it("binds the declared remote channel and flushes frames when it arrives already open", async () => {
    const track = {enabled:true,stop:fixture.trackStop};
    fixture.microphone.mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]});
    const foreign = {label:"foreign",close:vi.fn()};
    const remote = {label:"txt",readyState:"open",bufferedAmount:0,send:fixture.sendFrame,onopen:null,onclose:null,onmessage:null,close:vi.fn()};
    const negotiation = {close:vi.fn()};
    const createChannel = vi.fn().mockReturnValue(negotiation);
    vi.stubGlobal("AudioContext",class {
      resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);
      createAnalyser=()=>({fftSize:256,getFloatTimeDomainData:vi.fn()});createMediaStreamSource=()=>({connect:vi.fn()});
    });
    vi.stubGlobal("Audio",class {autoplay=false;pause=vi.fn();srcObject=null;});
    vi.stubGlobal("RTCPeerConnection",class {
      localDescription={sdp:"v=0\r\n"};ontrack=null;onconnectionstatechange=null;
      ondatachannel: null | ((event:{channel:unknown})=>void)=null;
      close=fixture.peerClose;addTrack=vi.fn();createDataChannel=createChannel;
      createOffer=async()=>({type:"offer",sdp:"v=0\r\n"});setLocalDescription=async()=>{};
      setRemoteDescription=async()=>{this.ondatachannel?.({channel:foreign});this.ondatachannel?.({channel:remote});};
    });
    fixture.invoke.mockImplementation((_command:string,args:{request:{operation:string;sessionId:string}})=>{
      if(args.request.operation==="connect") fixture.listeners.get("lilo://plugin-voice")?.({payload:{
        pluginId:"com.fixture.voice",providerId:"voice",sessionId:args.request.sessionId,closed:false,
        events:[{type:"frames",frames:[{type:"session.update"}]}],
      }});
      return Promise.resolve({sdp:"v=0\r\n"});
    });
    const transport=new PluginVoiceTransport("com.fixture.voice",{id:"voice",label:"Fixture",transport:{kind:"webrtc",channelLabel:"txt",remoteChannel:true}},{});
    await transport.connect({settings:{}});
    expect(transport.supportsNativeAudio).toBe(false);
    expect(createChannel).toHaveBeenCalledExactlyOnceWith("lilo-negotiation");
    expect(foreign.close).toHaveBeenCalledOnce();
    expect(fixture.sendFrame).toHaveBeenCalledExactlyOnceWith(JSON.stringify({type:"session.update"}));
    await transport.disconnect();
    expect(negotiation.close).toHaveBeenCalledOnce();
    expect(remote.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
