import type { RecorderConfig } from '../config.js';
import type { CdpSession } from '../cdp/session.js';
import type {
  DataReceivedEvent,
  EventSourceMessageEvent,
  LoadingFailedEvent,
  LoadingFinishedEvent,
  RequestWillBeSentEvent,
  RequestWillBeSentExtraInfoEvent,
  ResponseReceivedEvent,
  ResponseReceivedExtraInfoEvent,
  WebSocketClosedEvent,
  WebSocketCreatedEvent,
  WebSocketFrameEvent,
  WebSocketHandshakeResponseEvent,
} from '../cdp/types.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import type { Stores } from '../store/index.js';
import { j } from '../store/db.js';
import type { Logger } from '../util/logger.js';

/** Statuses that never carry a body worth fetching. */
const BODILESS_STATUSES = new Set([204, 205, 304]);

interface RequestState {
  handle: string;
  hop: number;
  session: CdpSession;
  cdpRequestId: string;
  /** Response metadata needed to decide whether to fetch the body. */
  mimeType?: string;
  status?: number;
  resourceType?: string;
  dataLength: number;
}

interface BufferedExtraInfo {
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  statusCode?: number;
}

/**
 * Translates the CDP Network event stream into durable rows. Runs for the
 * lifetime of the browser regardless of whether an agent is connected, so
 * history is complete rather than "whatever was being watched at the time".
 */
export class NetworkCollector {
  /** key: `${sessionId}:${cdpRequestId}` */
  private readonly active = new Map<string, RequestState>();
  /** Extra-info events can land before requestWillBeSent; hold them until the row exists. */
  private readonly earlyExtraInfo = new Map<string, BufferedExtraInfo>();
  private readonly wsHandles = new Map<string, string>();

  constructor(
    private readonly browserId: string,
    private readonly stores: Stores,
    private readonly config: RecorderConfig,
    private readonly log: Logger,
  ) {}

  /** Enable the Network domain on a target and wire every event we record. */
  async attach(target: ManagedTarget): Promise<void> {
    const { session } = target;

    // Subscribe BEFORE enabling the domain. Chromium starts emitting as soon as
    // Network.enable is processed, and the command's reply is a separate
    // message: registering handlers after awaiting it drops everything in that
    // gap. On a freshly attached tab that gap is the whole first navigation,
    // which is precisely the traffic an agent is asked about.
    session.on('Network.requestWillBeSent', (params) =>
      this.onRequestWillBeSent(target, params as unknown as RequestWillBeSentEvent),
    );
    session.on('Network.requestWillBeSentExtraInfo', (params) =>
      this.onRequestExtraInfo(session, params as unknown as RequestWillBeSentExtraInfoEvent),
    );
    session.on('Network.responseReceived', (params) =>
      this.onResponseReceived(session, params as unknown as ResponseReceivedEvent),
    );
    session.on('Network.responseReceivedExtraInfo', (params) =>
      this.onResponseExtraInfo(session, params as unknown as ResponseReceivedExtraInfoEvent),
    );
    session.on('Network.dataReceived', (params) =>
      this.onDataReceived(session, params as unknown as DataReceivedEvent),
    );
    session.on('Network.loadingFinished', (params) => {
      void this.onLoadingFinished(session, params as unknown as LoadingFinishedEvent);
    });
    session.on('Network.loadingFailed', (params) =>
      this.onLoadingFailed(session, params as unknown as LoadingFailedEvent),
    );
    session.on('Network.requestServedFromCache', (params) => {
      const state = this.active.get(this.key(session, (params as { requestId: string }).requestId));
      if (state) this.stores.network.patch(state.handle, { served_from_cache: 1 });
    });

    session.on('Network.webSocketCreated', (params) =>
      this.onWebSocketCreated(target, params as unknown as WebSocketCreatedEvent),
    );
    session.on('Network.webSocketHandshakeResponseReceived', (params) =>
      this.onWebSocketHandshake(session, params as unknown as WebSocketHandshakeResponseEvent),
    );
    session.on('Network.webSocketFrameSent', (params) =>
      this.onWebSocketFrame(session, params as unknown as WebSocketFrameEvent, 'sent'),
    );
    session.on('Network.webSocketFrameReceived', (params) =>
      this.onWebSocketFrame(session, params as unknown as WebSocketFrameEvent, 'received'),
    );
    session.on('Network.webSocketFrameError', (params) => {
      const p = params as { requestId: string; errorMessage?: string };
      const handle = this.wsHandles.get(this.key(session, p.requestId));
      if (handle) this.stores.websockets.patch(handle, { error_text: p.errorMessage ?? 'frame error' });
    });
    session.on('Network.webSocketClosed', (params) =>
      this.onWebSocketClosed(session, params as unknown as WebSocketClosedEvent),
    );
    session.on('Network.eventSourceMessageReceived', (params) =>
      this.onEventSourceMessage(session, params as unknown as EventSourceMessageEvent),
    );

    const ok = await session.trySend('Network.enable', {
      maxTotalBufferSize: this.config.maxTotalBufferSize,
      maxResourceBufferSize: this.config.maxResourceBufferSize,
      // Inline POST bodies up to this size, saving a getRequestPostData roundtrip.
      maxPostDataSize: 1024 * 1024,
    });
    if (!ok) {
      this.log.debug(`Network.enable unsupported on ${target.type} ${target.handle}`);
    }
  }

  private key(session: CdpSession, requestId: string): string {
    return `${session.sessionId}:${requestId}`;
  }

  private onRequestWillBeSent(target: ManagedTarget, event: RequestWillBeSentEvent): void {
    const { session } = target;
    const key = this.key(session, event.requestId);
    const previous = this.active.get(key);

    // A redirectResponse means the previous hop completed with a 3xx. Close it
    // out as its own row so the whole chain stays inspectable.
    let hop = 0;
    if (event.redirectResponse && previous) {
      this.applyResponse(previous.handle, event.redirectResponse, event.timestamp);
      this.stores.network.patch(previous.handle, {
        state: 'finished',
        body_state: 'empty',
        completed_at: Date.now(),
      });
      hop = previous.hop + 1;
    } else if (previous) {
      hop = previous.hop + 1;
    }

    let postDataBlob: string | null = null;
    let postDataSize: number | null = null;
    let postDataState: string | null = null;
    if (typeof event.request.postData === 'string' && event.request.postData.length > 0) {
      const stored = this.stores.blobs.putText(event.request.postData);
      postDataBlob = stored.ref;
      postDataSize = stored.size;
      postDataState = 'stored';
    } else if (event.request.hasPostData) {
      // Body exceeded maxPostDataSize, or is a multipart upload whose file parts
      // CDP declines to hand back. Fetch what it will give us.
      postDataState = 'deferred';
    }

    const handle = this.stores.network.create({
      browserId: this.browserId,
      targetHandle: target.handle,
      cdpRequestId: event.requestId,
      hop,
      frameId: event.frameId ?? null,
      loaderId: event.loaderId ?? null,
      documentUrl: event.documentURL ?? null,
      url: event.request.url + (event.request.urlFragment ?? ''),
      method: event.request.method,
      resourceType: event.type ?? null,
      requestHeaders: event.request.headers ?? null,
      postDataBlob,
      postDataSize,
      postDataState,
      initiator: event.initiator,
      startedAt: Date.now(),
      wallTime: event.wallTime ?? null,
    });

    const state: RequestState = {
      handle,
      hop,
      session,
      cdpRequestId: event.requestId,
      dataLength: 0,
    };
    if (event.type) state.resourceType = event.type;
    this.active.set(key, state);

    if (postDataState === 'deferred') void this.fetchPostData(session, event.requestId, handle);

    const buffered = this.earlyExtraInfo.get(key);
    if (buffered) {
      this.earlyExtraInfo.delete(key);
      const patch: Record<string, unknown> = {};
      if (buffered.requestHeaders) patch.request_headers_extra = j(buffered.requestHeaders);
      if (buffered.responseHeaders) patch.response_headers_extra = j(buffered.responseHeaders);
      if (buffered.statusCode !== undefined) patch.status = buffered.statusCode;
      this.stores.network.patch(handle, patch);
    }
  }

  private async fetchPostData(session: CdpSession, requestId: string, handle: string): Promise<void> {
    try {
      const result = await session.send<{ postData: string }>('Network.getRequestPostData', {
        requestId,
      });
      if (typeof result.postData === 'string' && result.postData.length > 0) {
        const stored = this.stores.blobs.putText(result.postData);
        this.stores.network.patch(handle, {
          post_data_blob: stored.ref,
          post_data_size: stored.size,
          post_data_state: 'stored',
        });
        return;
      }
      this.stores.network.patch(handle, { post_data_state: 'empty' });
    } catch (err) {
      // Multipart uploads legitimately fail here: CDP omits file parts.
      this.log.trace(`getRequestPostData failed for ${requestId}`, err);
      this.stores.network.patch(handle, { post_data_state: 'unavailable' });
    }
  }

  private onRequestExtraInfo(session: CdpSession, event: RequestWillBeSentExtraInfoEvent): void {
    const key = this.key(session, event.requestId);
    const state = this.active.get(key);
    if (!state) {
      const buffered = this.earlyExtraInfo.get(key) ?? {};
      buffered.requestHeaders = event.headers;
      this.earlyExtraInfo.set(key, buffered);
      return;
    }
    this.stores.network.patch(state.handle, { request_headers_extra: j(event.headers) });
  }

  private onResponseExtraInfo(session: CdpSession, event: ResponseReceivedExtraInfoEvent): void {
    const key = this.key(session, event.requestId);
    const state = this.active.get(key);
    if (!state) {
      const buffered = this.earlyExtraInfo.get(key) ?? {};
      buffered.responseHeaders = event.headers;
      if (event.statusCode !== undefined) buffered.statusCode = event.statusCode;
      this.earlyExtraInfo.set(key, buffered);
      return;
    }
    const patch: Record<string, unknown> = { response_headers_extra: j(event.headers) };
    if (event.statusCode !== undefined) patch.status = event.statusCode;
    this.stores.network.patch(state.handle, patch);
  }

  private applyResponse(
    handle: string,
    response: ResponseReceivedEvent['response'],
    _timestamp: number,
  ): void {
    this.stores.network.patch(handle, {
      status: response.status,
      status_text: response.statusText,
      response_headers: j(response.headers),
      mime_type: response.mimeType,
      protocol: response.protocol ?? null,
      remote_ip: response.remoteIPAddress ?? null,
      remote_port: response.remotePort ?? null,
      from_disk_cache: response.fromDiskCache ? 1 : 0,
      from_service_worker: response.fromServiceWorker ? 1 : 0,
      from_prefetch_cache: response.fromPrefetchCache ? 1 : 0,
      encoded_data_length: response.encodedDataLength ?? null,
      timing: j(response.timing),
      response_at: Date.now(),
      state: 'response',
    });
  }

  private onResponseReceived(session: CdpSession, event: ResponseReceivedEvent): void {
    const state = this.active.get(this.key(session, event.requestId));
    if (!state) return;
    state.mimeType = event.response.mimeType;
    state.status = event.response.status;
    state.resourceType = event.type;
    this.applyResponse(state.handle, event.response, event.timestamp);
    this.stores.network.patch(state.handle, { resource_type: event.type });
  }

  private onDataReceived(session: CdpSession, event: DataReceivedEvent): void {
    const state = this.active.get(this.key(session, event.requestId));
    if (!state) return;
    state.dataLength += event.dataLength;
  }

  private async onLoadingFinished(session: CdpSession, event: LoadingFinishedEvent): Promise<void> {
    const key = this.key(session, event.requestId);
    const state = this.active.get(key);
    if (!state) return;
    this.active.delete(key);

    this.stores.network.patch(state.handle, {
      state: 'finished',
      completed_at: Date.now(),
      encoded_data_length: event.encodedDataLength,
      data_length: state.dataLength,
    });

    const bodyState = this.shouldCaptureBody(state);
    if (bodyState !== 'capture') {
      this.stores.network.patch(state.handle, { body_state: bodyState });
      return;
    }

    try {
      const result = await session.send<{ body: string; base64Encoded: boolean }>(
        'Network.getResponseBody',
        { requestId: event.requestId },
      );
      if (!result.body) {
        this.stores.network.patch(state.handle, { body_state: 'empty', body_size: 0 });
        return;
      }
      const buffer = result.base64Encoded
        ? Buffer.from(result.body, 'base64')
        : Buffer.from(result.body, 'utf8');
      if (buffer.length > this.config.maxBodyBytes) {
        this.stores.network.patch(state.handle, {
          body_state: 'too_large',
          body_size: buffer.length,
        });
        return;
      }
      const stored = this.stores.blobs.put(buffer);
      this.stores.network.patch(state.handle, {
        body_blob: stored.ref,
        body_size: stored.size,
        body_base64: result.base64Encoded ? 1 : 0,
        body_state: 'stored',
      });
    } catch (err) {
      // Bodies get evicted from Chrome's buffer, and some resources never had
      // one retrievable (redirects, some service-worker responses).
      this.log.trace(`getResponseBody failed for ${event.requestId}`, err);
      this.stores.network.patch(state.handle, { body_state: 'unavailable' });
    }
  }

  private shouldCaptureBody(state: RequestState): 'capture' | 'skipped' | 'empty' {
    if (!this.config.captureResponseBodies) return 'skipped';
    if (state.status !== undefined && BODILESS_STATUSES.has(state.status)) return 'empty';
    const mime = state.mimeType ?? '';
    for (const prefix of this.config.skipBodyMimePrefixes) {
      if (mime.startsWith(prefix)) return 'skipped';
    }
    if (state.dataLength > this.config.maxBodyBytes) return 'skipped';
    return 'capture';
  }

  private onLoadingFailed(session: CdpSession, event: LoadingFailedEvent): void {
    const key = this.key(session, event.requestId);
    const state = this.active.get(key);
    if (!state) return;
    this.active.delete(key);
    this.stores.network.patch(state.handle, {
      state: 'failed',
      body_state: 'unavailable',
      error_text: event.errorText,
      blocked_reason: event.blockedReason ?? event.corsErrorStatus?.corsError ?? null,
      canceled: event.canceled ? 1 : 0,
      completed_at: Date.now(),
    });
  }

  private onWebSocketCreated(target: ManagedTarget, event: WebSocketCreatedEvent): void {
    const handle = this.stores.websockets.create({
      browserId: this.browserId,
      targetHandle: target.handle,
      cdpRequestId: event.requestId,
      url: event.url,
      initiator: event.initiator,
      createdAt: Date.now(),
    });
    this.wsHandles.set(this.key(target.session, event.requestId), handle);
  }

  private onWebSocketHandshake(session: CdpSession, event: WebSocketHandshakeResponseEvent): void {
    const handle = this.wsHandles.get(this.key(session, event.requestId));
    if (!handle) return;
    this.stores.websockets.patch(handle, {
      handshake_status: event.response.status,
      handshake_headers: j(event.response.headers),
    });
  }

  private onWebSocketFrame(
    session: CdpSession,
    event: WebSocketFrameEvent,
    direction: 'sent' | 'received',
  ): void {
    if (!this.config.captureWebSocketFrames) return;
    const handle = this.wsHandles.get(this.key(session, event.requestId));
    if (!handle) return;
    const payload = event.response.payloadData ?? '';
    const truncated = payload.length > this.config.maxWebSocketFrameBytes;
    this.stores.websockets.addMessage({
      wsHandle: handle,
      browserId: this.browserId,
      direction,
      opcode: event.response.opcode ?? null,
      payload: truncated ? payload.slice(0, this.config.maxWebSocketFrameBytes) : payload,
      payloadSize: payload.length,
      truncated,
      ts: Date.now(),
    });
  }

  private onWebSocketClosed(session: CdpSession, event: WebSocketClosedEvent): void {
    const key = this.key(session, event.requestId);
    const handle = this.wsHandles.get(key);
    if (!handle) return;
    this.wsHandles.delete(key);
    this.stores.websockets.patch(handle, { closed_at: Date.now() });
  }

  /**
   * Server-sent events ride on a normal request whose body streams forever, so
   * they are recorded as frames against a synthetic connection instead.
   */
  private onEventSourceMessage(session: CdpSession, event: EventSourceMessageEvent): void {
    const key = this.key(session, event.requestId);
    let handle = this.wsHandles.get(key);
    if (!handle) {
      const request = this.active.get(key);
      handle = this.stores.websockets.create({
        browserId: this.browserId,
        targetHandle: null,
        cdpRequestId: `sse:${event.requestId}`,
        url: request ? (this.stores.network.get(request.handle)?.url ?? 'eventsource') : 'eventsource',
        initiator: { type: 'eventsource' },
        createdAt: Date.now(),
      });
      this.wsHandles.set(key, handle);
    }
    this.stores.websockets.addMessage({
      wsHandle: handle,
      browserId: this.browserId,
      direction: 'received',
      opcode: null,
      payload: JSON.stringify({ event: event.eventName, id: event.eventId, data: event.data }),
      payloadSize: event.data.length,
      truncated: false,
      ts: Date.now(),
    });
  }

  /** Drop in-memory tracking for a target that went away; rows stay. */
  detach(target: ManagedTarget): void {
    const prefix = `${target.session.sessionId}:`;
    for (const key of [...this.active.keys()]) {
      if (key.startsWith(prefix)) this.active.delete(key);
    }
    for (const key of [...this.earlyExtraInfo.keys()]) {
      if (key.startsWith(prefix)) this.earlyExtraInfo.delete(key);
    }
    for (const key of [...this.wsHandles.keys()]) {
      if (key.startsWith(prefix)) this.wsHandles.delete(key);
    }
  }
}
