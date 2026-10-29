import {providerOperationId} from './provider-journal.js';

// Constructing this adapter requires explicit permission to send frame data to providers.
export function createServerAnalyzer({remoteConsent, samPrompt, journal, sessionId, fetchImpl = fetch} = {}) {
  if (remoteConsent !== true || typeof samPrompt !== 'string' || !samPrompt.trim() || samPrompt.length > 256 || typeof fetchImpl !== 'function' || !journal || typeof sessionId !== 'string') throw new TypeError('remote consent and segmentation prompt required');
  return {kind:'server_provider', async run(input, {signal} = {}) {
    return journal.run(await providerOperationId(sessionId,'analyze',input.frame.frameId),async()=>{
    if(signal?.aborted) throw new Error('operation cancelled');
    const response = await fetchImpl('/api/analyze', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({input,prompt:samPrompt}), signal});
    if (!response.ok) throw new Error('provider request failed');
    const result = await response.json();
    if (result.frame?.frameId !== input.frame.frameId || result.frame?.observedAt !== input.frame.observedAt) throw new Error('frame mismatch');
    return {scenarios:result.scenarios,nextGaze:result.nextGaze ?? null,reasoner:result.reasoner};
    });
  }};
}

// The caller separately obtains scene observations; this route never runs SAM.
export function createServerReasoner({remoteConsent, journal, sessionId, fetchImpl = fetch} = {}) {
  if (remoteConsent !== true || typeof fetchImpl !== 'function' || !journal || typeof sessionId !== 'string') throw new TypeError('remote consent required');
  return {kind:'server_provider', async run(input, {signal} = {}) {
    return journal.run(await providerOperationId(sessionId,'reason',input.frame.frameId),async()=>{
    if(signal?.aborted) throw new Error('operation cancelled');
    const response = await fetchImpl('/api/reason', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input}),signal});
    if (!response.ok) throw new Error('provider request failed');
    const result = await response.json();
    if (result.frame?.frameId !== input.frame.frameId || result.frame?.observedAt !== input.frame.observedAt || !Array.isArray(result.scenarios)) throw new Error('invalid provider response');
    return {scenarios:result.scenarios,nextGaze:result.nextGaze ?? null,reasoner:result.reasoner};
    });
  }};
}
