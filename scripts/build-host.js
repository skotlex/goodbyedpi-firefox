#!/usr/bin/env node
'use strict';
// native-host/Host.cs 를 ciadpi.exe 를 내장한 단일 실행 파일로 컴파일해 확장 패키지(src/native)에 넣는다.
// Windows 에 기본 포함된 .NET Framework 컴파일러만 쓰므로 별도 설치가 필요 없다.

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const output  = 'src/native/GoodbyeDPI-Firefox-Setup.exe';
const csc     = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

if (!fs.existsSync(csc)) {
  console.error(`[build-host] 컴파일러를 찾을 수 없습니다: ${csc}`);
  process.exit(1);
}

fs.mkdirSync(path.join(rootDir, path.dirname(output)), { recursive: true });
execFileSync(csc, [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  '/codepage:65001',
  '/reference:System.Web.Extensions.dll',
  '/reference:System.Core.dll',
  '/resource:vendor/byedpi/ciadpi.exe,ciadpi.exe',
  '/resource:vendor/byedpi/LICENSE,LICENSE',
  `/out:${output.replace(/\//g, '\\')}`,
  'native-host\\Host.cs',
], { cwd: rootDir, stdio: 'inherit' });

const size = fs.statSync(path.join(rootDir, output)).size;
console.log(`[build-host] ✓ ${output} (${Math.round(size / 1024)} KiB)`);
