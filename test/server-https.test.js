import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import https from 'node:https';
import tls from 'node:tls';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalServer} from '../server.js';

const canGenerateCertificate = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {stdio:'ignore'}).status === 0;
const certificateScript = String.raw`
$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('localhost')
$san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
$request.CertificateExtensions.Add($san.Build())
$certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddHours(1))
[System.IO.File]::WriteAllText($env:PROMETHEUS_TEST_CERT, $certificate.ExportCertificatePem())
[System.IO.File]::WriteAllText($env:PROMETHEUS_TEST_KEY, $rsa.ExportPkcs8PrivateKeyPem())
$certificate.Dispose()
$rsa.Dispose()
`;

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({hostname:'127.0.0.1', port, path:pathname, rejectUnauthorized:false, ...options}, res => {
      const certificate = res.socket.getPeerCertificate();
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({status:res.statusCode, body, certificate}));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('optional HTTPS serves the API over loopback and accepts only its HTTPS origin', {skip:!canGenerateCertificate && 'PowerShell 7 is needed to create an ephemeral test certificate'}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'prometheus-https-'));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const certPath = join(directory, 'cert.pem'), keyPath = join(directory, 'key.pem');
  execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', certificateScript], {
    env:{...process.env, PROMETHEUS_TEST_CERT:certPath, PROMETHEUS_TEST_KEY:keyPath},
    stdio:'ignore'
  });
  let calls = 0;
  const server = createLocalServer({httpsOptions:{cert:readFileSync(certPath), key:readFileSync(keyPath)}, sam:async()=>{calls++;return {masks:[]};}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const page = await request(port, '/');
    assert.equal(page.status, 200);
    assert.equal(tls.checkServerIdentity('127.0.0.1', page.certificate), undefined, 'certificate includes an IPv4 loopback SAN');
    const body = JSON.stringify({frame:{frameId:'f',observedAt:1},imageDataUrl:'data:image/png;base64,iVBORw0KGgo=',prompt:'cup'});
    const headers = {'content-type':'application/json',origin:`https://127.0.0.1:${port}`};
    assert.equal((await request(port, '/api/sam/segment', {method:'POST',headers,body})).status, 200);
    assert.equal((await request(port, '/api/sam/segment', {method:'POST',headers:{...headers,origin:`http://127.0.0.1:${port}`},body})).status, 403);
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
