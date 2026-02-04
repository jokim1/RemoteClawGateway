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

// Provider-specific voices
const PROVIDER_VOICES: Record<RealtimeVoiceProvider, string[]> = {
  openai: ['alloy', 'echo', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse'],
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

  if (process.env.OPENAI_API_KEY) {
    providers.push('openai');
  }
  if (process.env.CARTESIA_API_KEY) {
    providers.push('cartesia');
  }
  if (process.env.ELEVENLABS_API_KEY) {
    providers.push('elevenlabs');
  }
  if (process.env.DEEPGRAM_API_KEY) {
    providers.push('deepgram');
  }
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
    providers.push('gemini');
  }

  return providers;
}

function getDefaultProvider(providers: RealtimeVoiceProvider[]): RealtimeVoiceProvider | undefined {
  // Prefer Cartesia for realtime, then OpenAI
  if (providers.includes('cartesia')) return 'cartesia';
  if (providers.includes('openai')) return 'openai';
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
    // OpenAI Realtime API WebSocket
    const openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      }
    );

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        openaiWs.close();
        sendJsonMsg(clientWs, { type: 'error', message: 'OpenAI connection timeout' });
        resolve(null);
      }, 10000);

      openaiWs.on('open', () => {
        clearTimeout(timeout);
        logger.info('RealtimeVoice: connected to OpenAI Realtime');

        // Send session update with voice and system prompt
        const sessionUpdate = {
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            voice: voice || 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: {
              model: 'whisper-1',
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            instructions: systemPrompt || 'You are a helpful voice assistant. Keep responses concise.',
          },
        };
        openaiWs.send(JSON.stringify(sessionUpdate));

        const session: ProviderSession = {
          provider: 'openai',
          ws: openaiWs,
          voice: voice || 'alloy',
          systemPrompt,
        };

        resolve(session);
      });

      openaiWs.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(`RealtimeVoice: OpenAI error: ${err.message}`);
        sendJsonMsg(clientWs, { type: 'error', message: `OpenAI error: ${err.message}` });
        resolve(null);
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
// OpenAI Realtime message handling
// ---------------------------------------------------------------------------

function handleOpenAIMessage(
  data: string,
  clientWs: WebSocket,
  logger: Logger,
): void {
  try {
    const msg = JSON.parse(data);

    switch (msg.type) {
      case 'session.created':
        sendJsonMsg(clientWs, { type: 'session.start' });
        break;

      case 'response.audio.delta':
        // Forward audio to client
        if (msg.delta) {
          sendJsonMsg(clientWs, { type: 'audio', data: msg.delta });
        }
        break;

      case 'response.audio_transcript.delta':
        // AI transcript update
        sendJsonMsg(clientWs, {
          type: 'transcript.ai',
          text: msg.delta || '',
          isFinal: false,
        });
        break;

      case 'response.audio_transcript.done':
        sendJsonMsg(clientWs, {
          type: 'transcript.ai',
          text: msg.transcript || '',
          isFinal: true,
        });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // User transcript
        sendJsonMsg(clientWs, {
          type: 'transcript.user',
          text: msg.transcript || '',
          isFinal: true,
        });
        break;

      case 'input_audio_buffer.speech_started':
        // User started speaking
        break;

      case 'input_audio_buffer.speech_stopped':
        // User stopped speaking
        break;

      case 'error':
        logger.error(`RealtimeVoice: OpenAI error: ${JSON.stringify(msg.error)}`);
        sendJsonMsg(clientWs, {
          type: 'error',
          message: msg.error?.message || 'OpenAI error',
        });
        break;
    }
  } catch (err) {
    logger.error(`RealtimeVoice: failed to parse OpenAI message: ${err}`);
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
          clientWs.close(1011, 'Failed to connect to provider');
          return;
        }

        // Setup provider message handling
        providerSession.ws.on('message', (providerData: Buffer | string) => {
          switch (provider) {
            case 'openai':
              handleOpenAIMessage(providerData.toString(), clientWs, logger);
              break;
            case 'cartesia':
              handleCartesiaMessage(providerData, clientWs, logger);
              break;
          }
        });

        providerSession.ws.on('close', () => {
          logger.info('RealtimeVoice: provider connection closed');
          sendJsonMsg(clientWs, { type: 'session.end' });
          clientWs.close(1000, 'Provider disconnected');
        });

        providerSession.ws.on('error', (err) => {
          logger.error(`RealtimeVoice: provider error: ${err.message}`);
          sendJsonMsg(clientWs, { type: 'error', message: err.message });
        });

        sendJsonMsg(clientWs, { type: 'session.start' });
        return;
      }

      // Handle audio data
      if (msg.type === 'audio' && providerSession && msg.data) {
        const audioBuffer = Buffer.from(msg.data, 'base64');

        switch (provider) {
          case 'openai':
            // Send audio to OpenAI in their expected format
            providerSession.ws.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.data,  // Already base64
            }));
            break;

          case 'cartesia':
            // Cartesia expects binary audio or specific format
            // For now, we'll handle TTS differently
            // This would need Cartesia's STT integration
            break;
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
        }
        return;
      }

      // Handle end
      if (msg.type === 'end') {
        if (providerSession) {
          providerSession.ws.close();
        }
        clientWs.close(1000, 'Session ended');
        return;
      }
    });

    clientWs.on('close', () => {
      logger.info('RealtimeVoice: client disconnected');
      if (providerSession) {
        providerSession.ws.close();
      }
    });

    clientWs.on('error', (err) => {
      logger.error(`RealtimeVoice: client WebSocket error: ${err.message}`);
    });
  });
}
