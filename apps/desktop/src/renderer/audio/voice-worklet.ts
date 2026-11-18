import { VOICE_PROCESSOR, VoiceChain, type ChainSettings } from './voice-chain';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class VoiceChainProcessor extends AudioWorkletProcessor {
  private chain: VoiceChain | null = null;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ChainSettings>) => {
      if (this.chain) this.chain.configure(e.data);
      else this.chain = new VoiceChain(e.data, sampleRate);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = (outputs[0] ?? []).slice(0, input.length);
    output.forEach((out, c) => out.set(input[c]!));
    if (output.length > 0) this.chain?.process(output);
    return true;
  }
}

registerProcessor(VOICE_PROCESSOR, VoiceChainProcessor);
