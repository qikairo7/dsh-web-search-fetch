// Opt-in diagnostic preload for the public example.com incident, not plugin runtime code.
import { Session } from 'node:inspector';
import { createHash } from 'node:crypto';
import { openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { URL as NodeURL } from 'node:url';

if (!process.env.DSH_FETCH_TRACE_FILE) throw new Error('Set DSH_FETCH_TRACE_FILE to a new local JSONL file');
const output = openSync(resolve(process.env.DSH_FETCH_TRACE_FILE), 'wx', 0o600);
const diagnostic = channel('dsh-web-search-fetch:incident');
const digest = value => createHash('sha256').update(value).digest('hex');
const publicInput = value => value === 'https://example.com' || value === 'http://example.com';
const safeUrl = raw => {
  if (typeof raw !== 'string') return { missing: true };
  try {
    const value = new NodeURL(raw);
    const redacted = !!(value.username || value.password || value.search || value.hash);
    value.username = ''; value.password = ''; value.search = ''; value.hash = '';
    return { url: redacted ? value.href : raw, redacted, sha256: digest(raw) };
  } catch { return { invalid: true, sha256: digest(raw) }; }
};
let sequence = 0;
function record(event) {
  const receipt = { eventId: `${process.pid}-${++sequence}`, time: new Date().toISOString(), ...event };
  writeSync(output, JSON.stringify(receipt) + '\n');
  diagnostic.publish(receipt);
}
const inspector = new Session();
inspector.connect(); // In-process only: never opens a debugger network port.
const breakpoints = new Set();
inspector.on('Debugger.scriptParsed', ({ params }) => {
  if (!params.url.includes('dsh-web-search-fetch') || !params.url.endsWith('/lib/engines/additional/adapters.js')) return;
  inspector.post('Debugger.getScriptSource', { scriptId: params.scriptId }, (error, result) => {
    if (error) return;
    const source = result.scriptSource;
    const anchor = 'return fetchResult(url, item.RedirectedUrl ?? item.Url, item.ContentText, item.Title, item.StatusCode);';
    const offset = source.indexOf(anchor);
    if (offset < 0) return;
    const before = source.slice(0, offset);
    inspector.post('Debugger.setBreakpoint', {
      location: { scriptId: params.scriptId, lineNumber: before.split('\n').length - 1, columnNumber: before.length - before.lastIndexOf('\n') - 1 },
    }, (error, result) => {
      if (error) return;
      breakpoints.add(result.breakpointId);
      record({ phase: 'adapter-breakpoint-ready', sourceSHA256: digest(source) });
    });
  });
});
function inspect(frame, expression, consume) {
  inspector.post('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, returnByValue: true }, (error, result) => {
    if (error || result.exceptionDetails || typeof result.result?.value !== 'string') {
      record({ phase: 'capture-error', reason: error ? 'inspector-command-failed' : result.exceptionDetails ? 'evaluation-threw' : 'missing-evaluation-result' });
      return;
    }
    let value;
    try { value = JSON.parse(result.result.value); }
    catch { record({ phase: 'capture-error', reason: 'decoding-failed' }); return; }
    if (publicInput(value?.requestUrl)) consume(value);
  });
}
inspector.on('Debugger.paused', ({ params }) => {
  try {
    if (params.hitBreakpoints?.some(id => breakpoints.has(id))) {
      inspect(params.callFrames[0], 'JSON.stringify({requestUrl:url,originalUrl:item.Url,redirectedUrl:item.RedirectedUrl,status:item.StatusCode,content:item.ContentText,requestId:data.ResponseMetadata?.RequestId,logId:data.Result?.LogId})', value => {
        record({ phase: 'doubao-response', requestUrl: value.requestUrl, originalUrl: safeUrl(value.originalUrl), redirectedUrl: safeUrl(value.redirectedUrl), status: value.status,
          contentChars: typeof value.content === 'string' ? value.content.length : null,
          contentSHA256: typeof value.content === 'string' ? digest(value.content) : null,
          requestId: value.requestId, logId: value.logId });
      });
    } else if (params.data?.description?.includes('没有可整理的目标网页正文')) {
      const frame = params.callFrames.find(frame => frame.functionName === 'organizeDocuments');
      if (frame) inspect(frame, `JSON.stringify({requestUrl:url,requestTarget:target(url),documents:documents.map(doc=>({engineId:doc.candidate.engineId,url:doc.candidate.result.url,target:target(doc.candidate.result.url),status:doc.candidate.result.statusCode,challenge:challenge(doc),successful:successful.includes(doc),compatible:compatible.includes(doc),errorUsable:errors.includes(doc)})),usable:usable.length})`, value => {
        record({ phase: 'organizer-rejection', requestUrl: value.requestUrl, requestTarget: safeUrl(value.requestTarget), usable: value.usable,
          documents: value.documents.map(doc => ({ ...doc, url: safeUrl(doc.url), target: safeUrl(doc.target) })) });
      });
    }
  } finally { inspector.post('Debugger.resume'); }
});
inspector.post('Debugger.enable');
inspector.post('Debugger.setPauseOnExceptions', { state: 'all' });
record({ phase: 'capture-start', scope: 'exact http(s)://example.com inputs only; no headers or response bodies stored' });
