import { EphemeralKeyServiceImpl } from '../../src/auth/ephemeral-key-service';
import { resolveRealtimeSessionPreferences } from '../../src/config/realtime-session';
import { Logger } from '../../src/core/logger';
import {
    AudioConfig,
    AzureOpenAIConfig,
    AzureRealtimeConfig,
} from '../../src/types/configuration';
import { expect } from "../helpers/chai-setup";
import { afterEach, suite, test } from '../mocha-globals';

// Minimal mock credential manager implementing only required surface
class MockCredMgr {
  isInitialized() { return true; }
}

class MockConfigMgr {
  private readonly cfg: AzureOpenAIConfig;
  private readonly realtime: AzureRealtimeConfig;
  private readonly audio: AudioConfig;

  constructor(
    cfg: AzureOpenAIConfig,
    realtime: AzureRealtimeConfig,
    audio: AudioConfig,
  ) {
    this.cfg = cfg;
    this.realtime = realtime;
    this.audio = audio;
  }
  isInitialized() { return true; }
  getAzureOpenAIConfig() { return this.cfg; }
  getAzureRealtimeConfig() { return this.realtime; }
  getAudioConfig() { return this.audio; }
  getRealtimeSessionPreferences() {
    return resolveRealtimeSessionPreferences(this.realtime, this.audio);
  }
}

function okSessionResponse() {
  return {
    id: 'sess-1',
    model: 'gpt-4o-realtime-preview',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    client_secret: { value: 'ephemeral-key-xyz', expires_at: Math.floor(Date.now() / 1000) + 60 }
  };
}

const baseConfig: AzureOpenAIConfig = {
  endpoint: 'https://unit.openai.azure.com',
  deploymentName: 'gpt-4o-realtime-preview',
  apiVersion: '2025-04-01-preview'
};

const baseRealtimeConfig: AzureRealtimeConfig = {
  apiVersion: '2025-08-28',
  transcriptionModel: 'whisper-large-v3',
  inputAudioFormat: 'pcm16',
  locale: 'en-US',
  profanityFilter: 'medium',
  interimDebounceMs: 150,
  maxTranscriptHistorySeconds: 120,
};

const baseAudioConfig: AudioConfig = {
  inputDevice: 'default',
  outputDevice: 'default',
  noiseReduction: true,
  echoCancellation: true,
  sampleRate: 16000,
  sharedContext: {
    autoResume: true,
    requireGesture: false,
    latencyHint: 'interactive',
  },
  workletModules: [],
  turnDetection: {
    type: 'semantic_vad',
    threshold: 0.5,
    prefixPaddingMs: 120,
    silenceDurationMs: 350,
    createResponse: true,
    interruptResponse: true,
    eagerness: 'auto',
  },
  tts: {
    transport: 'webrtc',
    apiVersion: '2025-08-28',
    fallbackMode: 'retry',
    maxInitialLatencyMs: 750,
    voice: {
      name: 'en-US-AriaNeural',
      locale: 'en-US',
    },
  },
};

suite('Unit: EphemeralKeyServiceImpl', () => {
  const originalFetch = (global as any).fetch;

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  test('initializes successfully with valid key and session creation', async () => {
    (global as any).fetch = async () => ({ ok: true, status: 200, json: async () => okSessionResponse() });
    const svc = new EphemeralKeyServiceImpl(
      new MockCredMgr() as any,
      new MockConfigMgr(baseConfig, baseRealtimeConfig, baseAudioConfig) as any,
      new Logger('Test'),
    );

    // Mock the testAuthentication method to avoid Azure credential issues
    (svc as any).testAuthentication = async () => ({
      success: true,
      endpoint: baseConfig.endpoint,
      hasValidCredentials: true,
      canCreateSessions: true
    });

    await svc.initialize();
    expect(svc.isInitialized()).to.equal(true);
  });

  test('initializes in degraded mode when authentication test cannot create session', async () => {
    (global as any).fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Unauthorized' }}) });
    const svc = new EphemeralKeyServiceImpl(
      new MockCredMgr() as any,
      new MockConfigMgr(baseConfig, baseRealtimeConfig, baseAudioConfig) as any,
      new Logger('Test'),
    );

    // Mock the testAuthentication method to return failure
    (svc as any).testAuthentication = async () => ({
      success: false,
      endpoint: baseConfig.endpoint,
      hasValidCredentials: true,
      canCreateSessions: false,
      error: 'HTTP 401: Unauthorized'
    });

    // Service should initialize successfully even if auth test fails (degraded mode)
    await svc.initialize();
    expect(svc.isInitialized()).to.equal(true);
  });

  // Test removed: API key support was removed in favor of keyless authentication
  // The service now always uses DefaultAzureCredential, so there's no "missing key" scenario
  // test('requestEphemeralKey returns error when missing key', async () => {
  //   (global as any).fetch = async () => ({ ok: true, status: 200, json: async () => okSessionResponse() });
  //   const svc = new EphemeralKeyServiceImpl(
  //     new MockCredMgr() as any,
  //     new MockConfigMgr(baseConfig, baseRealtimeConfig, baseAudioConfig) as any,
  //     new Logger('Test'),
  //   );
  //   (svc as any).initialized = true;
  //   const result = await svc.requestEphemeralKey();
  //   expect(result.success).to.equal(false);
  //   expect(result.error?.code).to.equal('MISSING_CREDENTIALS');
  // });

  test('maps 429 to RATE_LIMITED', async () => {
    (global as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'Too many' }}) });
    const svc = new EphemeralKeyServiceImpl(
      new MockCredMgr() as any,
      new MockConfigMgr(baseConfig, baseRealtimeConfig, baseAudioConfig) as any,
      new Logger('Test'),
    );

    // Mock the testAuthentication method to avoid Azure credential issues during initialization
    (svc as any).testAuthentication = async () => ({
      success: true,
      endpoint: baseConfig.endpoint,
      hasValidCredentials: true,
      canCreateSessions: true
    });

    // Initialize first (this calls testAuthentication)
    await svc.initialize();

    // Now mock createAzureSession to test the specific error handling
    (svc as any).createAzureSession = async () => {
      const error = new Error('HTTP 429');
      (error as any).status = 429;
      throw error;
    };

    const result = await svc.requestEphemeralKey();
    expect(result.success).to.equal(false);
    expect(result.error?.code).to.equal('RATE_LIMITED');
  });
});
