// src/index.js  (Phase 2)
// Express-free HTTP 서버.
//   /health         → Railway 헬스체크
//   /api/*          → Phase 2 REST API (JWT 인증)
//   /               → 관리 대시보드 (HTML)

import 'dotenv/config'
import { createServer }      from 'http'
import { handleApiRequest }  from './api/router.js'
import { logger }            from './utils/logger.js'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT ?? 3000

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

async function serveStaticFile(req, res, reqPath) {
  try {
    if (reqPath === '/') reqPath = '/index.html'
    
    // Path traversal protection
    const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '')
    const filePath = path.join(__dirname, '../public', safePath)
    
    const stat = await fs.stat(filePath)
    if (stat.isFile()) {
      const ext = path.extname(filePath)
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain' })
      const data = await fs.readFile(filePath)
      return res.end(data)
    }
  } catch (err) {
    // If not found, ignore to return 404 below
  }
  
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
}

// Content Security Policy.
// 'unsafe-inline'은 대시보드의 인라인 핸들러/스타일 때문에 유지하되,
// 'unsafe-eval'은 사용처가 없어 제거(XSS 방어 강화). 리소스 타입별로 분리.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",   // /api(self) + Supabase Auth/REST(https)
  "media-src 'self' https: blob:", // Supabase signed audio URL
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')

// 허용 Origin 화이트리스트. 미설정 시 '*'로 현행 동작 유지(하위호환).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)

function addSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Content-Security-Policy', CSP)

  // CORS — 화이트리스트가 있으면 매칭 Origin만 허용, 없으면 '*'(현행)
  const origin = req.headers.origin
  if (ALLOWED_ORIGINS.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*')
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

const server = createServer(async (req, res) => {
  addSecurityHeaders(req, res)
  
  // Preflight requests for CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  const pathName = new URL(req.url, 'http://localhost').pathname

  if (pathName === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }))
  }

  if (pathName.startsWith('/api/')) return handleApiRequest(req, res)

  // 그 외 → public/ 정적 파일 서빙
  return serveStaticFile(req, res, pathName)
})

server.listen(PORT, () => {
  logger.info(`[server] Morning Briefing running on port ${PORT}`)
  logger.info(`[server] Dashboard → http://localhost:${PORT}`)
})
