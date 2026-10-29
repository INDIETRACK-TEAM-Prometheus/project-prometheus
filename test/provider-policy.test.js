import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderPolicy,providerHttpError,providerNetworkError} from '../server/provider-policy.js';

test('shares concurrency, interval, call and cost budgets across providers', async () => {
  let now=1000, finish; const policy=new ProviderPolicy({now:()=>now,minIntervalMs:100,maxCallsPerMinute:2,maxCostPerMinute:0.01});
  const first=policy.run({cost:0.0025},()=>new Promise(resolve=>{finish=resolve;}));
  await assert.rejects(policy.run({cost:0.0025},async()=>{}),{code:'PROVIDER_BUSY'}); finish('ok'); await first;
  await assert.rejects(policy.run({cost:0.0025},async()=>{}),{code:'PROVIDER_MIN_INTERVAL'});
  now+=100; await policy.run({cost:0.0075},async()=>{});
  now+=100; await assert.rejects(policy.run({cost:0.001},async()=>{}),{code:'PROVIDER_BUDGET_EXCEEDED'});
  now+=60000; await policy.run({cost:0.01},async()=>{});
});
test('rate limit and offline failure open exponential breaker without retry', async () => {
  let now=1000, calls=0; const policy=new ProviderPolicy({now:()=>now,minIntervalMs:0,backoffBaseMs:1000});
  const request=async()=>{calls++;throw providerHttpError(429);};
  await assert.rejects(policy.run({cost:0.001},request),{code:'PROVIDER_RATE_LIMITED'});
  await assert.rejects(policy.run({cost:0.001},request),{code:'PROVIDER_CIRCUIT_OPEN'}); assert.equal(calls,1);
  now+=1000; await assert.rejects(policy.run({cost:0.001},async()=>{calls++;throw providerNetworkError();}),{code:'PROVIDER_NETWORK_ERROR'});
  now+=1999; await assert.rejects(policy.run({cost:0.001},request),{code:'PROVIDER_CIRCUIT_OPEN'});
  now++; await policy.run({cost:0.001},async()=>{calls++;}); assert.equal(calls,3); assert.equal(policy.failures,0);
});
test('cancellation does not dispatch or poison the breaker', async () => {
  const policy=new ProviderPolicy({minIntervalMs:0}); const controller=new AbortController(); controller.abort();
  await assert.rejects(policy.run({cost:0.001,signal:controller.signal},async()=>{throw Error('should not run');}),{code:'PROVIDER_CANCELLED'});
  assert.equal(policy.calls.length,0); assert.equal(policy.failures,0);
});
test('cancelled in-flight failure releases slot without opening circuit', async () => {
  let now=1000, rejectWork; const policy=new ProviderPolicy({now:()=>now,minIntervalMs:0}); const controller=new AbortController();
  const request=policy.run({cost:0.001,signal:controller.signal},()=>new Promise((resolve,reject)=>{rejectWork=reject;}));
  controller.abort(); rejectWork(providerNetworkError()); await assert.rejects(request,{code:'PROVIDER_NETWORK_ERROR'});
  assert.equal(policy.inFlight,0); assert.equal(policy.failures,0); await policy.run({cost:0.001},async()=>{});
});
test('cost ceiling independently blocks additional calls', async () => {
  const policy=new ProviderPolicy({minIntervalMs:0,maxCostPerMinute:0.005});
  await policy.run({cost:0.005},async()=>{});
  await assert.rejects(policy.run({cost:0.001},async()=>{}),{code:'PROVIDER_BUDGET_EXCEEDED'});
});
