/**
 * The slice of the Chrome DevTools Protocol this daemon actually reads.
 * Hand-written rather than generated: only what the collectors and ops touch,
 * so a protocol change surfaces as a compile error in one place.
 */

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  openerId?: string;
  canAccessOpener?: boolean;
  browserContextId?: string;
  subtype?: string;
}

export interface AttachedToTargetEvent {
  sessionId: string;
  targetInfo: TargetInfo;
  waitingForDebugger: boolean;
}

export interface DetachedFromTargetEvent {
  sessionId: string;
  targetId?: string;
}

export interface RequestPayload {
  url: string;
  urlFragment?: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
  postDataEntries?: Array<{ bytes?: string }>;
  mixedContentType?: string;
  initialPriority?: string;
  referrerPolicy?: string;
  isLinkPreload?: boolean;
}

export interface ResponsePayload {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType: string;
  charset?: string;
  requestHeaders?: Record<string, string>;
  connectionReused?: boolean;
  connectionId?: number;
  remoteIPAddress?: string;
  remotePort?: number;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  fromPrefetchCache?: boolean;
  encodedDataLength?: number;
  timing?: ResourceTiming;
  protocol?: string;
  securityState?: string;
  securityDetails?: Record<string, unknown>;
}

export interface ResourceTiming {
  requestTime: number;
  proxyStart: number;
  proxyEnd: number;
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  sslStart: number;
  sslEnd: number;
  sendStart: number;
  sendEnd: number;
  receiveHeadersStart?: number;
  receiveHeadersEnd: number;
}

export interface RequestWillBeSentEvent {
  requestId: string;
  loaderId: string;
  documentURL: string;
  request: RequestPayload;
  timestamp: number;
  wallTime: number;
  initiator: Record<string, unknown>;
  redirectResponse?: ResponsePayload;
  type?: string;
  frameId?: string;
  hasUserGesture?: boolean;
}

export interface RequestWillBeSentExtraInfoEvent {
  requestId: string;
  associatedCookies?: unknown[];
  headers: Record<string, string>;
  connectTiming?: { requestTime: number };
  clientSecurityState?: unknown;
}

export interface ResponseReceivedEvent {
  requestId: string;
  loaderId: string;
  timestamp: number;
  type: string;
  response: ResponsePayload;
  hasExtraInfo?: boolean;
  frameId?: string;
}

export interface ResponseReceivedExtraInfoEvent {
  requestId: string;
  blockedCookies?: unknown[];
  headers: Record<string, string>;
  resourceIPAddressSpace?: string;
  statusCode?: number;
  headersText?: string;
  cookiePartitionKey?: unknown;
}

export interface DataReceivedEvent {
  requestId: string;
  timestamp: number;
  dataLength: number;
  encodedDataLength: number;
}

export interface LoadingFinishedEvent {
  requestId: string;
  timestamp: number;
  encodedDataLength: number;
}

export interface LoadingFailedEvent {
  requestId: string;
  timestamp: number;
  type: string;
  errorText: string;
  canceled?: boolean;
  blockedReason?: string;
  corsErrorStatus?: { corsError: string; failedParameter: string };
}

export interface WebSocketCreatedEvent {
  requestId: string;
  url: string;
  initiator?: Record<string, unknown>;
}

export interface WebSocketFrameEvent {
  requestId: string;
  timestamp: number;
  response: { opcode: number; mask: boolean; payloadData: string };
}

export interface WebSocketClosedEvent {
  requestId: string;
  timestamp: number;
}

export interface WebSocketHandshakeResponseEvent {
  requestId: string;
  timestamp: number;
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    requestHeaders?: Record<string, string>;
  };
}

export interface EventSourceMessageEvent {
  requestId: string;
  timestamp: number;
  eventName: string;
  eventId: string;
  data: string;
}

export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: Record<string, unknown>;
}

export interface StackTrace {
  description?: string;
  callFrames: Array<{
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  }>;
  parent?: StackTrace;
}

export interface ConsoleApiCalledEvent {
  type: string;
  args: RemoteObject[];
  executionContextId: number;
  timestamp: number;
  stackTrace?: StackTrace;
  context?: string;
}

export interface ExceptionDetails {
  exceptionId: number;
  text: string;
  lineNumber: number;
  columnNumber: number;
  scriptId?: string;
  url?: string;
  stackTrace?: StackTrace;
  exception?: RemoteObject;
  executionContextId?: number;
}

export interface ExceptionThrownEvent {
  timestamp: number;
  exceptionDetails: ExceptionDetails;
}

export interface LogEntryAddedEvent {
  entry: {
    source: string;
    level: string;
    text: string;
    timestamp: number;
    url?: string;
    lineNumber?: number;
    stackTrace?: StackTrace;
    networkRequestId?: string;
    workerId?: string;
    args?: RemoteObject[];
  };
}

export interface ScriptParsedEvent {
  scriptId: string;
  url: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  executionContextId: number;
  hash: string;
  isModule?: boolean;
  length?: number;
  sourceMapURL?: string;
  hasSourceURL?: boolean;
}

export interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
  url: string;
  scopeChain: Array<{
    type: string;
    object: RemoteObject;
    name?: string;
  }>;
  this: RemoteObject;
  returnValue?: RemoteObject;
}

export interface DebuggerPausedEvent {
  callFrames: CallFrame[];
  reason: string;
  data?: Record<string, unknown>;
  hitBreakpoints?: string[];
  asyncStackTrace?: StackTrace;
}

export interface DomNode {
  nodeId: number;
  parentId?: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  childNodeCount?: number;
  children?: DomNode[];
  attributes?: string[];
  documentURL?: string;
  baseURL?: string;
  frameId?: string;
  contentDocument?: DomNode;
  shadowRoots?: DomNode[];
  shadowRootType?: string;
  isSVG?: boolean;
  pseudoElements?: DomNode[];
}

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: unknown[];
  role?: { type: string; value?: unknown };
  name?: { type: string; value?: unknown };
  description?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value: { type: string; value?: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface FrameTree {
  frame: {
    id: string;
    parentId?: string;
    loaderId: string;
    name?: string;
    url: string;
    securityOrigin: string;
    mimeType: string;
  };
  childFrames?: FrameTree[];
}
