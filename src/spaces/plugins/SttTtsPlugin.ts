// src/plugins/SttTtsPlugin.ts

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Plugin, AudioDataWithUser } from '../types';
import { Space } from '../core/Space';
// import { JanusClient } from '../core/JanusClient';

interface PluginConfig {
  openAiApiKey?: string; // for STT & ChatGPT
  elevenLabsApiKey?: string; // for TTS
  sttLanguage?: string; // e.g. "en" for Whisper
  gptModel?: string; // e.g. "gpt-3.5-turbo"
  silenceThreshold?: number; // amplitude threshold for ignoring silence
  voiceId?: string; // specify which ElevenLabs voice to use
  elevenLabsModel?: string; // e.g. "eleven_monolingual_v1"
  systemPrompt?: string; // ex. "You are a helpful AI assistant"
  chatContext?: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
}

/**
 * MVP plugin for speech-to-text (OpenAI) + conversation + TTS (ElevenLabs)
 * Approach:
 *   - Collect each speaker's unmuted PCM in a memory buffer (only if above silence threshold)
 *   - On speaker mute -> flush STT -> GPT -> TTS -> push to Janus
 */
export class SttTtsPlugin implements Plugin {
  private space?: Space;
  // private janus?: JanusClient;

  // OpenAI + ElevenLabs
  private openAiApiKey?: string;
  private elevenLabsApiKey?: string;

  private sttLanguage = 'en';
  private gptModel = 'gpt-3.5-turbo';
  private voiceId = '21m00Tcm4TlvDq8ikWAM';
  private elevenLabsModel = 'eleven_monolingual_v1';

  private systemPrompt = 'You are a helpful AI assistant.';
  private chatContext: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> = [];

  /**
   * userId => arrayOfChunks (PCM Int16)
   */
  private pcmBuffers = new Map<string, Int16Array[]>();

  /**
   * Track mute states: userId => boolean (true=unmuted)
   */
  private speakerUnmuted = new Map<string, boolean>();

  /**
   * For ignoring near-silence frames (if amplitude < threshold)
   */
  private silenceThreshold = 50; // default amplitude threshold

  onAttach(space: Space) {
    console.log('[SttTtsPlugin] onAttach => space was attached');
  }

  init(params: { space: Space; pluginConfig?: Record<string, any> }): void {
    console.log(
      '[SttTtsPlugin] init => Space fully ready. Subscribing to events.',
    );

    this.space = params.space;
    // this.janus = (this.space as any)?.janusClient as JanusClient | undefined;

    const config = params.pluginConfig as PluginConfig;
    this.openAiApiKey = config?.openAiApiKey;
    this.elevenLabsApiKey = config?.elevenLabsApiKey;
    if (config?.sttLanguage) this.sttLanguage = config.sttLanguage;
    if (config?.gptModel) this.gptModel = config.gptModel;
    if (typeof config?.silenceThreshold === 'number') {
      this.silenceThreshold = config.silenceThreshold;
    }
    if (config?.voiceId) {
      this.voiceId = config.voiceId;
    }
    if (config?.elevenLabsModel) {
      this.voiceId = config.elevenLabsModel;
    }

    if (config.systemPrompt) {
      this.systemPrompt = config.systemPrompt;
    }
    if (config.chatContext) {
      this.chatContext = config.chatContext;
    }
    console.log('[SttTtsPlugin] Plugin config =>', config);

    // Listen for mute state changes to trigger STT flush
    this.space.on(
      'muteStateChanged',
      (evt: { userId: string; muted: boolean }) => {
        console.log('[SttTtsPlugin] Speaker muteStateChanged =>', evt);
        if (evt.muted) {
          // speaker just got muted => flush STT
          this.handleMute(evt.userId).catch((err) =>
            console.error('[SttTtsPlugin] handleMute error =>', err),
          );
        } else {
          // unmuted => start buffering
          this.speakerUnmuted.set(evt.userId, true);
          if (!this.pcmBuffers.has(evt.userId)) {
            this.pcmBuffers.set(evt.userId, []);
          }
        }
      },
    );
  }

  /**
   * Called whenever we receive PCM from a speaker
   */
  onAudioData(data: AudioDataWithUser): void {
    // Skip if speaker is muted or not tracked
    if (!this.speakerUnmuted.get(data.userId)) return;

    // Optional: detect silence
    let maxVal = 0;
    for (let i = 0; i < data.samples.length; i++) {
      const val = Math.abs(data.samples[i]);
      if (val > maxVal) maxVal = val;
    }
    if (maxVal < this.silenceThreshold) {
      // It's near-silence => skip
      return;
    }

    // Add chunk
    let arr = this.pcmBuffers.get(data.userId);
    if (!arr) {
      arr = [];
      this.pcmBuffers.set(data.userId, arr);
    }
    arr.push(data.samples);
  }

  /**
   * On speaker mute => flush STT => GPT => TTS => push to Janus
   */
  private async handleMute(userId: string): Promise<void> {
    this.speakerUnmuted.set(userId, false);
    const chunks = this.pcmBuffers.get(userId) || [];
    this.pcmBuffers.set(userId, []); // reset

    if (!chunks.length) {
      console.log('[SttTtsPlugin] No audio chunks for user =>', userId);
      return;
    }
    console.log(
      `[SttTtsPlugin] Flushing STT buffer for user=${userId}, total chunks=${chunks.length}`,
    );

    // 1) Merge chunks
    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Int16Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    // 2) Convert PCM -> WAV (48kHz) for STT
    const wavPath = await this.convertPcmToWav(merged, 48000);
    console.log('[SttTtsPlugin] WAV ready =>', wavPath);

    // 3) STT with OpenAI Whisper
    const sttText = await this.transcribeWithOpenAI(wavPath, this.sttLanguage);
    fs.unlinkSync(wavPath);
    if (!sttText.trim()) {
      console.log('[SttTtsPlugin] No speech recognized for user =>', userId);
      return;
    }
    console.log(`[SttTtsPlugin] STT => user=${userId}, text="${sttText}"`);

    // 4) GPT
    const replyText = await this.askChatGPT(sttText);
    console.log(`[SttTtsPlugin] GPT => user=${userId}, reply="${replyText}"`);

    // 5) TTS => returns MP3
    const ttsAudio = await this.elevenLabsTts(replyText);
    console.log('[SttTtsPlugin] TTS => got MP3 size=', ttsAudio.length);

    // 6) Convert MP3 -> PCM (48kHz, mono)
    const pcm = await this.convertMp3ToPcm(ttsAudio, 48000);
    console.log(
      '[SttTtsPlugin] TTS => converted to PCM => frames=',
      pcm.length,
    );

    // 7) Push frames to Janus
    // if (this.janus) {
    //   await this.streamToJanus(pcm, 48000);
    //   console.log('[SttTtsPlugin] TTS => done streaming to space');
    // }
  }

  /**
   * Convert Int16 PCM -> WAV using ffmpeg
   */
  private convertPcmToWav(
    samples: Int16Array,
    sampleRate: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const tmpPath = path.resolve('/tmp', `stt-${Date.now()}.wav`);
      const ff = spawn('ffmpeg', [
        '-f',
        's16le',
        '-ar',
        sampleRate.toString(),
        '-ac',
        '1',
        '-i',
        'pipe:0',
        '-y',
        tmpPath,
      ]);
      ff.stdin.write(Buffer.from(samples.buffer));
      ff.stdin.end();
      ff.on('close', (code) => {
        if (code === 0) resolve(tmpPath);
        else reject(new Error(`ffmpeg error code=${code}`));
      });
    });
  }

  /**
   * OpenAI Whisper STT
   */
  private async transcribeWithOpenAI(wavPath: string, language: string) {
    if (!this.openAiApiKey) {
      throw new Error('[SttTtsPlugin] No OpenAI API key available');
    }

    try {
      console.log('[SttTtsPlugin] Transcribe =>', wavPath);

      // Read file into buffer
      const fileBuffer = fs.readFileSync(wavPath);
      console.log(
        '[SttTtsPlugin] File read, size:',
        fileBuffer.length,
        'bytes',
      );

      // Create blob from buffer
      const blob = new Blob([fileBuffer], { type: 'audio/wav' });

      // Create FormData
      const formData = new FormData();
      formData.append('file', blob, path.basename(wavPath));
      formData.append('model', 'whisper-1');
      formData.append('language', language);
      formData.append('temperature', '0');

      // Call OpenAI API
      const response = await fetch(
        'https://api.openai.com/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.openAiApiKey}`,
          },
          body: formData,
        },
      );

      // Handle errors
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[SttTtsPlugin] API Error:', errorText);
        throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
      }

      // Parse response
      const data = (await response.json()) as { text: string };
      const text = data.text?.trim() || '';
      console.log('[SttTtsPlugin] Transcription =>', text);
      return text;
    } catch (err) {
      console.error('[SttTtsPlugin] OpenAI STT Error =>', err);
      throw new Error('OpenAI STT failed');
    }
  }

  /**
   * Simple ChatGPT call
   */
  private async askChatGPT(userText: string): Promise<string> {
    if (!this.openAiApiKey) {
      throw new Error('[SttTtsPlugin] No OpenAI API key for ChatGPT');
    }
    const url = 'https://api.openai.com/v1/chat/completions';

    // Build the final array of messages
    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...this.chatContext,
      { role: 'user', content: userText },
    ];

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.gptModel,
        messages,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(
        `[SttTtsPlugin] ChatGPT error => ${resp.status} ${errText}`,
      );
    }

    const json = await resp.json();
    const reply = json.choices?.[0]?.message?.content || '';

    // Optionally store the conversation in the chatContext
    this.chatContext.push({ role: 'user', content: userText });
    this.chatContext.push({ role: 'assistant', content: reply });

    return reply.trim();
  }

  /**
   * ElevenLabs TTS => returns MP3 Buffer
   */
  private async elevenLabsTts(text: string): Promise<Buffer> {
    if (!this.elevenLabsApiKey) {
      throw new Error('[SttTtsPlugin] No ElevenLabs API key');
    }
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey,
      },
      body: JSON.stringify({
        text,
        model_id: this.elevenLabsModel,
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(
        `[SttTtsPlugin] ElevenLabs TTS error => ${resp.status} ${errText}`,
      );
    }
    const arrayBuf = await resp.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  /**
   * Convert MP3 => PCM via ffmpeg
   */
  private convertMp3ToPcm(
    mp3Buf: Buffer,
    outRate: number,
  ): Promise<Int16Array> {
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ar',
        outRate.toString(),
        '-ac',
        '1',
        'pipe:1',
      ]);
      let raw = Buffer.alloc(0);
      ff.stdout.on('data', (chunk: Buffer) => {
        raw = Buffer.concat([raw, chunk]);
      });
      ff.stderr.on('data', () => {
        /* ignore ffmpeg logs */
      });
      ff.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg error code=${code}`));
          return;
        }
        const samples = new Int16Array(
          raw.buffer,
          raw.byteOffset,
          raw.byteLength / 2,
        );
        resolve(samples);
      });
      ff.stdin.write(mp3Buf);
      ff.stdin.end();
    });
  }

  /**
   * Push PCM back to Janus in small frames
   * We'll do 10ms @48k => 960 samples per frame
   */
  private async streamToJanus(
    samples: Int16Array,
    sampleRate: number,
  ): Promise<void> {
    // 10 ms => 480 samples @48k
    const FRAME_SIZE = 480;

    for (
      let offset = 0;
      offset + FRAME_SIZE <= samples.length;
      offset += FRAME_SIZE
    ) {
      // Option 1: subarray + .set
      const frame = new Int16Array(FRAME_SIZE);
      frame.set(samples.subarray(offset, offset + FRAME_SIZE));

      // this.janus?.pushLocalAudio(frame, sampleRate, 1);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  public async speakText(text: string): Promise<void> {
    // 1) TTS => MP3
    const ttsAudio = await this.elevenLabsTts(text);

    // 2) Convert MP3 -> PCM
    const pcm = await this.convertMp3ToPcm(ttsAudio, 48000);

    // 3) Stream to Janus
    // if (this.janus) {
    //   await this.streamToJanus(pcm, 48000);
    //   console.log('[SttTtsPlugin] speakText => done streaming to space');
    // }
  }

  /**
   * Change the system prompt at runtime.
   */
  public setSystemPrompt(prompt: string) {
    this.systemPrompt = prompt;
    console.log('[SttTtsPlugin] setSystemPrompt =>', prompt);
  }

  /**
   * Change the GPT model at runtime (e.g. "gpt-4", "gpt-3.5-turbo", etc.).
   */
  public setGptModel(model: string) {
    this.gptModel = model;
    console.log('[SttTtsPlugin] setGptModel =>', model);
  }

  /**
   * Add a message (system, user or assistant) to the chat context.
   * E.g. to store conversation history or inject a persona.
   */
  public addMessage(role: 'system' | 'user' | 'assistant', content: string) {
    this.chatContext.push({ role, content });
    console.log(
      `[SttTtsPlugin] addMessage => role=${role}, content=${content}`,
    );
  }

  /**
   * Clear the chat context if needed.
   */
  public clearChatContext() {
    this.chatContext = [];
    console.log('[SttTtsPlugin] clearChatContext => done');
  }

  cleanup(): void {
    console.log('[SttTtsPlugin] cleanup => releasing resources');
    this.pcmBuffers.clear();
    this.speakerUnmuted.clear();
  }
}
