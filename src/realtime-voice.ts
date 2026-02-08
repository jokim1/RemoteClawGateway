/**
 * Realtime Voice Endpoints
 *
 * Handles bidirectional real-time voice streaming via WebSocket.
 * Supports multiple providers: OpenAI Realtime API, Cartesia, etc.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import type { HandlerContext, Logger, RealtimeVoicePluginConfig } from './types.js';
import { sendJson } from './http.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RealtimeVoiceProvider = 'openai' | 'cartesia' | 'elevenlabs' | 'deepgram' | 'gemini';

interface RealtimeClientMessage {
  type: 'audio' | 'config' | 'interrupt' | 'end';
  data?: string;  // base64 audio for 'audio' type
  voice?: string;
  systemPrompt?: string;
}

interface RealtimeServerMessage {
  type: 'audio' | 'transcript.user' | 'transcript.ai' | 'error' | 'session.start' | 'session.end';
  data?: string;
  text?: string;
  isFinal?: boolean;
  message?: string;
}

interface ProviderSession {
  provider: RealtimeVoiceProvider;
  ws: WebSocket;  // upstream provider WebSocket
  voice?: string;
  systemPrompt?: string;
}

// Audio format constants (matches client expectations)
const SAMPLE_RATE = 24000;
const ELEVENLABS_SAMPLE_RATE = 16000;

// Keepalive interval (30 seconds)
const KEEPALIVE_INTERVAL_MS = 30000;

// ---------------------------------------------------------------------------
// Audio resampling helper
// ---------------------------------------------------------------------------

/**
 * Resample PCM16 audio from one sample rate to another using linear interpolation.
 * Input and output are 16-bit signed integers (little-endian).
 */
function resamplePCM(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const inputSamples = input.length / 2;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, inputSamples - 1);
    const frac = srcIndex - srcIndexFloor;

    const sample1 = input.readInt16LE(srcIndexFloor * 2);
    const sample2 = input.readInt16LE(srcIndexCeil * 2);
    const interpolated = Math.round(sample1 + (sample2 - sample1) * frac);

    output.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
  }

  return output;
}

/**
 * Resample PCM16 audio from 16kHz (ElevenLabs) to 24kHz (client).
 */
function upsampleTo24kHz(input: Buffer): Buffer {
  return resamplePCM(input, ELEVENLABS_SAMPLE_RATE, SAMPLE_RATE);
}

// Provider-specific voices
const PROVIDER_VOICES: Record<RealtimeVoiceProvider, string[]> = {
  openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'],
  cartesia: ['sonic-english', 'sonic-multilingual'],
  elevenlabs: ['rachel', 'drew', 'clyde', 'paul', 'domi', 'dave', 'fin', 'sarah'],
  deepgram: ['aura-asteria-en', 'aura-luna-en', 'aura-stella-en', 'aura-athena-en', 'aura-hera-en', 'aura-orion-en', 'aura-arcas-en', 'aura-perseus-en', 'aura-angus-en', 'aura-orpheus-en', 'aura-helios-en', 'aura-zeus-en'],
  gemini: ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'],
};

// ---------------------------------------------------------------------------
// WebSocket Server (shared, noServer mode)
// ---------------------------------------------------------------------------

let _wss: WebSocketServer | undefined;

function getWSS(): WebSocketServer {
  if (!_wss) {
    _wss = new WebSocketServer({ noServer: true });
  }
  return _wss;
}

// ---------------------------------------------------------------------------
// Provider availability detection
// ---------------------------------------------------------------------------

function getAvailableProviders(): RealtimeVoiceProvider[] {
  const providers: RealtimeVoiceProvider[] = [];

  // OpenAI Realtime API - single connection handles STT + LLM + TTS
  if (process.env.OPENAI_API_KEY) {
    providers.push('openai');
  }

  // ElevenLabs Conversational AI - requires both API key and agent ID
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID) {
    providers.push('elevenlabs');
  }

  // Cartesia for realtime requires both Cartesia (TTS) and Deepgram (STT)
  if (process.env.CARTESIA_API_KEY && process.env.DEEPGRAM_API_KEY) {
    providers.push('cartesia');
  }

  // Gemini Live API
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
    providers.push('gemini');
  }

  return providers;
}

function getDefaultProvider(providers: RealtimeVoiceProvider[]): RealtimeVoiceProvider | undefined {
  // Prefer OpenAI for realtime (most complete solution)
  if (providers.includes('openai')) return 'openai';
  if (providers.includes('elevenlabs')) return 'elevenlabs';
  if (providers.includes('cartesia')) return 'cartesia';
  return providers[0];
}

// ---------------------------------------------------------------------------
// GET /api/realtime-voice/capabilities
// ---------------------------------------------------------------------------

export async function handleRealtimeVoiceCapabilities(ctx: HandlerContext): Promise<void> {
  if (ctx.req.method !== 'GET') {
    ctx.res.statusCode = 405;
    ctx.res.setHeader('Allow', 'GET, OPTIONS');
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.end('Method Not Allowed');
    return;
  }

  const providers = getAvailableProviders();
  const defaultProvider = getDefaultProvider(providers);

  // Build voices map for available providers only
  const voices: Partial<Record<RealtimeVoiceProvider, string[]>> = {};
  for (const p of providers) {
    voices[p] = PROVIDER_VOICES[p] || [];
  }

  sendJson(ctx.res, 200, {
    available: providers.length > 0,
    providers,
    defaultProvider,
    voices,
  });
}

// ---------------------------------------------------------------------------
// Provider-specific WebSocket connections
// ---------------------------------------------------------------------------

async function connectToCartesia(
  clientWs: WebSocket,
  logger: Logger,
  voice: string,
  _systemPrompt: string | undefined,
): Promise<ProviderSession | null> {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    sendJsonMsg(clientWs, { type: 'error', message: 'Cartesia API key not configured' });
    return null;
  }

  try {
    // Cartesia WebSocket URL for streaming TTS
    // Note: Cartesia's realtime API uses a different model for voice-to-voice
    const cartesiaWs = new WebSocket('wss://api.cartesia.ai/tts/websocket', {
      headers: {
        'X-API-Key': apiKey,
        'Cartesia-Version': '2024-06-10',
      },
    });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cartesiaWs.close();
        sendJsonMsg(clientWs, { type: 'error', message: 'Cartesia connection timeout' });
        resolve(null);
      }, 10000);

      cartesiaWs.on('open', () => {
        clearTimeout(timeout);
        logger.info('RealtimeVoice: connected to Cartesia');

        const session: ProviderSession = {
          provider: 'cartesia',
          ws: cartesiaWs,
          voice: voice || 'sonic-english',
        };

        resolve(session);
      });

      cartesiaWs.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(`RealtimeVoice: Cartesia error: ${err.message}`);
        sendJsonMsg(clientWs, { type: 'error', message: `Cartesia error: ${err.message}` });
        resolve(null);
      });
    });
  } catch (err) {
    logger.error(`RealtimeVoice: failed to connect to Cartesia: ${err}`);
    sendJsonMsg(clientWs, { type: 'error', message: 'Failed to connect to Cartesia' });
    return null;
  }
}

async function connectToOpenAI(
  clientWs: WebSocket,
  logger: Logger,
  voice: string,
  systemPrompt: string | undefined,
): Promise<ProviderSession | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    sendJsonMsg(clientWs, { type: 'error', message: 'OpenAI API key not configured' });
    return null;
  }

  try {
    // OpenAI Realtime API WebSocket — GA model (no Beta header)
    const openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime',
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      }
    );

    return new Promise((resolve) => {
      let resolved = false;
      const safeResolve = (value: ProviderSession | null) => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      };

      const timeout = setTimeout(() => {
        openaiWs.close();
        sendJsonMsg(clientWs, { type: 'error', message: 'OpenAI connection timeout' });
        safeResolve(null);
      }, 10000);

      openaiWs.on('open', () => {
        logger.info('RealtimeVoice: connected to OpenAI Realtime (GA)');

        // GA session.update format — restructured audio config
        const sessionUpdate = {
          type: 'session.update',
          session: {
            type: 'realtime',
            model: 'gpt-realtime',
            instructions: systemPrompt || 'You are a helpful voice assistant. Keep responses concise.',
            output_modalities: ['text', 'audio'],
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: SAMPLE_RATE },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                  create_response: true,
                  interrupt_response: true,
                },
                transcription: {
                  model: 'gpt-4o-transcribe',
                },
              },
              output: {
                format: { type: 'audio/pcm', rate: SAMPLE_RATE },
                voice: voice || 'alloy',
              },
            },
          },
        };
        openaiWs.send(JSON.stringify(sessionUpdate));
        logger.info('RealtimeVoice: sent GA session.update');
      });

      // Wait for session.created before resolving — ensures OpenAI is ready
      openaiWs.on('message', function onSetupMessage(data: Buffer | string) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session.created') {
            clearTimeout(timeout);
            logger.info('RealtimeVoice: OpenAI session created');
            // Remove this setup listener — main handler will take over
            openaiWs.removeListener('message', onSetupMessage);
            const session: ProviderSession = {
              provider: 'openai',
              ws: openaiWs,
              voice: voice || 'alloy',
              systemPrompt,
            };
            safeResolve(session);
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            const errMsg = msg.error?.message || 'OpenAI session error';
            logger.error(`RealtimeVoice: OpenAI setup error: ${errMsg}`);
            sendJsonMsg(clientWs, { type: 'error', message: errMsg });
            openaiWs.close();
            safeResolve(null);
          }
        } catch {
          // Ignore parse errors during setup
        }
      });

      openaiWs.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(`RealtimeVoice: OpenAI error: ${err.message}`);
        sendJsonMsg(clientWs, { type: 'error', message: `OpenAI error: ${err.message}` });
        safeResolve(null);
      });

      openaiWs.on('close', (code, reason) => {
        clearTimeout(timeout);
        const reasonStr = reason?.toString() || '';
        logger.error(`RealtimeVoice: OpenAI closed during setup (code=${code}, reason=${reasonStr})`);
        sendJsonMsg(clientWs, {
          type: 'error',
          message: `OpenAI rejected connection (code=${code}${reasonStr ? `, ${reasonStr}` : ''})`,
        });
        safeResolve(null);
      });
    });
  } catch (err) {
    logger.error(`RealtimeVoice: failed to connect to OpenAI: ${err}`);
    sendJsonMsg(clientWs, { type: 'error', message: 'Failed to connect to OpenAI' });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function sendJsonMsg(ws: WebSocket, msg: RealtimeServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ---------------------------------------------------------------------------
// OpenAI Realtime message handling (per-session closure)
// ---------------------------------------------------------------------------

function createOpenAIMessageHandler(clientWs: WebSocket, logger: Logger) {
  let accumulatedAITranscript = '';

  return function handleOpenAIMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        // Session lifecycle (same in Beta and GA)
        case 'session.created':
          logger.info('RealtimeVoice: OpenAI session created');
          sendJsonMsg(clientWs, { type: 'session.start' });
          break;

        case 'session.updated':
          logger.info('RealtimeVoice: OpenAI session updated — ready for audio');
          break;

        // Audio output — handle both GA and Beta event names
        case 'response.output_audio.delta':
        case 'response.audio.delta':
          if (msg.delta) {
            sendJsonMsg(clientWs, { type: 'audio', data: msg.delta });
          }
          break;

        // AI transcript streaming — handle both GA and Beta event names
        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta':
          accumulatedAITranscript += msg.delta || '';
          sendJsonMsg(clientWs, {
            type: 'transcript.ai',
            text: accumulatedAITranscript,
            isFinal: false,
          });
          break;

        // AI transcript final — handle both GA and Beta event names
        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done':
          sendJsonMsg(clientWs, {
            type: 'transcript.ai',
            text: msg.transcript || accumulatedAITranscript,
            isFinal: true,
          });
          accumulatedAITranscript = '';
          break;

        // User transcript (unchanged between Beta and GA)
        case 'conversation.item.input_audio_transcription.completed':
          sendJsonMsg(clientWs, {
            type: 'transcript.user',
            text: msg.transcript || '',
            isFinal: true,
          });
          break;

        // VAD events (unchanged)
        case 'input_audio_buffer.speech_started':
          logger.debug?.('RealtimeVoice: User speech started');
          break;

        case 'input_audio_buffer.speech_stopped':
          logger.debug?.('RealtimeVoice: User speech stopped');
          break;

        // Response lifecycle (unchanged)
        case 'response.created':
          accumulatedAITranscript = '';
          break;

        case 'response.done':
          logger.debug?.('RealtimeVoice: Response complete');
          break;

        case 'response.cancelled':
          logger.info('RealtimeVoice: Response cancelled (barge-in)');
          accumulatedAITranscript = '';
          break;

        case 'error':
          logger.error(`RealtimeVoice: OpenAI error: ${JSON.stringify(msg.error)}`);
          sendJsonMsg(clientWs, {
            type: 'error',
            message: msg.error?.message || 'OpenAI error',
          });
          break;

        default:
          logger.debug?.(`RealtimeVoice: Unhandled OpenAI event: ${msg.type}`);
      }
    } catch (err) {
      logger.error(`RealtimeVoice: failed to parse OpenAI message: ${err}`);
    }
  };
}

// ---------------------------------------------------------------------------
// ElevenLabs Conversational AI
// ---------------------------------------------------------------------------

async function connectToElevenLabs(
  clientWs: WebSocket,
  logger: Logger,
  _voice: string,
  _systemPrompt: string | undefined,
): Promise<ProviderSession | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;

  if (!apiKey || !agentId) {
    sendJsonMsg(clientWs, { type: 'error', message: 'ElevenLabs API key or Agent ID not configured' });
    return null;
  }

  try {
    // ElevenLabs Conversational AI WebSocket
    const elevenWs = new WebSocket(
      `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`,
      {
        headers: {
          'xi-api-key': apiKey,
        },
      }
    );

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        elevenWs.close();
        sendJsonMsg(clientWs, { type: 'error', message: 'ElevenLabs connection timeout' });
        resolve(null);
      }, 10000);

      elevenWs.on('open', () => {
        clearTimeout(timeout);
        logger.info('RealtimeVoice: connected to ElevenLabs');

        const session: ProviderSession = {
          provider: 'elevenlabs',
          ws: elevenWs,
        };

        resolve(session);
      });

      elevenWs.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(`RealtimeVoice: ElevenLabs error: ${err.message}`);
        sendJsonMsg(clientWs, { type: 'error', message: `ElevenLabs error: ${err.message}` });
        resolve(null);
      });
    });
  } catch (err) {
    logger.error(`RealtimeVoice: failed to connect to ElevenLabs: ${err}`);
    sendJsonMsg(clientWs, { type: 'error', message: 'Failed to connect to ElevenLabs' });
    return null;
  }
}

function handleElevenLabsMessage(
  data: string | Buffer,
  clientWs: WebSocket,
  logger: Logger,
): void {
  try {
    const msg = JSON.parse(data.toString());

    // ElevenLabs message types
    if (msg.audio) {
      // Audio response chunk - ElevenLabs sends 16kHz, we need 24kHz
      const audioBuffer16k = Buffer.from(msg.audio, 'base64');
      const audioBuffer24k = upsampleTo24kHz(audioBuffer16k);
      sendJsonMsg(clientWs, { type: 'audio', data: audioBuffer24k.toString('base64') });
    }

    if (msg.user_transcription) {
      // User speech transcript
      sendJsonMsg(clientWs, {
        type: 'transcript.user',
        text: msg.user_transcription,
        isFinal: true,
      });
    }

    if (msg.agent_response) {
      // AI response transcript
      sendJsonMsg(clientWs, {
        type: 'transcript.ai',
        text: msg.agent_response,
        isFinal: msg.isFinal ?? true,
      });
    }

    if (msg.type === 'conversation_initiation_metadata') {
      // Session started
      logger.info('RealtimeVoice: ElevenLabs session initialized');
    }

    if (msg.type === 'error') {
      logger.error(`RealtimeVoice: ElevenLabs error: ${msg.message}`);
      sendJsonMsg(clientWs, { type: 'error', message: msg.message });
    }
  } catch (err) {
    logger.error(`RealtimeVoice: failed to parse ElevenLabs message: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Cartesia message handling
// ---------------------------------------------------------------------------

function handleCartesiaMessage(
  data: string | Buffer,
  clientWs: WebSocket,
  logger: Logger,
): void {
  try {
    // Cartesia sends JSON or binary audio
    if (Buffer.isBuffer(data)) {
      // Binary audio data - forward to client as base64
      sendJsonMsg(clientWs, { type: 'audio', data: data.toString('base64') });
      return;
    }

    const msg = JSON.parse(data.toString());

    if (msg.type === 'audio') {
      sendJsonMsg(clientWs, { type: 'audio', data: msg.data });
    } else if (msg.type === 'error') {
      logger.error(`RealtimeVoice: Cartesia error: ${msg.message}`);
      sendJsonMsg(clientWs, { type: 'error', message: msg.message });
    }
  } catch (err) {
    logger.error(`RealtimeVoice: failed to parse Cartesia message: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// WS /api/realtime-voice/stream
// ---------------------------------------------------------------------------

export function handleRealtimeVoiceStreamUpgrade(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
  _voiceCfg: RealtimeVoicePluginConfig | undefined,
): void {
  // Validate WebSocket upgrade
  const upgradeHeader = (req.headers['upgrade'] ?? '').toLowerCase();
  if (upgradeHeader !== 'websocket') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Expected WebSocket upgrade');
    return;
  }

  // Parse provider from query string
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const providerParam = url.searchParams.get('provider') as RealtimeVoiceProvider | null;

  const availableProviders = getAvailableProviders();
  if (availableProviders.length === 0) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain');
    res.end('No realtime voice providers configured');
    return;
  }

  const provider = providerParam && availableProviders.includes(providerParam)
    ? providerParam
    : getDefaultProvider(availableProviders)!;

  const socket = req.socket;
  const wss = getWSS();

  wss.handleUpgrade(req, socket, Buffer.alloc(0), (clientWs) => {
    logger.info(`RealtimeVoice: client connected (provider=${provider})`);

    let providerSession: ProviderSession | null = null;
    let configReceived = false;
    let sessionEnded = false;

    // Buffer audio messages that arrive before provider is connected
    const pendingAudioMessages: RealtimeClientMessage[] = [];

    // Keepalive: ping client every 30s to prevent NAT/firewall timeout
    const keepaliveInterval = setInterval(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.ping();
      }
    }, KEEPALIVE_INTERVAL_MS);

    // Keepalive for provider connection (set up after provider connects)
    let providerKeepaliveInterval: NodeJS.Timeout | null = null;

    /** Clean shutdown of the session. */
    function cleanupSession(): void {
      if (sessionEnded) return;
      sessionEnded = true;
      clearInterval(keepaliveInterval);
      if (providerKeepaliveInterval) {
        clearInterval(providerKeepaliveInterval);
        providerKeepaliveInterval = null;
      }
    }

    /** Flush buffered audio to provider after connection is established. */
    function flushPendingAudio(): void {
      while (pendingAudioMessages.length > 0) {
        const pending = pendingAudioMessages.shift()!;
        forwardAudioToProvider(pending);
      }
    }

    /** Forward a single audio message to the upstream provider. */
    function forwardAudioToProvider(msg: RealtimeClientMessage): void {
      if (!providerSession || !msg.data) return;
      if (providerSession.ws.readyState !== WebSocket.OPEN) return;

      switch (provider) {
        case 'openai':
          providerSession.ws.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.data,
          }));
          break;

        case 'elevenlabs': {
          const audioBuffer24k = Buffer.from(msg.data, 'base64');
          const resampledBuffer = resamplePCM(audioBuffer24k, 24000, 16000);
          providerSession.ws.send(JSON.stringify({
            user_audio_chunk: resampledBuffer.toString('base64'),
          }));
          break;
        }

        case 'cartesia':
          // Cartesia STT integration not yet implemented
          break;
      }
    }

    // Create per-session OpenAI message handler (avoids module-level state)
    const handleOpenAIMsg = createOpenAIMessageHandler(clientWs, logger);

    clientWs.on('message', async (data: Buffer | string) => {
      // Parse client message
      let msg: RealtimeClientMessage;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
      } catch {
        sendJsonMsg(clientWs, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      // Handle config message (establishes provider connection)
      if (msg.type === 'config') {
        if (configReceived) return;
        configReceived = true;

        // Connect to provider
        switch (provider) {
          case 'openai':
            providerSession = await connectToOpenAI(
              clientWs, logger, msg.voice || 'alloy', msg.systemPrompt
            );
            break;

          case 'elevenlabs':
            providerSession = await connectToElevenLabs(
              clientWs, logger, msg.voice || 'rachel', msg.systemPrompt
            );
            break;

          case 'cartesia':
            providerSession = await connectToCartesia(
              clientWs, logger, msg.voice || 'sonic-english', msg.systemPrompt
            );
            break;

          default:
            sendJsonMsg(clientWs, { type: 'error', message: `Provider ${provider} not yet supported` });
            return;
        }

        if (!providerSession) {
          sendJsonMsg(clientWs, { type: 'error', message: `Failed to connect to ${provider}` });
          clientWs.close(1011, 'Failed to connect to provider');
          cleanupSession();
          return;
        }

        // Setup provider message handling
        providerSession.ws.on('message', (providerData: Buffer | string) => {
          switch (provider) {
            case 'openai':
              handleOpenAIMsg(providerData.toString());
              break;
            case 'elevenlabs':
              handleElevenLabsMessage(providerData, clientWs, logger);
              break;
            case 'cartesia':
              handleCartesiaMessage(providerData, clientWs, logger);
              break;
          }
        });

        providerSession.ws.on('close', (code, reason) => {
          const reasonStr = reason?.toString() || 'none';
          logger.info(`RealtimeVoice: provider connection closed (code=${code}, reason=${reasonStr})`);
          // Forward close reason as error so client can display it
          sendJsonMsg(clientWs, {
            type: 'error',
            message: `Provider disconnected (code=${code}${reasonStr !== 'none' ? `, reason=${reasonStr}` : ''})`,
          });
          sendJsonMsg(clientWs, { type: 'session.end' });
          clientWs.close(1000, 'Provider disconnected');
          cleanupSession();
        });

        providerSession.ws.on('error', (err) => {
          logger.error(`RealtimeVoice: provider error: ${err.message}`);
          sendJsonMsg(clientWs, { type: 'error', message: err.message });
        });

        // Keepalive for provider WebSocket
        providerKeepaliveInterval = setInterval(() => {
          if (providerSession?.ws.readyState === WebSocket.OPEN) {
            providerSession.ws.ping();
          }
        }, KEEPALIVE_INTERVAL_MS);

        sendJsonMsg(clientWs, { type: 'session.start' });

        // Flush any audio that arrived while connecting to provider
        flushPendingAudio();
        return;
      }

      // Handle audio data
      if (msg.type === 'audio' && msg.data) {
        if (providerSession) {
          forwardAudioToProvider(msg);
        } else if (configReceived) {
          // Provider still connecting — buffer the audio
          pendingAudioMessages.push(msg);
          // Cap buffer to prevent memory growth (keep ~5 seconds of audio at 24kHz)
          while (pendingAudioMessages.length > 200) {
            pendingAudioMessages.shift();
          }
        }
        return;
      }

      // Handle interrupt (barge-in)
      if (msg.type === 'interrupt' && providerSession) {
        switch (provider) {
          case 'openai':
            providerSession.ws.send(JSON.stringify({
              type: 'response.cancel',
            }));
            break;

          case 'elevenlabs':
            providerSession.ws.send(JSON.stringify({
              type: 'interruption',
            }));
            break;
        }
        return;
      }

      // Handle end
      if (msg.type === 'end') {
        if (providerSession) {
          providerSession.ws.close();
        }
        clientWs.close(1000, 'Session ended');
        cleanupSession();
        return;
      }
    });

    clientWs.on('close', (code, reason) => {
      logger.info(`RealtimeVoice: client disconnected (code=${code}, reason=${reason?.toString() || 'none'})`);
      if (providerSession) {
        providerSession.ws.close();
      }
      cleanupSession();
    });

    clientWs.on('error', (err) => {
      logger.error(`RealtimeVoice: client WebSocket error: ${err.message}`);
    });
  });
}
