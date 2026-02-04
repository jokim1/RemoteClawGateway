import type { IncomingMessage } from 'node:http';
import Busboy from 'busboy';

import type { HandlerContext, VoicePluginConfig } from './types.js';
import { sendJson, readJsonBody } from './http.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENAI_TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const CARTESIA_TTS_VOICES = ['sonic-english', 'sonic-multilingual'];
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_TEXT_LENGTH = 4096;

// Cartesia voice ID mappings (example voices)
const CARTESIA_VOICE_IDS: Record<string, string> = {
  'sonic-english': 'a0e99841-438c-4a64-b679-ae501e7d6091', // Example voice ID
  'sonic-multilingual': 'a0e99841-438c-4a64-b679-ae501e7d6091',
};

// ---------------------------------------------------------------------------
// Multipart parser
// ---------------------------------------------------------------------------

function parseMultipart(
  req: IncomingMessage,
  contentType: string,
): Promise<{ audioBuffer: Buffer; language: string }> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    });

    const chunks: Buffer[] = [];
    let lang = 'en';

    busboy.on('file', (_fieldname: string, stream: NodeJS.ReadableStream) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    });

    busboy.on('field', (fieldname: string, value: string) => {
      if (fieldname === 'language') lang = value;
    });

    busboy.on('finish', () => {
      resolve({ audioBuffer: Buffer.concat(chunks), language: lang });
    });
    busboy.on('error', (err: Error) => reject(err));

    req.pipe(busboy);
  });
}

// ---------------------------------------------------------------------------
// OpenAI STT / TTS
// ---------------------------------------------------------------------------

export async function transcribeViaOpenAI(
  audioBuffer: Buffer,
  language: string,
  model: string,
): Promise<{ text: string; language?: string; duration?: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const blob = new Blob([audioBuffer], { type: 'audio/wav' });
  const formData = new FormData();
  formData.append('file', blob, 'recording.wav');
  formData.append('model', model);
  formData.append('language', language);
  formData.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI STT error (${response.status}): ${body.slice(0, 200)}`);
  }

  return await response.json() as { text: string; language?: string; duration?: number };
}

export async function synthesizeViaOpenAI(
  text: string,
  voice: string,
  model: string,
  speed?: number,
): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const body: Record<string, unknown> = {
    model,
    input: text,
    voice,
    response_format: 'mp3',
  };
  if (speed !== undefined) body.speed = speed;

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenAI TTS error (${response.status}): ${errBody.slice(0, 200)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function synthesizeViaCartesia(
  text: string,
  voiceId: string,
  _model?: string,
): Promise<Buffer> {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) throw new Error('CARTESIA_API_KEY not set');

  // Map voice name to voice ID if needed
  const resolvedVoiceId = CARTESIA_VOICE_IDS[voiceId] || voiceId;

  const response = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Cartesia-Version': '2024-06-10',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: 'sonic-english',
      transcript: text,
      voice: {
        mode: 'id',
        id: resolvedVoiceId,
      },
      output_format: {
        container: 'mp3',
        encoding: 'mp3',
        sample_rate: 44100,
      },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Cartesia TTS error (${response.status}): ${errBody.slice(0, 200)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------------------------------------------------------------------------
// Voice availability helper
// ---------------------------------------------------------------------------

export function resolveVoiceAvailability(voiceCfg: VoicePluginConfig | undefined): {
  sttAvailable: boolean;
  ttsAvailable: boolean;
  ttsProvider: 'openai' | 'cartesia' | null;
} {
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
  const hasCartesiaKey = !!process.env.CARTESIA_API_KEY;

  // Determine TTS provider (prefer config, then Cartesia if available, then OpenAI)
  let ttsProvider: 'openai' | 'cartesia' | null = null;
  if (voiceCfg?.tts?.provider === 'cartesia' && hasCartesiaKey) {
    ttsProvider = 'cartesia';
  } else if (voiceCfg?.tts?.provider === 'openai' && hasOpenAIKey) {
    ttsProvider = 'openai';
  } else if (hasCartesiaKey) {
    ttsProvider = 'cartesia';
  } else if (hasOpenAIKey) {
    ttsProvider = 'openai';
  }

  return {
    sttAvailable: !!(voiceCfg?.stt?.provider || hasOpenAIKey),
    ttsAvailable: ttsProvider !== null,
    ttsProvider,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleVoiceCapabilities(ctx: HandlerContext): Promise<void> {
  if (ctx.req.method !== 'GET') {
    ctx.res.statusCode = 405;
    ctx.res.setHeader('Allow', 'GET, OPTIONS');
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.end('Method Not Allowed');
    return;
  }

  const voiceCfg = ctx.pluginCfg.voice;
  const { sttAvailable, ttsAvailable, ttsProvider } = resolveVoiceAvailability(voiceCfg);

  // Select voices based on provider
  const ttsVoices = ttsProvider === 'cartesia' ? CARTESIA_TTS_VOICES : OPENAI_TTS_VOICES;
  const defaultVoice = ttsProvider === 'cartesia'
    ? (voiceCfg?.tts?.defaultVoice ?? 'sonic-english')
    : (voiceCfg?.tts?.defaultVoice ?? 'nova');

  sendJson(ctx.res, 200, {
    stt: {
      available: sttAvailable,
      ...(sttAvailable && {
        provider: voiceCfg?.stt?.provider ?? 'openai',
        model: voiceCfg?.stt?.model ?? 'whisper-1',
        maxDurationSeconds: 120,
        maxFileSizeMB: 25,
      }),
    },
    tts: {
      available: ttsAvailable,
      ...(ttsAvailable && {
        provider: ttsProvider,
        model: voiceCfg?.tts?.model ?? (ttsProvider === 'cartesia' ? 'sonic-english' : 'tts-1'),
        voices: ttsVoices,
        defaultVoice,
      }),
    },
  });
}

export async function handleVoiceTranscribe(ctx: HandlerContext): Promise<void> {
  if (ctx.req.method !== 'POST') {
    ctx.res.statusCode = 405;
    ctx.res.setHeader('Allow', 'POST, OPTIONS');
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.end('Method Not Allowed');
    return;
  }

  const voiceCfg = ctx.pluginCfg.voice;
  const { sttAvailable } = resolveVoiceAvailability(voiceCfg);

  if (!sttAvailable) {
    sendJson(ctx.res, 503, { error: 'No STT provider configured' });
    return;
  }

  const contentType = (ctx.req.headers['content-type'] as string) ?? '';
  if (!contentType.includes('multipart/form-data')) {
    sendJson(ctx.res, 400, { error: 'Expected multipart/form-data' });
    return;
  }

  let parsed: { audioBuffer: Buffer; language: string };
  try {
    parsed = await parseMultipart(ctx.req, contentType);
  } catch (err) {
    ctx.logger.error(`RemoteClaw: multipart parse failed: ${err}`);
    sendJson(ctx.res, 400, { error: 'Failed to parse audio upload' });
    return;
  }

  if (parsed.audioBuffer.length < 100) {
    sendJson(ctx.res, 400, { error: 'No audio data received' });
    return;
  }

  if (parsed.audioBuffer.length > MAX_FILE_SIZE) {
    sendJson(ctx.res, 413, { error: 'Audio file too large (max 25MB)' });
    return;
  }

  try {
    const model = voiceCfg?.stt?.model ?? 'whisper-1';
    const result = await transcribeViaOpenAI(
      parsed.audioBuffer,
      parsed.language,
      model,
    );

    sendJson(ctx.res, 200, {
      text: result.text,
      language: result.language ?? parsed.language,
      duration: result.duration,
    });
  } catch (err) {
    ctx.logger.error(`RemoteClaw: STT failed: ${err}`);
    sendJson(ctx.res, 500, {
      error: err instanceof Error ? err.message : 'Transcription failed',
    });
  }
}

export async function handleVoiceSynthesize(ctx: HandlerContext): Promise<void> {
  if (ctx.req.method !== 'POST') {
    ctx.res.statusCode = 405;
    ctx.res.setHeader('Allow', 'POST, OPTIONS');
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.end('Method Not Allowed');
    return;
  }

  const voiceCfg = ctx.pluginCfg.voice;
  const { ttsAvailable, ttsProvider } = resolveVoiceAvailability(voiceCfg);

  if (!ttsAvailable || !ttsProvider) {
    sendJson(ctx.res, 503, { error: 'No TTS provider configured' });
    return;
  }

  let body: { text?: string; voice?: string; speed?: number };
  try {
    body = await readJsonBody(ctx.req) as { text?: string; voice?: string; speed?: number };
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.text || !body.text.trim()) {
    sendJson(ctx.res, 400, { error: 'Missing or empty text' });
    return;
  }

  if (body.text.length > MAX_TEXT_LENGTH) {
    sendJson(ctx.res, 413, { error: `Text too long (max ${MAX_TEXT_LENGTH} chars)` });
    return;
  }

  // Select voices based on provider
  const validVoices = ttsProvider === 'cartesia' ? CARTESIA_TTS_VOICES : OPENAI_TTS_VOICES;
  const defaultVoice = ttsProvider === 'cartesia' ? 'sonic-english' : 'nova';
  const voice = body.voice ?? voiceCfg?.tts?.defaultVoice ?? defaultVoice;

  // Validate voice against allowlist
  if (!validVoices.includes(voice)) {
    sendJson(ctx.res, 400, {
      error: `Invalid voice "${voice}". Valid voices: ${validVoices.join(', ')}`,
    });
    return;
  }

  const model = voiceCfg?.tts?.model ?? (ttsProvider === 'cartesia' ? 'sonic-english' : 'tts-1');

  try {
    let audioBuffer: Buffer;

    if (ttsProvider === 'cartesia') {
      audioBuffer = await synthesizeViaCartesia(body.text, voice, model);
    } else {
      audioBuffer = await synthesizeViaOpenAI(body.text, voice, model, body.speed);
    }

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'audio/mpeg');
    ctx.res.setHeader('Content-Length', audioBuffer.length);
    ctx.res.setHeader('Access-Control-Allow-Origin', '*');
    ctx.res.end(audioBuffer);
  } catch (err) {
    ctx.logger.error(`RemoteClaw: TTS failed: ${err}`);
    sendJson(ctx.res, 500, {
      error: err instanceof Error ? err.message : 'Synthesis failed',
    });
  }
}
